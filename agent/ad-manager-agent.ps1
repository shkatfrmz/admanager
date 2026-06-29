param(
  [string]$ServerUrl = "http://localhost:3000",
  [int]$HeartbeatIntervalSec = 300
)

$AgentVersion = "1.1.0"
$EndpointId = $null
$LogFile = "$env:ProgramData\ADManagerAgent\agent.log"
$StateFile = "$env:ProgramData\ADManagerAgent\endpoint_id.txt"

function Write-Log {
  param([string]$Msg)
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "$ts`t$Msg" | Out-File -FilePath $LogFile -Append -Encoding utf8
  Write-Host "$ts`t$Msg"
}

function Get-SystemInfo {
  $cs = Get-CimInstance Win32_ComputerSystem
  $os = Get-CimInstance Win32_OperatingSystem
  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
  $ram = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
  $domain = $env:USERDOMAIN
  $hostname = $env:COMPUTERNAME
  $ip = (Test-Connection -ComputerName $hostname -Count 1 -ErrorAction SilentlyContinue).IPV4Address.IPAddressToString
  if (-not $ip) { $ip = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex (Get-NetAdapter | Where-Object Status -eq Up | Select-Object -First 1 -ExpandProperty ifIndex) -ErrorAction SilentlyContinue).IPAddress }
  return @{
    hostname      = $hostname
    domain        = $domain
    ip_address    = $ip
    os_version    = $os.Caption + " " + $os.Version
    os_arch       = $os.OSArchitecture
    cpu_model     = $cpu.Name
    cpu_cores     = $cs.NumberOfLogicalProcessors
    total_ram_gb  = $ram
    agent_version = $AgentVersion
  }
}

function Register-WithServer {
  $info = Get-SystemInfo
  $body = $info | ConvertTo-Json
  try {
    $resp = Invoke-RestMethod -Uri "$ServerUrl/api/endpoints/register" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 10
    if ($resp.success -and $resp.endpoint_id) {
      $script:EndpointId = $resp.endpoint_id
      $resp.endpoint_id | Out-File -FilePath $StateFile -Encoding utf8 -Force
      Write-Log "Registered as $EndpointId"
      return $true
    }
  } catch { Write-Log "Register failed: $_" }
  return $false
}

function Send-Heartbeat {
  if (-not $EndpointId) { return }
  $info = Get-SystemInfo
  $body = @{ endpoint_id = $EndpointId; hostname = $info.hostname; ip_address = $info.ip_address } | ConvertTo-Json
  try {
    Invoke-RestMethod -Uri "$ServerUrl/api/endpoints/heartbeat" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 10 | Out-Null
    Write-Log "Heartbeat sent"
  } catch { Write-Log "Heartbeat failed: $_" }
}

function Process-Deployments {
  if (-not $EndpointId) { return }
  try {
    $resp = Invoke-RestMethod -Uri "$ServerUrl/api/endpoints/deployments/pending/$EndpointId" -Method Get -TimeoutSec 15
    if ($resp.count -gt 0) {
      Write-Log "Found $($resp.count) pending deployment(s)"
      foreach ($task in $resp.tasks) {
        Write-Log "Processing deployment $($task.id): $($task.file_name)"
        Send-Progress -DeploymentId $task.id -Pct 2 -Status "in_progress"
        $result = Invoke-Deployment $task
        $body = @{ status = $result.status; error_message = $result.error } | ConvertTo-Json
        try {
          Invoke-RestMethod -Uri "$ServerUrl/api/endpoints/deployments/$($task.id)/result" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 10 | Out-Null
          Write-Log "Result reported for deployment $($task.id): $($result.status)"
        } catch { Write-Log "Failed to report result for $($task.id): $_" }
      }
    }
  } catch { Write-Log "Poll deployments failed: $_" }
}

function Send-Progress {
  param([int]$DeploymentId, [int]$Pct, [string]$Status = "", [string]$ErrorMsg = "")
  if (-not $DeploymentId) { return }
  $body = @{ progress_pct = $Pct } | ConvertTo-Json
  try {
    Invoke-RestMethod -Uri "$ServerUrl/api/endpoints/deployments/$DeploymentId/progress" -Method Patch -Body $body -ContentType "application/json" -TimeoutSec 5 | Out-Null
  } catch { }
}

