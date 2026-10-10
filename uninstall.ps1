param(
  [string]$TaskName = "DailyCreditCheckin",
  [string]$WatcherTaskName = "DailyCreditWatcher"
)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

foreach ($tn in @($TaskName, $WatcherTaskName)) {
  Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue
  if ($?) { Write-Host "[OK] Scheduled task '$tn' removed." } else { Write-Host "[i] Task '$tn' not found (already removed?)." }
}

foreach ($f in @("run_checkin.vbs", "run_watcher.vbs")) {
  $p = Join-Path $root $f
  if (Test-Path $p) { Remove-Item $p -Force; Write-Host "[OK] Launcher removed: $p" }
}

Write-Host ""
Write-Host "Done. Signin logs and device-id cache were kept in $root - delete them manually if you want a full cleanup."
