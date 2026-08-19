import { readFileSync } from 'node:fs';
// Read from the config rather than hard-coded: the daemon's token changes, and
// a stale copy here fails as "cannot connect".
const CFG = 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome\\.sessionhub\\config.toml';
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];
const ws = new WebSocket(`ws://127.0.0.1:7719/ws?token=${TOKEN}`);
ws.binaryType = 'arraybuffer';
const msgs = []; let screen = '';
ws.onmessage = e => { if (typeof e.data === 'string') msgs.push(JSON.parse(e.data)); else screen += Buffer.from(e.data).subarray(4).toString('utf8'); };
await new Promise(r => ws.onopen = r);
const sleep = ms => new Promise(r => setTimeout(r, ms));
while (!msgs.find(m => m.t === 'state')) await sleep(100);
ws.send(JSON.stringify({t:'spawn', project:'C:\\data\\code\\terminal-editor2', agent:'shell', resume:null, cols:100, rows:26}));
while (!msgs.find(m => m.t === 'attached')) await sleep(100);
const id = msgs.find(m => m.t === 'attached').id;
const send = t => { const b = Buffer.from(t); const f = Buffer.alloc(4+b.length); f.writeUInt32LE(id,0); b.copy(f,4); ws.send(f); };
while (!/PS [A-Z]:/.test(screen)) await sleep(150);
screen = '';
send('foreach($n in "TERM","COLORTERM","FORCE_COLOR","NO_COLOR","WT_SESSION","ConEmuANSI"){ $v=[Environment]::GetEnvironmentVariable($n); Write-Host ("EN"+"V " + $n + "=[" + $v + "]") }\r');
await sleep(2500);
console.log(screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g,'').split('\n').filter(l => l.includes('ENV ')).map(l => '  ' + l.trim()).join('\n'));
ws.send(JSON.stringify({t:'kill', id})); await sleep(800); ws.close();
