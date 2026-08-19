# Exercise `token rotate`: the old token is voided, the new one works, terminals survive.
$exe = 'C:\data\code\terminal-editor2\sessionhubd\target\debug\sessionhubd.exe'
$fh  = 'C:\Users\user\AppData\Local\Temp\claude\C--data-code-terminal-editor2\1c72f2cc-7025-4869-a627-df2b835ecce0\scratchpad\fakehome'
$cfgPath = "$fh\.sessionhub\config.toml"

$script:pass = 0; $script:fail = 0
function check($c, $m) { if ($c) { $script:pass++; Write-Host "  [ ok ] $m" } else { $script:fail++; Write-Host "  [FAIL] $m" } }
function tokenOf { (Select-String -Path $cfgPath -Pattern '^token\s*=\s*"(.+)"').Matches[0].Groups[1].Value }

& $exe stop --home $fh | Out-Null
Start-Sleep -Milliseconds 500
$old = tokenOf
# Without -Wait: the daemon detaches itself, so waiting for the process that
# launched it would hang until the daemon itself dies.
Start-Process -FilePath $exe -ArgumentList 'start','--home',$fh -NoNewWindow | Out-Null
$st = ''
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  $st = & $exe status --home $fh 2>&1 | Out-String
  if ($st -match 'is running') { break }
}
check ($st -match 'is running') "the daemon runs with the old token"

# A terminal that has to survive the rotation.
$port = 7719
$body = @"
const ws = new WebSocket('ws://127.0.0.1:$port/ws?token=$old');
const seen = []; ws.onmessage = e => { if (typeof e.data === 'string') seen.push(JSON.parse(e.data)); };
await new Promise(r => ws.onopen = r);
const sleep = ms => new Promise(r => setTimeout(r, ms));
while (!seen.find(m => m.t === 'state')) await sleep(100);
ws.send(JSON.stringify({t:'spawn', project:'C:\\\\data\\\\code\\\\terminal-editor2', agent:'shell', resume:null, cols:90, rows:24}));
while (!seen.find(m => m.t === 'attached')) await sleep(100);
console.log(seen.find(m => m.t === 'attached').id);
ws.close();
"@
Set-Content -Path "$fh\spawn.mjs" -Value $body -Encoding utf8
$termId = (node "$fh\spawn.mjs" 2>&1 | Select-Object -Last 1).ToString().Trim()
check ($termId -match '^\d+$') "test terminal created (id=$termId)"

# --- the rotation ------------------------------------------------------------
$out = & $exe token rotate --home $fh 2>&1 | Out-String
$new = tokenOf
check ($new -ne $old) "the token in the config has changed"
check ($new.Length -eq 43) "the token is still 32 bytes of base64url ($($new.Length) characters)"
check ($out -match 'already in effect') "the daemon takes note of it without a restart"
check ($out -match [regex]::Escape($new)) "the new address is printed for the user"

# --- the old token must be rejected, the new one accepted --------------------
try { Invoke-WebRequest "http://127.0.0.1:$port/?token=$old" -UseBasicParsing | Out-Null; check $false "the old token is still accepted" }
catch { check ($_.Exception.Response.StatusCode.value__ -eq 401) "the old token is rejected with 401" }

$r = Invoke-WebRequest "http://127.0.0.1:$port/?token=$new" -UseBasicParsing
check ($r.StatusCode -eq 200) "the new token is accepted"

# --- the terminal has to survive ---------------------------------------------
$st2 = & $exe status --home $fh 2>&1 | Out-String
check ($st2 -match 'terminals:\s+1 live') "the terminal stays alive across the rotation"
Write-Host ($st2.Trim() -split "`n" | ForEach-Object { "    $_" }) -Separator "`n"

& $exe stop --home $fh | Out-Null
Write-Host "`n$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
