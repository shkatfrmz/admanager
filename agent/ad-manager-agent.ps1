param(
  [string]$ServerUrl = "http://localhost:3000",
  [int]$HeartbeatIntervalSec = 300
)

$AgentVersion = "1.0.0"
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

function Invoke-Deployment {
  param($Task)
  $deployId = $Task.id
  Send-Progress -DeploymentId $deployId -Pct 5 -Status "in_progress"
  $tempDir = "$env:TEMP\ADManagerDeploy"
  if (-not (Test-Path $tempDir)) { New-Item -ItemType Directory -Path $tempDir -Force | Out-Null }
  $filePath = "$tempDir\$($Task.original_name)"
  $downloadUrl = "$ServerUrl/api/endpoints/deployments/download/$($Task.stored_path)"
  Write-Log "Downloading $downloadUrl"
  Send-Progress -DeploymentId $deployId -Pct 15 -Status "in_progress"
  try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $filePath -TimeoutSec 300 -UseBasicParsing
    Write-Log "Downloaded to $filePath ($([math]::Round((Get-Item $filePath).Length / 1MB, 1)) MB)"
  } catch { return @{ status = "failed"; error = "Download failed: $_" } }
  Send-Progress -DeploymentId $deployId -Pct 50

  $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
  try {
    switch ($ext) {
      ".msi"  {
        Write-Log "Installing MSI quietly..."
        Send-Progress -DeploymentId $deployId -Pct 60 -Status "in_progress"
        $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$filePath`" /quiet /norestart" -NoNewWindow -Wait -PassThru
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
          @("/VERYSILENT", "/NORESTART"),
          @("/SILENT", "/NORESTART"),
          @("/quiet", "/norestart"),
          @("/qn", "/norestart"),
          @("-y")
        )
        $installed = $false
        foreach ($args in $silentArgs) {
          $argString = $args -join ' '
          Write-Log "Trying silent install: $argString"
          $proc = Start-Process -FilePath $filePath -ArgumentList $argString -Wait -PassThru -WindowStyle Hidden
          if ($proc.ExitCode -eq 0 -or $proc.ExitCode -eq 1641 -or $proc.ExitCode -eq 3010) {
            Write-Log "Success with exit code $($proc.ExitCode) using $argString"
            $installed = $true
            break
          } else {
            Write-Log "Exit code $($proc.ExitCode) with $argString"
          }
        }
        if ($installed) { return @{ status = "success" } }

        Write-Log "No silent switch succeeded - running with no flags"
        $proc = Start-Process -FilePath $filePath -Wait -PassThru -WindowStyle Hidden
        if ($proc.ExitCode -eq 0 -or $proc.ExitCode -eq 1641 -or $proc.ExitCode -eq 3010) { return @{ status = "success" } }
        else { return @{ status = "failed"; error = "EXE exit code: $($proc.ExitCode)" } }
      }
      ".ps1" {
        Write-Log "Executing PowerShell script..."
        Send-Progress -DeploymentId $deployId -Pct 60 -Status "in_progress"
        $output = powershell -ExecutionPolicy Bypass -File $filePath 2>&1
        Send-Progress -DeploymentId $deployId -Pct 90
        if ($LASTEXITCODE -eq 0 -or -not $LASTEXITCODE) { return @{ status = "success" } }
        else { return @{ status = "failed"; error = "PowerShell exit code: $LASTEXITCODE" } }
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
