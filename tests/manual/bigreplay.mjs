// Exercise the ring buffer near its capacity: flood the terminal with output,
// then attach a fresh client and see whether its replay is intact and still capped.

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
const CAP = 2 * 1024 * 1024;

const steps = [];
const check = (cond, m) => { steps.push(cond); console.log(`  [${cond ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    ws.binaryType = 'arraybuffer';
    const c = { label, ws, events: [], bytes: 0, text: '' };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') c.events.push({ kind: 'json', msg: JSON.parse(ev.data) });
      else {
        const b = Buffer.from(ev.data);
        c.events.push({ kind: 'bin', id: b.readUInt32LE(0), bytes: b.length - 4 });
        c.bytes += b.length - 4;
        c.text += b.subarray(4).toString('utf8');
      }
    };
    ws.onopen = () => resolve(c);
    ws.onerror = () => reject(new Error(`failed to connect ${label}`));
  });
}
const send = (c, o) => c.ws.send(JSON.stringify(o));
const input = (c, id, t) => {
  const body = Buffer.from(t, 'utf8');
  const f = Buffer.alloc(4 + body.length);
  f.writeUInt32LE(id, 0); body.copy(f, 4); c.ws.send(f);
};
const json = (c, t) => c.events.find((e) => e.kind === 'json' && e.msg.t === t)?.msg;
async function waitFor(c, pred, what, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const h = pred(c); if (h) return h; await sleep(80); }
  throw new Error(`timed out waiting for ${what} on ${c.label}`);
}

const a = await connect('A');
await waitFor(a, (c) => json(c, 'state'), 'state');
send(a, { t: 'spawn', project: PROJECT, agent: 'shell', resume: null, cols: 100, rows: 30 });
const att = await waitFor(a, (c) => json(c, 'attached'), 'attached');
const term = att.id;
await waitFor(a, (c) => /PS [A-Z]:/.test(c.text), 'prompt');

// ~3 MB of output: more than the ring can hold, so trimming is bound to happen.
console.log('  flooding the terminal with ~3 MB of output...');
input(a, term, "1..30000 | ForEach-Object { 'baris-' + $_ + '-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }\r");
input(a, term, 'echo ("SEL"+"ESAI")\r');
// Client A intentionally does NOT receive all of it: when its queue fills up, the
// oldest chunk is dropped so the PTY reader is not held back as well. What we
// wait for is the end marker.
await waitFor(a, (c) => c.text.includes('SELESAI'), 'end-of-flood marker', 180000);
await sleep(2000);
console.log(`  A received ${(a.bytes / 1024 / 1024).toFixed(2)} MB (whether or not the queue filled up, both are legitimate)`);

const b = await connect('B');
await waitFor(b, (c) => json(c, 'state'), 'state B');
b.events = []; b.bytes = 0; b.text = '';
send(b, { t: 'attach', id: term, cols: 100, rows: 30 });
await waitFor(b, (c) => json(c, 'attached'), 'attached B');

const replay = b.events.find((e) => e.kind === 'bin');
const idxBin = b.events.findIndex((e) => e.kind === 'bin');
const idxAtt = b.events.findIndex((e) => e.kind === 'json' && e.msg.t === 'attached');

console.log(`  replay frame: ${(replay.bytes / 1024 / 1024).toFixed(2)} MB in a single frame`);
check(idxBin === 0 && idxBin < idxAtt, 'a large replay is still sent before {"t":"attached"}');
check(replay.bytes <= CAP, `replay is capped by the ring capacity (${replay.bytes} <= ${CAP})`);
check(replay.bytes > CAP * 0.9, 'the ring really did fill up close to capacity, not cut short early');
check(b.text.includes('baris-30000-'), 'the very last line made it into the replay');
check(!b.text.includes('baris-1-x'), 'the earliest line has already been discarded (oldest dropped first)');

send(a, { t: 'kill', id: term });
await waitFor(a, (c) => json(c, 'exit'), 'exit');
a.ws.close(); b.ws.close();

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
