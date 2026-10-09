param(
  [string]$TaskName = "DailyCreditCheckin"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

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

Write-Host "=== wb-trae-checkin installer ==="

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

# Silent VBS launcher (UTF-16 so non-ASCII paths also work)
$vbs = Join-Path $root "run_checkin.vbs"
$vbsContent = 'CreateObject("WScript.Shell").Run """' + $node + '"" ""' + $script + '"" silent", 0, False'
[System.IO.File]::WriteAllText($vbs, $vbsContent, [System.Text.Encoding]::Unicode)
Write-Host "[OK] Silent launcher written: $vbs"

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $vbs + '"')
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$logonTrigger.Delay = "PT30S"
$triggers = @(
  (New-ScheduledTaskTrigger -Daily -At "00:05"),
  (New-ScheduledTaskTrigger -Daily -At "09:00"),
  (New-ScheduledTaskTrigger -Daily -At "12:30"),
  (New-ScheduledTaskTrigger -Daily -At "19:00"),
  $logonTrigger
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -Hidden `
  -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
  -Description "WorkBuddy + TRAE daily credit check-in (silent, idempotent, network-gated)" -Force | Out-Null
Write-Host "[OK] Scheduled task '$TaskName' registered:"
Write-Host "     Triggers: daily 00:05 / 09:00 / 12:30 / 19:00 + every logon (+ catch-up after missed slots)"
Write-Host "     Runs only when network is available; invisible (no window)."

# Smoke test
Write-Host ""
Write-Host "[..] Running a one-time test check-in (about 15 seconds)..."
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
