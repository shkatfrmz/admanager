const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns');
const db = require('../db/database');

const WORK_DIR = path.join(os.tmpdir(), 'ad-manager-choco');
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

/**
 * Execute Chocolatey package deployment via WinRM push.
 * @param {Object} opts
 * @param {string} opts.packageName e.g. '7zip'
 * @param {string} [opts.packageVersion]
 * @param {string} [opts.source] choco source, default '' (public)
 * @param {string} [opts.chocoArgs]
 * @param {string[]} opts.hostnames
 * @param {string} [opts.username] optional explicit creds
 * @param {string} [opts.password]
 * @param {string} [opts.auth='Negotiate']
 * @param {boolean} [opts.useHttps=false]
 * @param {string} [opts.createdBy='admin']
 */
async function deploy(opts) {
  const { packageName, packageVersion, source, chocoArgs, hostnames, username, password, auth = 'Negotiate', useHttps = false, createdBy = 'admin' } = opts;
  if (!packageName) throw new Error('package_name is required');
  if (!hostnames || !Array.isArray(hostnames) || hostnames.length === 0) throw new Error('hostnames[] is required');

  const port = useHttps ? 5986 : 5985;
  const useSSL = useHttps ? '$true' : '$false';

  const jobs = hostnames.map(async (hostname) => {
    const ip = await resolveHostname(hostname).catch(() => null);
    const hostList = hostnames.join(',');
    const row = db.prepare(`INSERT INTO choco_deployments (package_name, package_version, source, choco_args, hostnames, status, created_by) VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
      .run(packageName, packageVersion || null, source || null, chocoArgs || null, hostList, createdBy);
    const deploymentId = row.lastInsertRowid;

    runChocoJob(deploymentId, hostname, ip, packageName, packageVersion, source, chocoArgs, username, password, auth, port, useSSL).catch(err => {
      console.error(`[choco] ${hostname} fatal:`, err.message);
    });

    return { deploymentId, hostname, status: 'pending' };
  });

  return Promise.all(jobs);
}

async function runChocoJob(deploymentId, hostname, ip, packageName, packageVersion, source, chocoArgs, username, password, auth, port, useSSL) {
  const runId = crypto.randomBytes(8).toString('hex');
  const sessionDir = path.join(WORK_DIR, runId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const resultFile = path.join(sessionDir, 'result.json');

  const escapedPackage = packageName.replace(/'/g, "''");
  const escapedVersion = (packageVersion || '').replace(/'/g, "''");
  const escapedSource = (source || '').replace(/'/g, "''");
  const escapedArgs = (chocoArgs || '').replace(/'/g, "''");
  const escapedHostname = hostname.replace(/'/g, "''");
  const escapedUsername = (username || '').replace(/'/g, "''");
  const escapedPassword = (password || '').replace(/'/g, "''");

  const hasCreds = username && password;
  const credentialLine = hasCreds
    ? `$sec = ConvertTo-SecureString '${escapedPassword}' -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential('${escapedUsername}', $sec)`
    : `# Use current Windows identity`;
  const sessionLine = hasCreds
    ? `$session = New-PSSession -ComputerName '${escapedHostname}' -Credential $cred -Authentication ${auth} -Port ${port} -UseSSL:${useSSL} -SessionOption $so`
    : `$session = New-PSSession -ComputerName '${escapedHostname}' -Port ${port} -UseSSL:${useSSL} -SessionOption $so`;

  const versionArg = escapedVersion ? `--version '${escapedVersion}'` : '';
  const sourceArg = escapedSource ? `--source '${escapedSource}'` : '';
  const extraArgs = escapedArgs ? escapedArgs : '';

  const deployScript = `
$ErrorActionPreference = 'Stop'
try {
  ${credentialLine}
  $so = New-PSSessionOption -SkipCACheck -SkipCNCheck
  ${sessionLine}
  $result = Invoke-Command -Session $session -ScriptBlock {
    $installOutput = & choco.exe install '${escapedPackage}' -y --no-progress --force ${versionArg} ${sourceArg} ${extraArgs} 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    # Get installed Chocolatey packages for inventory
    $inventory = & choco.exe list --local-only --limit-output 2>&1 | Out-String
    @{ exitCode = $exitCode; output = $installOutput; inventory = $inventory }
  }
  Remove-PSSession $session
  $result | ConvertTo-Json -Compress -Depth 3 | Out-File -FilePath '${resultFile.replace(/'/g, "''")}' -Encoding utf8
} catch {
  @{ exitCode = 1; output = ''; error = $_.Exception.Message } | ConvertTo-Json -Compress | Out-File -FilePath '${resultFile.replace(/'/g, "''")}' -Encoding utf8
  throw
}
`;

  try {
    db.prepare("UPDATE choco_deployments SET status='in_progress', started_at=datetime('now'), attempt_count=attempt_count+1 WHERE id=?").run(deploymentId);
    await runPowerShell(deployScript, 600000);

    let result = { exitCode: 1, output: '', error: 'No result captured' };
    if (fs.existsSync(resultFile)) {
      const rawResult = fs.readFileSync(resultFile, 'utf8').trim();
      const clean = rawResult.replace(/^\?/, '').trim();
      try { result = JSON.parse(clean); } catch (e) { result.error = 'Result parse error: ' + e.message; result.raw = rawResult; }
    } else {
      result.error = 'Result file not found: ' + resultFile;
    }

    const success = result && (result.exitCode === 0 || result.exitCode === '0');
    db.prepare(`UPDATE choco_deployments SET status=?, output_log=?, completed_at=datetime('now') WHERE id=?`)
      .run(success ? 'success' : 'failed', JSON.stringify(result), deploymentId);
  } catch (err) {
    db.prepare("UPDATE choco_deployments SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?")
      .run(err.message, deploymentId);
  } finally {
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) { console.error('[choco] cleanup failed:', e.message); }
  }
}

function runPowerShell(script, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script];
    const ps = spawn('powershell.exe', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { ps.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { ps.kill('SIGKILL'); } catch (_) {} }, 5000);
    }, timeoutMs);
    ps.stdout.on('data', d => stdout += d.toString());
    ps.stderr.on('data', d => stderr += d.toString());
    ps.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !killed) {
        const err = new Error(stderr || stdout || `PowerShell exited with ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
    ps.on('error', reject);
  });
}

function resolveHostname(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, (err, address) => err ? reject(err) : resolve(address));
  });
}

function listChocoDeployments(status, packageName) {
  let query = 'SELECT * FROM choco_deployments';
  const params = [];
  const wheres = [];
  if (status) { wheres.push('status = ?'); params.push(status); }
  if (packageName) { wheres.push('package_name LIKE ?'); params.push(`%${packageName}%`); }
  if (wheres.length) query += ' WHERE ' + wheres.join(' AND ');
  query += ' ORDER BY created_at DESC LIMIT 200';
  return db.prepare(query).all(...params);
}

function getChocoDeployment(id) {
  return db.prepare('SELECT * FROM choco_deployments WHERE id = ?').get(id);
}

module.exports = { deploy, listChocoDeployments, getChocoDeployment };
