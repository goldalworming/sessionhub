// Is the real agent emitting color now?
import { readFileSync, writeFileSync } from 'node:fs';

const PORT = 7719;
// Read from the config rather than hard-coded: the daemon's token changes, and
// a stale copy here fails as "cannot connect", which says nothing about what
// this test is actually checking.
const CFG = 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome\\.sessionhub\\config.toml';
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];
const THEME = process.argv[2] || 'dark';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
app.binaryType = 'arraybuffer';
const msgs = [];
let raw = '';
app.onmessage = (e) => {
  if (typeof e.data === 'string') msgs.push(JSON.parse(e.data));
  else raw += Buffer.from(e.data).subarray(4).toString('utf8');
};
await new Promise((r) => { app.onopen = r; });
while (!msgs.find((m) => m.t === 'state')) await sleep(100);

app.send(JSON.stringify({
  t: 'spawn', project: 'C:\\data\\code\\terminal-editor2', agent: 'claude', resume: null, cols: 110, rows: 30,
}));
while (!msgs.find((m) => m.t === 'attached')) await sleep(100);
const id = msgs.find((m) => m.t === 'attached').id;
await sleep(16000);

// The colors the agent asks for, worked out from the SGR sequences in the raw stream.
const sgr = [...raw.matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1]);
const colorful = sgr.filter((s) => /(^|;)(3[0-7]|9[0-7]|38;[25])/.test(s));
console.log(`  SGR sequences from agent   : ${sgr.length}`);
console.log(`  of those, color commands   : ${colorful.length}`);
console.log(`  examples                   : ${[...new Set(colorful)].slice(0, 8).join('  ')}`);

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

await cmd('Emulation.setDeviceMetricsOverride', { width: 1100, height: 640, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.setItem('sh.theme','${THEME}'); localStorage.setItem('sh.sidebar.hidden','1')`);
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5000);
await ev(`[...document.querySelectorAll('.tab')].find(t => t.dataset.id === '${id}')?.click()`);
await sleep(4000);

const colors = await ev(`
  (() => {
    const n = new Set();
    for (const el of document.querySelectorAll('.xterm-rows span')) n.add(getComputedStyle(el).color);
    return [...n];
  })()
`);
console.log(`  distinct colors on screen  : ${colors.length}`);

await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
const shot = await cmd('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 28, width: 760, height: 300, scale: 2 } });
writeFileSync(`agent-${THEME}.png`, Buffer.from(shot.result.data, 'base64'));
console.log(`  agent-${THEME}.png`);

app.send(JSON.stringify({ t: 'kill', id }));
await sleep(1500);
app.close();
ws.close();
