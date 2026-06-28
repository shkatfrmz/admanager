param(
  [string]$ServerUrl = "http://172.18.228.89:3000",
  [string]$AgentScriptPath = "$PSScriptRoot\ad-manager-agent.ps1"
)

$AgentDir = "$env:ProgramData\ADManagerAgent"
$DestScript = "$AgentDir\ad-manager-agent.ps1"

# Create directory
if (-not (Test-Path $AgentDir)) { New-Item -ItemType Directory -Path $AgentDir -Force | Out-Null }

# Copy script
Copy-Item -Path $AgentScriptPath -Destination $DestScript -Force

# Create wrapper that passes the server URL
$WrapperPath = "$AgentDir\run-agent.ps1"
@"
`$ServerUrl = "$ServerUrl"
& "$DestScript" -ServerUrl `$ServerUrl
"@ | Out-File -FilePath $WrapperPath -Encoding utf8 -Force

# Create scheduled task (runs at startup, continuous)
$TaskName = "ADManagerAgent"
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File `"$WrapperPath`" -NoLogo -NonInteractive -WindowStyle Hidden"
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

try {
  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force
  Start-ScheduledTask -TaskName $TaskName
  Write-Output "Agent scheduled task '$TaskName' created and started."
  Write-Output "Server URL: $ServerUrl"
  Write-Output "Script: $DestScript"
} catch {
  Write-Output "Failed to create scheduled task: $_"
  Write-Output "Running agent directly instead..."
  Start-Process powershell.exe -ArgumentList "-ExecutionPolicy Bypass -File `"$WrapperPath`"" -WindowStyle Hidden
}
