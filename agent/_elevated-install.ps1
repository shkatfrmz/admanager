Write-Host "Elevated install starting..."
& "C:\Users\sysadmin\Downloads\ad-manager\agent\install-product.ps1" -ServerUrl "http://localhost:3000" -Silent
Start-Sleep -Seconds 3
Get-ScheduledTask | Where-Object { $_.TaskName -like '*ADManager*' } | Select-Object TaskName, State, @{Name='UserId';Expression={$_.Principal.UserId}} | Format-Table -AutoSize
