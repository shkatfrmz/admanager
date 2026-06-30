const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns');
const db = require('../db/database');

// Shared upload directory must match routes/endpoints.js
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'packages');
const WORK_DIR = path.join(os.tmpdir(), 'ad-manager-winrm');
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

/**
 * Execute a WinRM push deployment to one or more hosts.
 * Credentials are passed per-request and never persisted.
 *
 * @param {Object} opts
 * @param {number} opts.fileId deployment_files.id
 * @param {string[]} opts.hostnames
 * @param {string} opts.username format: user@domain or DOMAIN\user
 * @param {string} opts.password
 * @param {string} [opts.auth='Negotiate'] Negotiate | Kerberos | CredSSP
 * @param {boolean} [opts.useHttps=false]
 * @param {string} [opts.createdBy='admin']
 */
async function deploy(opts) {
  const { fileId, hostnames, username, password, auth = 'Negotiate', useHttps = false, createdBy = 'admin' } = opts;
  const file = db.prepare('SELECT * FROM deployment_files WHERE id = ?').get(fileId);
  if (!file) throw new Error('Deployment file not found');
  const localFilePath = path.join(UPLOAD_DIR, file.stored_path);
  if (!fs.existsSync(localFilePath)) throw new Error('Deployment file missing on disk');

  const port = useHttps ? 5986 : 5985;
  const useSSL = useHttps ? '$true' : '$false';

  const jobs = hostnames.map(async (hostname) => {
    const ip = await resolveHostname(hostname).catch(() => null);
    const row = db.prepare(`INSERT INTO winrm_deployments (file_id, hostname, ip_address, status, created_by) VALUES (?, ?, ?, 'pending', ?)`)
      .run(fileId, hostname, ip, createdBy);
    const deploymentId = row.lastInsertRowid;

    // Fire and forget so the API responds immediately; UI can poll status
    runWinRMJob(deploymentId, hostname, ip, localFilePath, file.original_name, username, password, auth, port, useSSL).catch(err => {
      console.error(`[winrm] ${hostname} fatal:`, err.message);
    });

    return { deploymentId, hostname, status: 'pending' };
  });

  return Promise.all(jobs);
}

