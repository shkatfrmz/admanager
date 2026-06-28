<#
.SYNOPSIS
  Professional installer for AD Manager Agent - adds Programs and Features entry,
  system tray app, and SYSTEM-level scheduled task.
#>

param(
  [string]$ServerUrl = "http://172.18.228.89:3000",
  [switch]$Silent = $false,
  [switch]$Uninstall = $false
)

$ProductName = "AD Manager Agent"
$Publisher = "AD Manager"
$Version = "1.0.0"
$AppDir = "$env:ProgramFiles\ADManager\Agent"
$DataDir = "$env:ProgramData\ADManagerAgent"
$ScriptRoot = $PSScriptRoot
$TrayExe = "$AppDir\ADManagerTray.exe"
$UninstallKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ADManagerAgent"

function Write-Status {
  param([string]$Msg, [string]$Color = "White")
  if (-not $Silent) { Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $Msg) -ForegroundColor $Color }
}

# ═══════════════════════════════════════════════════════════════════════════
# UNINSTALL
# ═══════════════════════════════════════════════════════════════════════════
if ($Uninstall) {
  Write-Status "Uninstalling $ProductName..." -Color Yellow
  # Stop and remove scheduled task
  try { Stop-ScheduledTask -TaskName "ADManagerAgent" -ErrorAction SilentlyContinue } catch {}
  try { Unregister-ScheduledTask -TaskName "ADManagerAgent" -Confirm:$false -ErrorAction SilentlyContinue } catch {}
  # Remove startup shortcut
  $startupPath = [Environment]::GetFolderPath("Startup")
  $lnk = "$startupPath\AD Manager Agent.lnk"
  if (Test-Path $lnk) { Remove-Item $lnk -Force }
  # Kill tray app
  try { Get-Process -Name "ADManagerTray" -ErrorAction SilentlyContinue | Stop-Process -Force } catch {}
  # Remove registry key
  if (Test-Path $UninstallKey) { Remove-Item $UninstallKey -Recurse -Force }
  # Remove files
  if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
  Write-Status "Uninstall complete." -Color Green
  return
}

# ═══════════════════════════════════════════════════════════════════════════
# CHECK ADMIN RIGHTS
# ═══════════════════════════════════════════════════════════════════════════
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Status "Not running as admin. Elevating silently via SYSTEM scheduled task..." -Color Yellow
  # Write the install script to a temp location
  $tmpScript = "$env:TEMP\admanager-install.ps1"
  $installArgs = "-NoProfile -File `"$PSCommandPath`" -ServerUrl `"$ServerUrl`" -Silent"
  # Create a temporary scheduled task running as SYSTEM (no UAC prompt ever)
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $installArgs
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(5) -RepetitionDuration ([TimeSpan]::FromMinutes(5))
  $settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  try {
    Register-ScheduledTask -TaskName "ADManagerAgentSetup" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName "ADManagerAgentSetup" -ErrorAction SilentlyContinue
    Write-Status "Elevation task started. Waiting up to 60 seconds for completion..." -Color Yellow
    $done = $false
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Seconds 1
      $task = Get-ScheduledTask -TaskName "ADManagerAgentSetup" -ErrorAction SilentlyContinue
      if (-not $task -or $task.State -eq 'Ready') { $done = $true; break }
    }
    try { Unregister-ScheduledTask -TaskName "ADManagerAgentSetup" -Confirm:$false -ErrorAction SilentlyContinue } catch {}
    if (-not $done) { Write-Status "Warning: Timed out waiting for elevation task." -Color Yellow }
  } catch {
    Write-Status "ERROR: Could not create SYSTEM scheduled task for elevation." -Color Red
    Write-Status "Run this installer as Administrator once, or use remote-install.ps1 for remote machines." -Color Red
    exit 1
  }
  exit
}

# ═══════════════════════════════════════════════════════════════════════════
# INSTALL
# ═══════════════════════════════════════════════════════════════════════════

Write-Status "=== Installing $ProductName v$Version ===" -Color Cyan
Write-Status "Target: $AppDir" -Color Cyan

# 1. Create directories
if (-not (Test-Path $AppDir)) { New-Item -ItemType Directory -Path $AppDir -Force | Out-Null }
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }

