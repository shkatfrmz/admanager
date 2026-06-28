param(
  [string]$ServerUrl = "http://172.18.228.89:3000",
  [string[]]$TargetComputers = @(),
  [string]$TargetFile = "",           # Path to list of computers, one per line
  [PSCredential]$Credential = $null,   # Will prompt if not provided
  [string]$AdUsername = "",            # Alternative: AD username (UPN format)
  [string]$AdPassword = ""             # Alternative: AD password
)

# ── Helper: Write colored output ──────────────────────────────────────────
function Write-Status {
  param([string]$Msg, [string]$Color = "White")
  Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $Msg) -ForegroundColor $Color
}

# ── Get credentials ───────────────────────────────────────────────────────
if (-not $Credential) {
  if ($AdUsername -and $AdPassword) {
    $secPass = ConvertTo-SecureString $AdPassword -AsPlainText -Force
    $Credential = New-Object System.Management.Automation.PSCredential ($AdUsername, $secPass)
    Write-Status "Using provided AD credentials: $AdUsername" -Color Cyan
  } else {
    Write-Status "Enter AD admin credentials (e.g. DOMAIN\admin or admin@domain.com):" -Color Yellow
    $Credential = Get-Credential -Message "AD Admin credentials for remote agent install"
  }
}

# ── Get target computers ──────────────────────────────────────────────────
if ($TargetFile -and (Test-Path $TargetFile)) {
  $TargetComputers += Get-Content $TargetFile | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() }
}
if ($TargetComputers.Count -eq 0) {
  # Query AD for all computers
  Write-Status "No targets specified. Querying AD for all domain computers..." -Color Yellow
  try {
    $adComputers = Get-ADComputer -Filter * -Properties Name,OperatingSystem -Credential $Credential -ErrorAction Stop
    $TargetComputers = $adComputers | Where-Object { $_.Name -ne $env:COMPUTERNAME } | Select-Object -ExpandProperty Name
    Write-Status "Found $($TargetComputers.Count) computers in AD (excluding this one)" -Color Green
  } catch {
    Write-Status "Cannot query AD: $_" -Color Red
    Write-Status "Provide a target list via -TargetComputers or -TargetFile" -Color Red
    exit 1
  }
}

Write-Status "=== Remote Agent Installer ===" -Color Cyan
Write-Status "Server URL: $ServerUrl" -Color Cyan
Write-Status "Targets: $($TargetComputers.Count) computer(s)" -Color Cyan

$results = @()
$agentSource = "$PSScriptRoot\ad-manager-agent.ps1"
$installerSource = "$PSScriptRoot\install-agent.ps1"
if (-not (Test-Path $agentSource)) {
  # Fall back to local ProgramData if running from installed location
  $agentSource = "$env:ProgramData\ADManagerAgent\ad-manager-agent.ps1"
  $installerSource = "$env:ProgramData\ADManagerAgent\install-agent.ps1"
}

