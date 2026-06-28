$msg = "AD Manager deployment test ran successfully at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') on $env:COMPUTERNAME"
$logFile = "$env:ProgramData\ADManagerAgent\deploy-test.log"
$msg | Out-File -FilePath $logFile -Encoding utf8 -Force
Write-Output $msg