async function runWinRMJob(deploymentId, hostname, ip, localFilePath, originalName, username, password, auth, port, useSSL) {
  const runId = crypto.randomBytes(8).toString('hex');
  const sessionDir = path.join(WORK_DIR, runId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const resultFile = path.join(sessionDir, 'result.json');

  const escapedLocalPath = localFilePath.replace(/'/g, "''");
  const escapedOriginalName = originalName.replace(/'/g, "''");
  const escapedHostname = hostname.replace(/'/g, "''");
  const hasCreds = username && password;
  const escapedUsername = hasCreds ? username.replace(/'/g, "''") : '';
  const escapedPassword = hasCreds ? password.replace(/'/g, "''") : '';

  const remoteTemp = `C:\\Windows\\Temp\\admgr-${runId}`;
  const remoteResultFile = `${remoteTemp}\\admgr-result.json`;
  const ext = path.extname(originalName).toLowerCase();
  const installerLogic = buildInstallerCommand(ext, `$remotePath`, originalName);

  // Single PowerShell invocation: build credential in-memory, deploy, copy result back.
  const credentialLine = hasCreds
    ? `$sec = ConvertTo-SecureString '${escapedPassword}' -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential('${escapedUsername}', $sec)`
    : `# No explicit credentials supplied; use current Windows identity (Kerberos/Negotiate)`;
  const sessionLine = hasCreds
    ? `$session = New-PSSession -ComputerName '${escapedHostname}' -Credential $cred -Authentication ${auth} -Port ${port} -UseSSL:${useSSL} -SessionOption $so`
    : `$session = New-PSSession -ComputerName '${escapedHostname}' -Port ${port} -UseSSL:${useSSL} -SessionOption $so`;

  const deployScript = `
$ErrorActionPreference = 'Stop'
try {
  ${credentialLine}
  $so = New-PSSessionOption -SkipCACheck -SkipCNCheck
  ${sessionLine}
  $remoteTemp = '${remoteTemp.replace(/'/g, "''")}'
  $remotePath = $remoteTemp + '\\${escapedOriginalName}'
  $remoteResult = '${remoteResultFile.replace(/'/g, "''")}'
  Invoke-Command -Session $session -ScriptBlock {
      New-Item -Path $using:remoteTemp -ItemType Directory -Force | Out-Null
  }
  Copy-Item -Path '${escapedLocalPath}' -Destination $remotePath -ToSession $session -Force
  $resultJson = Invoke-Command -Session $session -ScriptBlock {
      $remotePath = $using:remotePath
      $remoteResult = $using:remoteResult
      ${installerLogic}
      $result | ConvertTo-Json -Compress -Depth 3 | Out-File -FilePath $remoteResult -Encoding utf8
      Get-Content -Path $remoteResult -Raw
  }
  Remove-PSSession $session
  $resultJson | Out-File -FilePath '${resultFile.replace(/'/g, "''")}' -Encoding utf8
  @{ success = $true; error = $null } | ConvertTo-Json -Compress | Out-File -FilePath '${resultFile.replace(/'/g, "''") + '.ok'}' -Encoding utf8
} catch {
  @{ success = $false; error = $_.Exception.Message; stack = $_.ScriptStackTrace } | ConvertTo-Json -Compress | Out-File -FilePath '${resultFile.replace(/'/g, "''") + '.ok'}' -Encoding utf8
  throw
}
`;

  try {
    db.prepare("UPDATE winrm_deployments SET status='in_progress', started_at=datetime('now'), attempt_count=attempt_count+1 WHERE id=?").run(deploymentId);
    await runPowerShell(deployScript);

    let result = { exitCode: 1, output: '', error: 'No result captured' };
    let rawResult = '';
    if (fs.existsSync(resultFile)) {
      rawResult = fs.readFileSync(resultFile, 'utf8').trim();
      // PowerShell serialization may prefix the JSON with a type marker; strip it
      const clean = rawResult.replace(/^\?/, '').trim();
      try { result = JSON.parse(clean); } catch (e) { result.error = 'Result parse error: ' + e.message; result.raw = rawResult; }
    } else {
      result.error = 'Result file not found: ' + resultFile;
    }

    const success = result && (result.exitCode === 0 || result.exitCode === '0' || result.exitCode === 3010 || result.exitCode === '3010');
    db.prepare(`UPDATE winrm_deployments SET status=?, output_log=?, completed_at=datetime('now') WHERE id=?`)
      .run(success ? 'success' : 'failed', JSON.stringify(result), deploymentId);
  } catch (err) {
    db.prepare("UPDATE winrm_deployments SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?")
      .run(err.message, deploymentId);
  } finally {
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) { console.error('[winrm] cleanup failed:', e.message); }
  }
}

function buildInstallerCommand(ext, remotePathVar, originalName) {
  const rp = remotePathVar; // $remotePath
  if (ext === '.msi') {
    return `
    $result = @{ exitCode = 0; output = ''; log = '' }
    $result.output = & msiexec.exe /i "${rp}" /qn /norestart /l*v "C:\\Windows\\Temp\\admgr-install.log" 2>&1 | Out-String
    $result.exitCode = $LASTEXITCODE
    $result.log = (Get-Content -Path 'C:\\Windows\\Temp\\admgr-install.log' -Raw -ErrorAction SilentlyContinue)`;
  }
  if (ext === '.exe') {
    return `
    $result = @{ exitCode = 0; output = ''; log = '' }
    $args = '/S', '/VERYSILENT', '/NORESTART', '/SP-', '/SUPPRESSMSGBOXES', '/LOG="C:\\Windows\\Temp\\admgr-install.log"'
    $proc = Start-Process -FilePath "${rp}" -ArgumentList $args -Wait -PassThru -NoNewWindow
    $result.exitCode = $proc.ExitCode
    $result.output = 'EXE installer executed'
    $result.log = (Get-Content -Path 'C:\\Windows\\Temp\\admgr-install.log' -Raw -ErrorAction SilentlyContinue)`;
  }
  if (ext === '.ps1') {
    return `
    $result = @{ exitCode = 0; output = '' }
    $result.output = & powershell.exe -ExecutionPolicy Bypass -File "${rp}" 2>&1 | Out-String
    $result.exitCode = $LASTEXITCODE`;
  }
  if (ext === '.msu' || ext === '.msp') {
    return `
    $result = @{ exitCode = 0; output = '' }
    $result.output = & wusa.exe "${rp}" /quiet /norestart 2>&1 | Out-String
    $result.exitCode = $LASTEXITCODE`;
  }
  // Fallback: just copy and report
  return `
    $result = @{ exitCode = 0; output = "File copied to ${rp}. Unknown extension; no install command configured." }`;
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script];
    const ps = spawn('powershell.exe', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    ps.stdout.on('data', d => stdout += d.toString());
    ps.stderr.on('data', d => stderr += d.toString());
    ps.on('close', code => {
      if (code !== 0) {
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

/**
 * Add target hostnames to WinRM TrustedHosts for HTTP/Negotiate lab use.
 * Requires local admin rights. Returns the command output.
 */
async function addTrustedHosts(hostnames) {
  const list = Array.isArray(hostnames) ? hostnames : [hostnames];
  const current = (await runPowerShell("Get-Item WSMan:\\localhost\\Client\\TrustedHosts -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Value")).trim();
  const existing = current ? current.split(',').map(s => s.trim()).filter(Boolean) : [];
  const toAdd = list.filter(h => !existing.includes(h));
  if (!toAdd.length) return { alreadyTrusted: list, changed: false };
  const newList = [...existing, ...toAdd].join(',');
  const script = `Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value '${newList.replace(/'/g, "''")}' -Force`;
  await runPowerShell(script);
  return { added: toAdd, alreadyTrusted: existing, changed: true };
}

function listWinRMDeployments(status, hostname) {
  let query = 'SELECT * FROM winrm_deployments';
  const params = [];
  const wheres = [];
  if (status) { wheres.push('status = ?'); params.push(status); }
  if (hostname) { wheres.push('hostname LIKE ?'); params.push(`%${hostname}%`); }
  if (wheres.length) query += ' WHERE ' + wheres.join(' AND ');
  query += ' ORDER BY created_at DESC LIMIT 200';
  return db.prepare(query).all(...params);
}

function getWinRMDeployment(id) {
  return db.prepare('SELECT * FROM winrm_deployments WHERE id = ?').get(id);
}

module.exports = { deploy, addTrustedHosts, listWinRMDeployments, getWinRMDeployment };
