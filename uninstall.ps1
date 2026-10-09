param(
  [string]$TaskName = "DailyCreditCheckin"
)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
if ($?) { Write-Host "[OK] Scheduled task '$TaskName' removed." } else { Write-Host "[i] Task '$TaskName' not found (already removed?)." }

$vbs = Join-Path $root "run_checkin.vbs"
if (Test-Path $vbs) { Remove-Item $vbs -Force; Write-Host "[OK] Launcher removed: $vbs" }

Write-Host ""
Write-Host "Done. signin.log / trae_device_id.json were kept in $root - delete them manually if you want a full cleanup."
