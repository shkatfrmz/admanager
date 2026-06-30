const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns');
const db = require('../db/database');
const chocoPackageService = require('./choco-package.service');

const WORK_DIR = path.join(os.tmpdir(), 'ad-manager-choco');
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

/**
 * Execute Chocolatey package deployment via WinRM push.
 * Supports both public package names and internal .nupkg packages.
 */
async function deploy(opts) {
  const { packageName, packageVersion, source, chocoArgs, hostnames, username, password, auth = 'Negotiate', useHttps = false, createdBy = 'admin' } = opts;
  if (!packageName) throw new Error('package_name is required');
  if (!hostnames || !Array.isArray(hostnames) || hostnames.length === 0) throw new Error('hostnames[] is required');

  const port = useHttps ? 5986 : 5985;
  const useSSL = useHttps ? '$true' : '$false';

  // Detect internal package
  const internalPkg = chocoPackageService.getPackage(packageName);
  const isInternal = !!internalPkg;
  const nupkgPath = internalPkg ? internalPkg.nupkg_path : null;

  const jobs = hostnames.map(async (hostname) => {
    const ip = await resolveHostname(hostname).catch(() => null);
    const hostList = hostnames.join(',');
    const row = db.prepare(`INSERT INTO choco_deployments (package_name, package_version, source, choco_args, hostnames, status, created_by) VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
      .run(packageName, packageVersion || null, source || (isInternal ? 'INTERNAL' : null), chocoArgs || null, hostList, createdBy);
    const deploymentId = row.lastInsertRowid;

    runChocoJob(deploymentId, hostname, ip, packageName, packageVersion, source, chocoArgs, username, password, auth, port, useSSL, isInternal, nupkgPath).catch(err => {
      console.error(`[choco] ${hostname} fatal:`, err.message);
    });

    return { deploymentId, hostname, status: 'pending' };
  });

  return Promise.all(jobs);
}

async function runChocoJob(deploymentId, hostname, ip, packageName, packageVersion, source, chocoArgs, username, password, auth, port, useSSL, isInternal, nupkgPath) {
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

  let remoteScript = '';
  if (isInternal && nupkgPath) {
    const remoteTemp = `C:\\Windows\\Temp\\admgr-choco-${runId}`;
    const remoteNupkg = `${remoteTemp}\\${path.basename(nupkgPath)}`;
    const escapedLocalPath = nupkgPath.replace(/'/g, "''");
    const escapedRemoteNupkg = remoteNupkg.replace(/'/g, "''");
    const escapedRemoteTemp = remoteTemp.replace(/'/g, "''");
    remoteScript = `
    $result = Invoke-Command -Session $session -ScriptBlock {
      New-Item -Path '${escapedRemoteTemp}' -ItemType Directory -Force | Out-Null
    }
    Copy-Item -Path '${escapedLocalPath}' -Destination '${escapedRemoteNupkg}' -ToSession $session -Force
    $result = Invoke-Command -Session $session -ScriptBlock {
      $nupkg = '${escapedRemoteNupkg}'
      $feed = '${escapedRemoteTemp}'
      $chocoPath = Get-Command choco.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
      if (-not $chocoPath) { $chocoPath = 'C:\\ProgramData\\chocolatey\\bin\\choco.exe' }
      if (Test-Path $chocoPath) {
        $choco = $chocoPath
        $installOutput = & $choco install '${escapedPackage}' -y --no-progress --force --source $feed ${escapedArgs ? ' ' + escapedArgs : ''} 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
        $inventory = & $choco list --local-only --limit-output 2>&1 | Out-String
        @{ exitCode = $exitCode; output = $installOutput; inventory = $inventory }
      } else {
        # Chocolatey not installed on target — extract .nupkg and run embedded install script inline
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($nupkg, $feed)
        $installScript = Join-Path $feed 'tools\\chocolateyinstall.ps1'
        $installOutput = Invoke-Expression (Get-Content -Path $installScript -Raw) 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
        @{ exitCode = $exitCode; output = $installOutput; inventory = '' }
      }
    }
    Remove-PSSession $session
    $result | ConvertTo-Json -Compress -Depth 3 | Out-File -FilePath '${resultFile.replace(/'/g, "''")}' -Encoding utf8`;
  } else {
    const versionArg = escapedVersion ? `--version '${escapedVersion}'` : '';
    const sourceArg = escapedSource ? `--source '${escapedSource}'` : '';
    const extraArgs = escapedArgs ? escapedArgs : '';
    remoteScript = `
    $result = Invoke-Command -Session $session -ScriptBlock {
      $chocoPath = Get-Command choco.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
      if (-not $chocoPath) { $chocoPath = 'C:\\ProgramData\\chocolatey\\bin\\choco.exe' }
      $choco = if (Test-Path $chocoPath) { $chocoPath } else { 'choco.exe' }
      $installOutput = & $choco install '${escapedPackage}' -y --no-progress --force ${versionArg} ${sourceArg} ${extraArgs} 2>&1 | Out-String
      $exitCode = $LASTEXITCODE
      $inventory = ''
      if (Test-Path $chocoPath) { $inventory = & $choco list --local-only --limit-output 2>&1 | Out-String }
      @{ exitCode = $exitCode; output = $installOutput; inventory = $inventory }
    }
    Remove-PSSession $session
    $result | ConvertTo-Json -Compress -Depth 3 | Out-File -FilePath '${resultFile.replace(/'/g, "''")}' -Encoding utf8`;
  }

  const deployScript = `
$ErrorActionPreference = 'Stop'
try {
  ${credentialLine}
  $so = New-PSSessionOption -SkipCACheck -SkipCNCheck
  ${sessionLine}
${remoteScript}
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
