const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const db = require('../db/database');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'packages');
const CHOCO_DIR = path.join(__dirname, '..', 'uploads', 'choco-packages');
if (!fs.existsSync(CHOCO_DIR)) fs.mkdirSync(CHOCO_DIR, { recursive: true });

function sanitizeId(id) {
  return id.toLowerCase().replace(/[^a-z0-9_.-]/g, '').replace(/^[_.-]+/, '').replace(/[_.-]+$/, '');
}

function ensureChocolateyNupkg() {
  const cacheFile = path.join(CHOCO_DIR, 'chocolatey.nupkg');
  if (fs.existsSync(cacheFile)) return cacheFile;
  // If not cached, deployment script will try to install from web; but we prefer to have it.
  // In a real air-gapped env, admin places chocolatey.nupkg here manually.
  return null;
}

async function buildPackage(opts) {
  const { fileId, packageId, name, version, description, installArgs } = opts;
  const file = db.prepare('SELECT * FROM deployment_files WHERE id = ?').get(fileId);
  if (!file) throw new Error('Deployment file not found');
  const sourceFile = path.join(UPLOAD_DIR, file.stored_path);
  if (!fs.existsSync(sourceFile)) throw new Error('Source installer file missing on disk');

  const safeId = sanitizeId(packageId || file.name);
  const safeVersion = (version || '1.0.0').replace(/[^0-9.]/g, '');
  const pkgDir = path.join(CHOCO_DIR, `${safeId}-${safeVersion}-${crypto.randomBytes(4).toString('hex')}`);
  const toolsDir = path.join(pkgDir, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });

  const installerDest = path.join(toolsDir, file.original_name);
  fs.copyFileSync(sourceFile, installerDest);

  const ext = path.extname(file.original_name).toLowerCase();
  const args = installArgs || file.install_args || defaultArgs(ext);
  const installScript = buildInstallScript(ext, file.original_name, args);
  const uninstallScript = buildUninstallScript(ext, file.original_name);

  fs.writeFileSync(path.join(toolsDir, 'chocolateyinstall.ps1'), installScript, 'utf8');
  fs.writeFileSync(path.join(toolsDir, 'chocolateyuninstall.ps1'), uninstallScript, 'utf8');

  const nuspec = buildNuspec(safeId, name || file.name, safeVersion, description || file.description);
  fs.writeFileSync(path.join(pkgDir, `${safeId}.nuspec`), nuspec, 'utf8');

  const nupkgPath = path.join(CHOCO_DIR, `${safeId}.${safeVersion}.nupkg`);
  await zipDirectory(pkgDir, nupkgPath);

  // Cleanup temp build dir
  try { fs.rmSync(pkgDir, { recursive: true, force: true }); } catch (_) {}

  const existing = db.prepare('SELECT id FROM choco_packages WHERE package_id = ?').get(safeId);
  if (existing) {
    db.prepare(`UPDATE choco_packages SET name=?, version=?, description=?, file_id=?, install_script=?, nupkg_path=?, status='built', built_at=datetime('now') WHERE package_id=?`)
      .run(name || file.name, safeVersion, description || file.description || null, fileId, installScript, nupkgPath, safeId);
  } else {
    db.prepare(`INSERT INTO choco_packages (package_id, name, version, description, file_id, install_script, nupkg_path, status, built_at) VALUES (?,?,?,?,?,?,?,'built',datetime('now'))`)
      .run(safeId, name || file.name, safeVersion, description || file.description || null, fileId, installScript, nupkgPath);
  }

  return { package_id: safeId, version: safeVersion, nupkg_path: nupkgPath };
}

function defaultArgs(ext) {
  if (ext === '.msi') return '/qn /norestart';
  if (ext === '.exe') return '/S';
  return '';
}

function buildInstallScript(ext, originalName, args) {
  const installerPath = `$toolsDir\\${originalName.replace(/'/g, "''")}`;
  if (ext === '.msi') {
    return `
$ErrorActionPreference = 'Stop'
$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$installer = "${installerPath}"
$log = "$env:TEMP\\choco-install.log"
$args = @('/i', $installer, ${JSON.stringify(args)}, '/l*v', $log)
Start-Process -FilePath "msiexec.exe" -ArgumentList $args -Wait -NoNewWindow
`;
  }
  return `
$ErrorActionPreference = 'Stop'
$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$installer = "${installerPath}"
$args = @(${JSON.stringify(args)})
Start-Process -FilePath $installer -ArgumentList $args -Wait -NoNewWindow
`;
}

function buildUninstallScript(ext, originalName) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
Write-Host "Uninstall script placeholder for ${originalName.replace(/'/g, "''")}"
`;
}

function buildNuspec(id, title, version, description) {
  const safeTitle = (title || id).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeDesc = (description || `Internal package for ${title || id}`).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2015/06/nuspec.xsd">
  <metadata>
    <id>${id}</id>
    <version>${version}</version>
    <title>${safeTitle}</title>
    <authors>AD Manager</authors>
    <description>${safeDesc}</description>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
  </metadata>
  <files>
    <file src="tools\\**" target="tools" />
  </files>
</package>`;
}

function zipDirectory(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    try {
      const zip = new AdmZip();
      zip.addLocalFolder(sourceDir);
      zip.writeZip(outPath);
      resolve(outPath);
    } catch (e) { reject(e); }
  });
}

function listPackages() {
  return db.prepare('SELECT * FROM choco_packages ORDER BY built_at DESC').all();
}

function getPackage(packageId) {
  return db.prepare('SELECT * FROM choco_packages WHERE package_id = ?').get(packageId);
}

function getPackagePath(packageId) {
  const pkg = getPackage(packageId);
  return pkg ? pkg.nupkg_path : null;
}

module.exports = { buildPackage, listPackages, getPackage, getPackagePath, ensureChocolateyNupkg, CHOCO_DIR };
