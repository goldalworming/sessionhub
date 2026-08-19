// Prove that the reported RSS covers a terminal's children as well, not just
// its root process.
import { readFileSync } from 'node:fs';

const PORT = 7719;
// Read from the config rather than hard-coded: the daemon's token changes,
// and a stale copy here fails as "cannot connect", which says nothing about
// what this test is actually checking.
const TOKEN = /token *= *"([^"]+)"/.exec(
  readFileSync(
    'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome\\.sessionhub\\config.toml',
    'utf8',
  ),
)[1];
const PROJECT = 'C:\\data\\code\\terminal-editor2';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB';

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
ws.binaryType = 'arraybuffer';
const msgs = [];
let screen = '';
ws.onmessage = (ev) => {
  if (typeof ev.data === 'string') msgs.push(JSON.parse(ev.data));
  else screen += Buffer.from(ev.data).subarray(4).toString('utf8');
};
await new Promise((res) => { ws.onopen = res; });
const find = (t) => msgs.find((m) => m.t === t);
async function waitFor(pred, what, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const h = pred(); if (h) return h; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}
const input = (id, text) => {
  const body = Buffer.from(text, 'utf8');
  const f = Buffer.alloc(4 + body.length);
  f.writeUInt32LE(id, 0); body.copy(f, 4); ws.send(f);
};
const memFor = async (id) => {
  msgs.length = 0;
  ws.send(JSON.stringify({ t: 'mem' }));
  const m = await waitFor(() => find('mem'), 'mem');
  return m.terminals.find((x) => x.id === id);
};

await waitFor(() => find('state'), 'state');
ws.send(JSON.stringify({ t: 'spawn', project: PROJECT, agent: 'shell', resume: null, cols: 100, rows: 30 }));
const t = await waitFor(() => find('attached'), 'terminal');
await waitFor(() => /PS [A-Z]:/.test(screen), 'prompt');

const before = await memFor(t.id);
console.log(`  before: ${before.processes} processes, ${mb(before.rss_bytes)}`);

// Three idle node children inside that terminal.
for (let i = 0; i < 3; i++) {
  input(t.id, `Start-Process node -ArgumentList '-e','setTimeout(()=>{},60000)' -WindowStyle Hidden\r`);
  await sleep(400);
}
await sleep(4000);

const after = await memFor(t.id);
console.log(`  after: ${after.processes} processes, ${mb(after.rss_bytes)}`);

check(after.processes > before.processes, `process count went up ${before.processes} -> ${after.processes}`);
check(after.rss_bytes > before.rss_bytes, `RSS went up along with it ${mb(before.rss_bytes)} -> ${mb(after.rss_bytes)}`);

ws.send(JSON.stringify({ t: 'kill', id: t.id }));
await waitFor(() => find('exit'), 'exit');
ws.close();
const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