foreach ($computer in $TargetComputers) {
  Write-Status "Processing $computer..." -Color White
  $result = [PSCustomObject]@{ Computer = $computer; Status = "Failed"; Detail = "" }
  try {
    # Test connectivity
    if (-not (Test-Connection -ComputerName $computer -Count 1 -Quiet -ErrorAction SilentlyContinue)) {
      $result.Detail = "Unreachable"
      Write-Status "  $computer : UNREACHABLE (ping failed)" -Color Red
      $results += $result; continue
    }
    # Test WinRM
    try {
      $null = Test-WSMan -ComputerName $computer -ErrorAction Stop
    } catch {
      $result.Detail = "WinRM not available. Enabling WinRM first..."
      Write-Status "  WinRM not available, attempting to enable..." -Color Yellow
      try {
        Invoke-Command -ComputerName $computer -ScriptBlock { Enable-PSRemoting -Force -SkipNetworkProfileCheck } -Credential $Credential -ErrorAction Stop
        Write-Status "  WinRM enabled" -Color Green
      } catch {
        $result.Detail = "Cannot enable WinRM: $_"
        Write-Status "  $($result.Detail)" -Color Red
        $results += $result; continue
      }
    }

    # Create remote directories
    $remoteDataDir = "\\$computer\C$\ProgramData\ADManagerAgent"
    $remoteProgDir = "\\$computer\C$\Program Files\ADManager\Agent"
    if (-not (Test-Path $remoteDataDir)) { New-Item -ItemType Directory -Path $remoteDataDir -Force | Out-Null }
    if (-not (Test-Path $remoteProgDir)) { New-Item -ItemType Directory -Path $remoteProgDir -Force | Out-Null }
    # Copy agent scripts
    Copy-Item -Path $agentSource -Destination "$remoteDataDir\ad-manager-agent.ps1" -Force
    Copy-Item -Path $installerSource -Destination "$remoteDataDir\install-agent.ps1" -Force
    # Copy compiled tray app if available
    $trayExeDir = Split-Path $agentSource -Parent
    $trayExe = Join-Path $trayExeDir "ADManagerTray.exe"
    $trayIco = Join-Path $trayExeDir "admanager-icon.ico"
    $productInstaller = Join-Path $trayExeDir "install-product.ps1"
    if (Test-Path $trayExe) { Copy-Item $trayExe "$remoteProgDir\" -Force }
    if (Test-Path $trayIco) { Copy-Item $trayIco "$remoteProgDir\" -Force }
    if (Test-Path $productInstaller) { Copy-Item $productInstaller "$remoteProgDir\" -Force }
    Write-Status "  Files copied" -Color Green

    # Run full installer remotely
    $scriptBlock = {
      param($Url)
      $AgentDir = "$env:ProgramData\ADManagerAgent"
      $ProgDir = "$env:ProgramFiles\ADManager\Agent"
      Set-Location $AgentDir
      # Create the run-agent.ps1 wrapper
      $wrapper = @"
`$ServerUrl = "$Url"
& "`$env:ProgramData\ADManagerAgent\ad-manager-agent.ps1" -ServerUrl `$ServerUrl
"@
      $wrapper | Out-File -FilePath "$AgentDir\run-agent.ps1" -Encoding utf8 -Force

      # Create run-agent.ps1 in Program Files too
      $wrapper | Out-File -FilePath "$ProgDir\run-agent.ps1" -Encoding utf8 -Force
      Copy-Item "$AgentDir\ad-manager-agent.ps1" "$ProgDir\" -Force

      # Create scheduled task as SYSTEM
      $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File `"$AgentDir\run-agent.ps1`" -NoLogo -NonInteractive -WindowStyle Hidden"
      $trigger = New-ScheduledTaskTrigger -AtStartup
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Compatibility Win8 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
      $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
      try {
        Register-ScheduledTask -TaskName "ADManagerAgent" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop
        Start-ScheduledTask -TaskName "ADManagerAgent" -ErrorAction SilentlyContinue

        # Start tray app if EXE exists
        $trayExe = "$ProgDir\ADManagerTray.exe"
        if (Test-Path $trayExe) {
          $existing = Get-Process -Name "ADManagerTray" -ErrorAction SilentlyContinue
          if ($existing) { $existing | Stop-Process -Force }
          Start-Process -FilePath $trayExe -WindowStyle Hidden
        }

        # Register in Programs and Features
        $uninstallKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ADManagerAgent"
        if (-not (Test-Path $uninstallKey)) { New-Item -Path $uninstallKey -Force | Out-Null }
        Set-ItemProperty -Path $uninstallKey -Name "DisplayName" -Value "AD Manager Agent"
        Set-ItemProperty -Path $uninstallKey -Name "DisplayVersion" -Value "1.0.0"
        Set-ItemProperty -Path $uninstallKey -Name "Publisher" -Value "AD Manager"
        Set-ItemProperty -Path $uninstallKey -Name "DisplayIcon" -Value "$ProgDir\admanager-icon.ico"
        Set-ItemProperty -Path $uninstallKey -Name "UninstallString" -Value "powershell.exe -ExecutionPolicy Bypass -File `"$ProgDir\install-product.ps1`" -Uninstall"
        Set-ItemProperty -Path $uninstallKey -Name "EstimatedSize" -Value 5

        return "Installed: tray + scheduled task + Programs and Features"
      } catch {
        $p = Start-Process powershell.exe -ArgumentList "-ExecutionPolicy Bypass -File `"$AgentDir\run-agent.ps1`"" -WindowStyle Hidden -PassThru
        return "Started as process PID $($p.Id)"
      }
    }
    $remoteResult = Invoke-Command -ComputerName $computer -ScriptBlock $scriptBlock -ArgumentList $ServerUrl -Credential $Credential -ErrorAction Stop
    $result.Status = "Success"
    $result.Detail = $remoteResult
    Write-Status "  $computer : SUCCESS ($remoteResult)" -Color Green

  } catch {
    $result.Detail = $_.Exception.Message
    Write-Status "  $computer : FAILED ($($result.Detail))" -Color Red
  }
  $results += $result
}

# ── Summary ─────────────────────────────────────────────────────────────
Write-Status "=== Summary ===" -Color Cyan
$success = $results | Where-Object { $_.Status -eq "Success" }
$failed = $results | Where-Object { $_.Status -eq "Failed" }
Write-Status "Successful: $($success.Count)" -Color Green
Write-Status "Failed: $($failed.Count)" -Color Red
if ($failed.Count -gt 0) {
  Write-Status "Failed targets:" -Color Red
  $failed | ForEach-Object { Write-Status "  $($_.Computer): $($_.Detail)" -Color Red }
}
Write-Status "Done." -Color Cyan
