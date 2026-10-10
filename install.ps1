param(
  [string]$TaskName = "DailyCreditCheckin",
  [string]$WatcherTaskName = "DailyCreditWatcher"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

function Find-Node {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

Write-Host "=== wb-trae-checkin installer v1.3.0 ==="

$node = Find-Node
if (-not $node) {
  Write-Host "[X] Node.js not found."
  Write-Host "    Install Node.js LTS (>=18) from https://nodejs.org/ then run this installer again."
  exit 1
}
$verMajor = [int](& $node -p "process.versions.node.split('.')[0]" 2>$null)
if ($verMajor -lt 18) {
  Write-Host "[X] Node.js >= 18 required (found major version $verMajor). Please upgrade: https://nodejs.org/"
  exit 1
}
Write-Host "[OK] Node.js found: $node (v$verMajor.x)"

$script = Join-Path $root "checkin.js"
if (-not (Test-Path $script)) {
  Write-Host "[X] checkin.js not found next to install.ps1"
  exit 1
}
$watcher = Join-Path $root "watcher.js"
$hasWatcher = Test-Path $watcher

# ---------------------------------------------------------------------------
# Silent VBS launchers (UTF-16 so non-ASCII paths also work).
# Why VBS and not pythonw: VBS is present on every Windows by default, no
# Python required. wscript runs the node process with a hidden window (0).
# ---------------------------------------------------------------------------
$vbs = Join-Path $root "run_checkin.vbs"
$vbsContent = 'CreateObject("WScript.Shell").Run """' + $node + '"" ""' + $script + '"" silent", 0, False'
[System.IO.File]::WriteAllText($vbs, $vbsContent, [System.Text.Encoding]::Unicode)
Write-Host "[OK] Silent launcher written: $vbs"

if ($hasWatcher) {
  $wvbs = Join-Path $root "run_watcher.vbs"
  $wvbsContent = 'CreateObject("WScript.Shell").Run """' + $node + '"" ""' + $watcher + '""", 0, False'
  [System.IO.File]::WriteAllText($wvbs, $wvbsContent, [System.Text.Encoding]::Unicode)
  Write-Host "[OK] Watcher launcher written: $wvbs"
}

# ---------------------------------------------------------------------------
# Main task: fixed daily slots + hourly safety-net + logon trigger.
#
# IMPORTANT — do NOT set -RunOnlyIfNetworkAvailable here.
# Windows' "network available" check is unreliable (virtual NICs, VPN, stale
# adapter state after sleep) and, worse, a task blocked by this condition is
# NOT treated as "missed", so StartWhenAvailable will never catch it up.
# We saw a whole day silently skipped because of exactly this. Real-internet
# detection is done inside checkin.js (NCSI content check + API probe), which
# is far more trustworthy.
# ---------------------------------------------------------------------------
$h1 = New-ScheduledTaskTrigger -Daily -At "00:05"
$h2 = New-ScheduledTaskTrigger -Daily -At "09:00"
$h3 = New-ScheduledTaskTrigger -Daily -At "12:30"
$h4 = New-ScheduledTaskTrigger -Daily -At "19:00"

# Hourly safety net: starts at 00:05 and repeats every hour for 24 hours,
# re-armed daily -> effectively 24 attempts/day even if slots get swallowed.
$hourly = New-ScheduledTaskTrigger -Once -At "00:05" `
  -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours 24)

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$logonTrigger.Delay = "PT30S"

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $vbs + '"')
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -Hidden `
  -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive

Register-ScheduledTask -TaskName $TaskName -Action $action `
  -Trigger @($h1, $h2, $h3, $h4, $logonTrigger, $hourly) `
  -Settings $settings -Principal $principal `
  -Description "WorkBuddy + TRAE daily credit check-in (idempotent, real-network gated inside script)" -Force | Out-Null
Write-Host "[OK] Task '$TaskName' registered:"
Write-Host "     Triggers: daily 00:05 / 09:00 / 12:30 / 19:00 + hourly safety net + every logon"
Write-Host "     Invisible (no window). Catch-up enabled for missed slots."

# ---------------------------------------------------------------------------
# Watcher task: resident watchdog that polls every few minutes and exits as
# soon as today's check-in is complete. Last line of defence: even if every
# scheduled trigger gets swallowed, this still finishes the job.
# ---------------------------------------------------------------------------
if ($hasWatcher) {
  $wvbs = Join-Path $root "run_watcher.vbs"
  $wAction = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $wvbs + '"')
  $wLogon = New-ScheduledTaskTrigger -AtLogOn -User $me
  $wLogon.Delay = "PT20S"
  $wDaily = New-ScheduledTaskTrigger -Daily -At "08:00"
  $wSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 24) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $WatcherTaskName -Action $wAction `
    -Trigger @($wLogon, $wDaily) -Settings $wSettings -Principal $principal `
    -Description "Resident watchdog for daily credit check-in; exits once today's task is done" -Force | Out-Null
  Write-Host "[OK] Task '$WatcherTaskName' registered (logon + daily 08:00)"
}

# Smoke test
Write-Host ""
Write-Host "[..] Running a one-time test check-in (about 20 seconds)..."
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 20
$log = Join-Path $root "signin.log"
if (Test-Path $log) {
  Write-Host "----- signin.log (last 4 lines) -----"
  Get-Content $log -Tail 4 -Encoding UTF8
  Write-Host "-------------------------------------"
}
Write-Host ""
Write-Host "[DONE] If both platforms show OK / ALREADY above, setup is complete."
Write-Host "       Log file : $log"
Write-Host "       Uninstall: double-click uninstall.bat"
