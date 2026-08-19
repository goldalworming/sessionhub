# Acceptance #4: close the terminal that `sessionhubd start` was launched from;
# the daemon has to stay alive and its terminal has to still be there.

$ErrorActionPreference = 'Continue'
$exe  = 'C:\data\code\terminal-editor2\sessionhubd\target\debug\sessionhubd.exe'
$home_ = 'C:\Users\user\AppData\Local\Temp\claude\C--data-code-terminal-editor2\1c72f2cc-7025-4869-a627-df2b835ecce0\scratchpad\fakehome'
$scratch = 'C:\Users\user\AppData\Local\Temp\claude\C--data-code-terminal-editor2\1c72f2cc-7025-4869-a627-df2b835ecce0\scratchpad'
# Helper scripts run from the repo, not from a copy in the scratchpad. Two
# copies mean two sources of truth, and the one in the repo quietly becomes
# dead code — which is exactly what had happened; the two had drifted apart.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$script:pass = 0; $script:fail = 0
function ok($m)  { $script:pass++; Write-Host "  [ ok ] $m" }
function bad($m) { $script:fail++; Write-Host "  [FAIL] $m" }
function check($c, $m) { if ($c) { ok $m } else { bad $m } }

# --- clean slate first -------------------------------------------------------
& $exe stop --home $home_ | Out-Null
Get-Process sessionhubd -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

Write-Host "=== 1. status while it is not running ==="
$out = & $exe status --home $home_ 2>&1 | Out-String
check ($out -match 'is not running') "status reports that it is not running"

# --- 2. run it from a separate terminal --------------------------------------
Write-Host "=== 2. start it via a cmd.exe with a console of its own ==="
$launcher = Start-Process cmd.exe -ArgumentList '/k', "$here\launcher.bat" -PassThru
Write-Host "  cmd.exe launcher pid=$($launcher.Id)"

$daemonPid = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  $s = & $exe status --home $home_ 2>&1 | Out-String
  if ($s -match 'pid\s+:\s+(\d+)') { $daemonPid = [int]$Matches[1]; break }
}
check ($null -ne $daemonPid) "the daemon answers status (pid=$daemonPid)"
if (-not $daemonPid) { Write-Host "`n$script:pass passed, $script:fail failed"; exit 1 }

$parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$daemonPid").ParentProcessId
Write-Host "  daemon pid=$daemonPid, its parent pid=$parent"

# --- 3. create a terminal that has to survive --------------------------------
Write-Host "=== 3. create a terminal with output in it ==="
Push-Location $here
$termId = (node survive.mjs seed 2>&1 | Select-Object -Last 1).ToString().Trim()
Pop-Location
check ($termId -match '^\d+$') "terminal created (id=$termId)"

# --- 4. close the launcher terminal ------------------------------------------
Write-Host "=== 4. close the terminal that launched it ==="
Stop-Process -Id $launcher.Id -Force
Start-Sleep -Seconds 2
$launcherGone = -not (Get-Process -Id $launcher.Id -ErrorAction SilentlyContinue)
check $launcherGone "the cmd.exe launcher really is dead"

$daemonAlive = [bool](Get-Process -Id $daemonPid -ErrorAction SilentlyContinue)
check $daemonAlive "the daemon IS STILL ALIVE after its launcher died"

# --- 5. status and terminal still intact -------------------------------------
Write-Host "=== 5. status and terminal afterwards ==="
$out = & $exe status --home $home_ 2>&1 | Out-String
check ($out -match 'is running') "sessionhubd status still answers"
check ($out -match 'terminals:\s+1 live') "status reports 1 live terminal"
Write-Host ($out.Trim() -split "`n" | ForEach-Object { "    $_" }) -Separator "`n"

Push-Location $here
$verify = node survive.mjs verify $termId 2>&1 | Out-String
Pop-Location
check ($verify -match '^OK:') ("the terminal is still intact: " + $verify.Trim())

# --- 6. stop -----------------------------------------------------------------
Write-Host "=== 6. sessionhubd stop ==="
$out = & $exe stop --home $home_ 2>&1 | Out-String
check ($out -match 'stopped') "stop reports that the daemon has stopped"
Start-Sleep -Milliseconds 800
check (-not (Get-Process -Id $daemonPid -ErrorAction SilentlyContinue)) "the daemon process really is gone"
check (-not (Test-Path "$home_\.sessionhub\daemon.pid")) "pid file cleaned up"
$leftover = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -eq 'powershell.exe -NoLogo -NoProfile' }
check ($null -eq $leftover) "no orphaned PTYs left after the stop"

Write-Host "`n$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