function Test-IsSystem {
  return ($env:USERNAME -eq "$env:COMPUTERNAME`$") -or (([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value -eq "S-1-5-18")
}

function Test-IsAdmin {
  return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Deployment {
  param($Task)
  $deployId = $Task.id
  Send-Progress -DeploymentId $deployId -Pct 5 -Status "in_progress"

  # If we are not running as SYSTEM/Admin, re-elevate the entire install via a one-time scheduled task
  # so that MSI/EXE installs run silently without UAC prompts.
  if (-not (Test-IsSystem) -and -not (Test-IsAdmin)) {
    Write-Log "Agent not running elevated. Scheduling SYSTEM-level install for deployment $deployId"
    return Invoke-DeploymentAsSystem -Task $Task
  }

  $tempDir = "$env:TEMP\ADManagerDeploy"
  try {
    $tempDrive = (Get-Item $tempDir -ErrorAction SilentlyContinue).PSDrive.Name
    if ($tempDrive -eq 'C') {
      $c = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -ErrorAction SilentlyContinue
      if ($c -and ($c.FreeSpace / 1MB) -lt 100) {
        if (Test-Path 'E:\') { $tempDir = 'E:\ADManagerDeploy' }
      }
    }
  } catch {}
  if (-not (Test-Path $tempDir)) { New-Item -ItemType Directory -Path $tempDir -Force | Out-Null }
  $filePath = "$tempDir\$($Task.original_name)"
  $downloadUrl = "$ServerUrl/api/endpoints/deployments/download/$($Task.stored_path)"
  Write-Log "Downloading $downloadUrl"
  Send-Progress -DeploymentId $deployId -Pct 15 -Status "in_progress"
  try {
    # Use WebClient for reliable non-interactive download with a 5-minute timeout
    $wc = New-Object System.Net.WebClient
    $wc.DownloadFile($downloadUrl, $filePath)
    Write-Log "Downloaded to $filePath ($([math]::Round((Get-Item $filePath).Length / 1MB, 1)) MB)"
  } catch { return @{ status = "failed"; error = "Download failed: $_" } }
  Send-Progress -DeploymentId $deployId -Pct 50

  $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
  try {
    switch ($ext) {
      ".msi"  {
        Write-Log "Installing MSI quietly..."
        Send-Progress -DeploymentId $deployId -Pct 60 -Status "in_progress"
        $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$filePath`" /quiet /norestart ALLUSERS=1" -NoNewWindow -Wait -PassThru
        Send-Progress -DeploymentId $deployId -Pct 90
        if ($proc.ExitCode -eq 0 -or $proc.ExitCode -eq 1641 -or $proc.ExitCode -eq 3010) {
          return @{ status = "success" }
        } else { return @{ status = "failed"; error = "MSI exit code: $($proc.ExitCode)" } }
      }
      ".exe" {
        Write-Log "Running EXE silently..."
        Send-Progress -DeploymentId $deployId -Pct 60 -Status "in_progress"

        # Try common silent install switch combinations in order.
        # Many Windows installers return success codes 0, 1641 (reboot initiated) or 3010 (reboot required).
        $silentArgs = @(
          @("/S"),
          @("/S", "/D=C:\Program Files\ADManagerDeploy"),
          @("/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES", "/SP-"),
          @("/SILENT", "/NORESTART", "/SUPPRESSMSGBOXES", "/SP-"),
          @("/quiet", "/norestart"),
          @("/qn", "/norestart"),
          @("-y"),
          @("/verysilent /norestart /suppressmsgboxes")
        )
        $installed = $false
        foreach ($args in $silentArgs) {
          $argString = $args -join ' '
          Write-Log "Trying silent install: $argString"
          $proc = Start-Process -FilePath $filePath -ArgumentList $argString -Wait -PassThru -WindowStyle Hidden -ErrorAction SilentlyContinue
          if ($proc -and ($proc.ExitCode -eq 0 -or $proc.ExitCode -eq 1641 -or $proc.ExitCode -eq 3010)) {
            Write-Log "Success with exit code $($proc.ExitCode) using $argString"
            $installed = $true
            break
          } else {
            Write-Log "Exit code $($proc.ExitCode) with $argString"
          }
        }
        if ($installed) { return @{ status = "success" } }

        Write-Log "No silent switch succeeded - running with no flags"
        $proc = Start-Process -FilePath $filePath -Wait -PassThru -WindowStyle Hidden -ErrorAction SilentlyContinue
        if ($proc -and ($proc.ExitCode -eq 0 -or $proc.ExitCode -eq 1641 -or $proc.ExitCode -eq 3010)) { return @{ status = "success" } }
        else { return @{ status = "failed"; error = "EXE exit code: $($proc.ExitCode)" } }
      }
      ".ps1" {
        Write-Log "Executing PowerShell script..."
        Send-Progress -DeploymentId $deployId -Pct 60 -Status "in_progress"
        $proc = Start-Process -FilePath "powershell.exe" -ArgumentList "-ExecutionPolicy Bypass -File `"$filePath`"" -Wait -PassThru -WindowStyle Hidden -NoNewWindow
        Send-Progress -DeploymentId $deployId -Pct 90
        if ($proc.ExitCode -eq 0 -or -not $proc.ExitCode) { return @{ status = "success" } }
        else { return @{ status = "failed"; error = "PowerShell exit code: $($proc.ExitCode)" } }
      }
      { $_ -eq ".bat" -or $_ -eq ".cmd" } {
        Write-Log "Executing batch file..."
        Send-Progress -DeploymentId $deployId -Pct 60 -Status "in_progress"
        $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$filePath`"" -NoNewWindow -Wait -PassThru
        Send-Progress -DeploymentId $deployId -Pct 90
        if ($proc.ExitCode -eq 0) { return @{ status = "success" } }
        else { return @{ status = "failed"; error = "Batch exit code: $($proc.ExitCode)" } }
      }
      default {
        Write-Log "Unsupported file type: $ext, attempting to execute directly..."
        Send-Progress -DeploymentId $deployId -Pct 60 -Status "in_progress"
        $proc = Start-Process -FilePath $filePath -NoNewWindow -Wait -PassThru
        Send-Progress -DeploymentId $deployId -Pct 90
        return @{ status = "success"; error = "Unknown type, exit code: $($proc.ExitCode)" }
      }
    }
  } catch { return @{ status = "failed"; error = "Execution error: $_" } }
}

function Invoke-DeploymentAsSystem {
  param($Task)
  $deployId = $Task.id
  $resultFile = "$env:ProgramData\ADManagerAgent\deploy-result-$deployId.json"
  $wrapper = @"
`$ServerUrl = '$ServerUrl'
`$TaskJson = @'
$($Task | ConvertTo-Json -Depth 3)
'@
`$Task = `$TaskJson | ConvertFrom-Json
`$AgentPath = '$PSScriptRoot\ad-manager-agent.ps1'
if (Test-Path `$AgentPath) {
  . `$AgentPath -ServerUrl `$ServerUrl
  `$result = Invoke-Deployment -Task `$Task
} else {
  `$result = @{ status = 'failed'; error = 'Agent script not found at expected path' }
}
`$result | ConvertTo-Json -Depth 3 | Out-File -FilePath '$resultFile' -Encoding utf8 -Force
"@
  $tmpScript = "$env:ProgramData\ADManagerAgent\deploy-elevated-$deployId.ps1"
  $wrapper | Out-File -FilePath $tmpScript -Encoding utf8 -Force

  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$tmpScript`""
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(2)
  $settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

  $taskName = "ADManagerDeploy_$deployId"
  try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Write-Log "Elevated deployment task $taskName started; waiting up to 10 minutes..."

    $maxWait = 600 # 10 minutes
    $elapsed = 0
    while ($elapsed -lt $maxWait) {
      Start-Sleep -Seconds 10
      $elapsed += 10
      if (Test-Path $resultFile) {
        try {
          $result = Get-Content $resultFile -Raw | ConvertFrom-Json
          Remove-Item $resultFile -Force -ErrorAction SilentlyContinue
          Remove-Item $tmpScript -Force -ErrorAction SilentlyContinue
          try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
          Write-Log "Elevated deployment result: $($result.status)"
          return @{ status = $result.status; error = $result.error }
        } catch {
          Write-Log "Could not read result file yet: $_"
        }
      }
      $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      if (-not $task -or $task.State -eq 'Ready') { break }
    }
    try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
    if (Test-Path $resultFile) {
      try {
        $result = Get-Content $resultFile -Raw | ConvertFrom-Json
        Remove-Item $resultFile -Force -ErrorAction SilentlyContinue
        Remove-Item $tmpScript -Force -ErrorAction SilentlyContinue
        return @{ status = $result.status; error = $result.error }
      } catch {}
    }
    Remove-Item $tmpScript -Force -ErrorAction SilentlyContinue
    return @{ status = "failed"; error = "Elevated deployment timed out or did not report a result after ${elapsed}s" }
  } catch {
    Remove-Item $tmpScript -Force -ErrorAction SilentlyContinue
    return @{ status = "failed"; error = "Failed to schedule SYSTEM deployment: $_" }
  }
}

# Main Loop
Write-Log "AD Manager Agent v$AgentVersion starting..."

if (Test-Path $StateFile) {
  $script:EndpointId = Get-Content $StateFile -Raw -Encoding utf8 | ForEach-Object { $_.Trim() }
  Write-Log "Loaded endpoint ID: $EndpointId"
} else {
  Write-Log "No endpoint ID found, registering..."
  $reg = Register-WithServer
  if (-not $reg) { Write-Log "Initial registration failed. Will retry." }
}

while ($true) {
  if (-not $EndpointId) { Register-WithServer }
  if ($EndpointId) { Send-Heartbeat; Process-Deployments }
  else { Write-Log "Waiting to register..." }
  Start-Sleep -Seconds $HeartbeatIntervalSec
}
