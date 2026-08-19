// Helper for acceptance test #4.
//   node survive.mjs seed          -> create a terminal, write a marker, print its id
//   node survive.mjs verify <id>   -> attach to that terminal, make sure the marker comes back

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
const MARK = 'PENANDA-SEBELUM-TERMINAL-DITUTUP';

const strip = (s) =>
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    ws.binaryType = 'arraybuffer';
    const c = { ws, events: [], text: '' };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') c.events.push(JSON.parse(ev.data));
      else {
        const b = Buffer.from(ev.data);
        c.events.push({ t: '_bin', id: b.readUInt32LE(0) });
        c.text += strip(b.subarray(4).toString('utf8'));
      }
    };
    ws.onopen = () => resolve(c);
    ws.onerror = () => reject(new Error('failed to connect'));
  });
}
const send = (c, o) => c.ws.send(JSON.stringify(o));
const input = (c, id, t) => {
  const body = Buffer.from(t, 'utf8');
  const f = Buffer.alloc(4 + body.length);
  f.writeUInt32LE(id, 0); body.copy(f, 4); c.ws.send(f);
};
const msg = (c, t) => c.events.find((e) => e.t === t);
async function waitFor(c, pred, what, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const h = pred(c); if (h) return h; await sleep(80); }
  throw new Error(`timed out waiting for ${what}`);
}

const mode = process.argv[2];
const c = await connect();
await waitFor(c, (x) => msg(x, 'state'), 'state');

if (mode === 'seed') {
  send(c, { t: 'spawn', project: PROJECT, agent: 'shell', resume: null, cols: 100, rows: 30 });
  const att = await waitFor(c, (x) => msg(x, 'attached'), 'attached');
  await waitFor(c, (x) => /PS [A-Z]:/.test(x.text), 'prompt');
  input(c, att.id, `echo ("PENANDA-SEBELUM"+"-TERMINAL-DITUTUP")\r`);
  await waitFor(c, (x) => x.text.includes(MARK), 'marker');
  console.log(att.id);
  c.ws.close();
  process.exit(0);
}

if (mode === 'verify') {
  const id = Number(process.argv[3]);
  const st = msg(c, 'state');
  const term = st.terminals.find((t) => t.id === id);
  if (!term) { console.log('FAIL: the terminal is no longer in the state'); process.exit(1); }
  if (!term.alive) { console.log('FAIL: the terminal is there but already dead'); process.exit(1); }

  c.events = []; c.text = '';
  send(c, { t: 'attach', id, cols: 100, rows: 30 });
  await waitFor(c, (x) => msg(x, 'attached'), 'attached');
  if (!c.text.includes(MARK)) { console.log('FAIL: the replay does not contain the marker'); process.exit(1); }

  // The terminal is still genuinely usable, not merely recorded as alive.
  c.text = '';
  input(c, id, 'echo ("MASIH"+"-HIDUP")\r');
  await waitFor(c, (x) => x.text.includes('MASIH-HIDUP'), 'a new command');
  console.log('OK: terminal intact, contents replayed, and still accepting commands');
  c.ws.close();
  process.exit(0);
}

console.log('unknown mode');
process.exit(2);
