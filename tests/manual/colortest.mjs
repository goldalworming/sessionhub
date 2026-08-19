// Do the colours that cmd emits make it onto the screen? Run cmd.exe through the
// daemon, emit the whole ANSI spectrum, then capture the screen.
import { readFileSync, writeFileSync } from 'node:fs';

const PORT = 7719;
// Read from the config rather than hard-coded: the daemon's token changes, and
// a stale copy here fails as "cannot connect", which says nothing about what
// this test is actually checking.
const CFG = 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome\\.sessionhub\\config.toml';
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];
const THEME = process.argv[2] || 'dark';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- set up the cmd terminal -------------------------------------------------
const app = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
app.binaryType = 'arraybuffer';
const msgs = [];
let screen = '';
app.onmessage = (e) => {
  if (typeof e.data === 'string') msgs.push(JSON.parse(e.data));
  else screen += Buffer.from(e.data).subarray(4).toString('utf8');
};
await new Promise((r) => { app.onopen = r; });
while (!msgs.find((m) => m.t === 'state')) await sleep(100);

app.send(JSON.stringify({
  t: 'spawn', project: 'C:\\data\\code\\terminal-editor2', agent: 'cmd', resume: null, cols: 100, rows: 26,
}));
while (!msgs.find((m) => m.t === 'attached')) await sleep(100);
const id = msgs.find((m) => m.t === 'attached').id;
await sleep(2500);

const send = (text) => {
  const b = Buffer.from(text, 'utf8');
  const f = Buffer.alloc(4 + b.length);
  f.writeUInt32LE(id, 0); b.copy(f, 4); app.send(f);
};

// ESC cannot be typed directly: the cmd line editor swallows it. The official way
// to get an ESC inside cmd is via `prompt $E`, then storing it in a variable.
// This really is colour that cmd itself emits.
send('for /f "delims=" %a in (\'echo prompt $E^| cmd\') do @set "E=%a"\r');
await sleep(1200);
send('echo %E%[31mMERAH %E%[32mHIJAU %E%[33mKUNING %E%[34mBIRU %E%[35mMAGENTA %E%[36mCYAN %E%[37mPUTIH%E%[0m\r');
await sleep(700);
send('echo %E%[91mMERAH+ %E%[92mHIJAU+ %E%[93mKUNING+ %E%[94mBIRU+ %E%[96mCYAN+ %E%[97mPUTIH+%E%[0m\r');
await sleep(700);
send('echo %E%[41m  %E%[42m  %E%[43m  %E%[44m  %E%[45m  %E%[46m  %E%[47m  %E%[0m latar\r');
await sleep(700);
send('echo %E%[38;5;208m256-warna %E%[38;2;0;180;255mTRUECOLOR %E%[1mTEBAL %E%[4mGARIS %E%[7mTERBALIK%E%[0m\r');
await sleep(1800);

console.log('  what the client received (ANSI stripped):');
console.log('    ' + screen.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-7).join('\n    ').trim());
const hasColor = /\x1b\[3[1-7]m/.test(screen);
const hasTruecolor = /\x1b\[38;2;/.test(screen);
console.log(`  ANSI colour sequences reach the client : ${hasColor}`);
console.log(`  truecolor reaches the client           : ${hasTruecolor}`);

// --- look at the result on screen --------------------------------------------
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cmd = (method, params = {}) => {
  const i = ++seq;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pending.set(i, r));
};
const ev = async (e) =>
  (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))
    .result?.result?.value;

await cmd('Emulation.setDeviceMetricsOverride', { width: 1100, height: 620, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.setItem('sh.theme','${THEME}'); localStorage.setItem('sh.sidebar.hidden','1')`);
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5000);
await ev(`[...document.querySelectorAll('.tab')].find(t => t.dataset.id === '${id}')?.click()`);
await sleep(3500);

// How many distinct colours does xterm actually paint?
const used = await ev(`
  (() => {
    const n = new Set();
    for (const el of document.querySelectorAll('.xterm-rows span')) {
      const c = getComputedStyle(el).color;
      if (c) n.add(c);
    }
    return [...n];
  })()
`);
console.log(`  distinct colours painted by xterm      : ${used.length}`);
console.log(`    ${used.slice(0, 12).join('  ')}`);

await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
const shot = await cmd('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 28, width: 700, height: 260, scale: 2 } });
writeFileSync(`warna-${THEME}.png`, Buffer.from(shot.result.data, 'base64'));
console.log(`  warna-${THEME}.png`);

app.send(JSON.stringify({ t: 'kill', id }));
await sleep(1200);
app.close();
ws.close();