# 2. Copy files
$srcFiles = @("ADManagerTray.exe", "admanager-icon.ico", "ad-manager-agent.ps1", "run-agent.ps1", "install-agent.ps1")
foreach ($f in $srcFiles) {
  $src = Join-Path $ScriptRoot $f
  if (Test-Path $src) { Copy-Item $src $AppDir -Force }
}
# Copy agent script to data dir too
Copy-Item "$ScriptRoot\ad-manager-agent.ps1" "$DataDir\" -Force
Copy-Item "$ScriptRoot\run-agent.ps1" "$DataDir\" -Force

# 3. Create run-agent.ps1 with correct ServerUrl
$wrapper = @"
`$ServerUrl = "$ServerUrl"
& "$DataDir\ad-manager-agent.ps1" -ServerUrl `$ServerUrl
"@
$wrapper | Out-File -FilePath "$DataDir\run-agent.ps1" -Encoding utf8 -Force

Write-Status "Files installed to $AppDir" -Color Green

# 4. Create scheduled task (SYSTEM, runs at startup)
Write-Status "Creating scheduled task (SYSTEM)..." -Color White
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File `"$DataDir\run-agent.ps1`" -NoLogo -NonInteractive -WindowStyle Hidden"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Compatibility Win8 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName "ADManagerAgent" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force
Start-ScheduledTask -TaskName "ADManagerAgent" -ErrorAction SilentlyContinue
Write-Status "Scheduled task created and started." -Color Green

# 5. Add tray app to Startup (current user)
Write-Status "Adding tray app to startup..." -Color White
$startupPath = [Environment]::GetFolderPath("Startup")
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut("$startupPath\AD Manager Agent.lnk")
$shortcut.TargetPath = $TrayExe
$shortcut.WorkingDirectory = $AppDir
$shortcut.Description = "AD Manager Agent - System Tray"
$shortcut.IconLocation = "$AppDir\admanager-icon.ico, 0"
$shortcut.Save()

# Also start the tray app now
try {
  $existing = Get-Process -Name "ADManagerTray" -ErrorAction SilentlyContinue
  if ($existing) { $existing | Stop-Process -Force }
  Start-Process -FilePath $TrayExe -WindowStyle Hidden
  Write-Status "Tray app started." -Color Green
} catch {
  Write-Status "Could not start tray app: $_" -Color Yellow
}

# 6. Create Programs and Features (Control Panel) entry
Write-Status "Registering in Programs and Features..." -Color White
$date = Get-Date -Format "yyyyMMdd"
$reg = @{
  "DisplayName" = $ProductName
  "DisplayVersion" = $Version
  "Publisher" = $Publisher
  "InstallDate" = $date
  "DisplayIcon" = "$AppDir\admanager-icon.ico"
  "UninstallString" = "powershell.exe -ExecutionPolicy Bypass -File `"$AppDir\install-product.ps1`" -Uninstall"
  "QuietUninstallString" = "powershell.exe -ExecutionPolicy Bypass -File `"$AppDir\install-product.ps1`" -Uninstall -Silent"
  "InstallLocation" = $AppDir
  "NoModify" = 1
  "NoRepair" = 1
  "EstimatedSize" = 5 # MB
}
if (-not (Test-Path $UninstallKey)) { New-Item -Path $UninstallKey -Force | Out-Null }
foreach ($key in $reg.Keys) { Set-ItemProperty -Path $UninstallKey -Name $key -Value $reg[$key] }

Write-Status "Registered in Control Panel > Programs and Features." -Color Green

# ═══════════════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════════════
Write-Status "=== Installation Complete ===" -Color Cyan
Write-Status "Product: $ProductName v$Version" -Color Green
Write-Status "Location: $AppDir" -Color Green
Write-Status "Server: $ServerUrl" -Color Green
Write-Status "Tray icon: Running in system tray" -Color Green
Write-Status "Control Panel: Programs and Features > $ProductName" -Color Green
Write-Status "Scheduled task: ADManagerAgent (SYSTEM)" -Color Green
Write-Status "Startup: Automatic (startup folder + scheduled task)" -Color Green

if (-not $Silent) {
  Write-Host ""
  Write-Host "You can uninstall from Control Panel > Programs and Features > AD Manager Agent" -ForegroundColor Gray
  Write-Host "Or run: .\install-product.ps1 -Uninstall" -ForegroundColor Gray
}
