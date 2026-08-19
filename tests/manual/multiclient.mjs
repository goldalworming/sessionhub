// Step 2 test: ring buffer + replay on attach, multi-client broadcast, and
// minimum size negotiation. Maps to acceptance #1, #2, #3.

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
const ok = (m) => { steps.push(true); console.log('  [ ok ] ' + m); };
const bad = (m) => { steps.push(false); console.log('  [FAIL] ' + m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

const strip = (s) =>
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    ws.binaryType = 'arraybuffer';
    const c = { label, ws, events: [], screen: '' };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        c.events.push({ kind: 'json', msg: JSON.parse(ev.data) });
      } else {
        const b = Buffer.from(ev.data);
        const text = b.subarray(4).toString('utf8');
        c.events.push({ kind: 'bin', id: b.readUInt32LE(0), bytes: b.length - 4, text });
        c.screen += strip(text);
      }
    };
    ws.onopen = () => resolve(c);
    ws.onerror = () => reject(new Error(`failed to connect ${label}`));
  });
}

const send = (c, o) => c.ws.send(JSON.stringify(o));
const input = (c, id, text) => {
  const body = Buffer.from(text, 'utf8');
  const f = Buffer.alloc(4 + body.length);
  f.writeUInt32LE(id, 0);
  body.copy(f, 4);
  c.ws.send(f);
};
const reset = (c) => { c.events = []; c.screen = ''; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(c, pred, what, ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = pred(c);
    if (hit) return hit;
    await sleep(60);
  }
  throw new Error(`timeout waiting for ${what} on ${c.label}`);
}

const json = (c, t) => c.events.find((e) => e.kind === 'json' && e.msg.t === t)?.msg;
const hasText = (c, s) => c.screen.includes(s);
const querySize = 'Write-Host ("SI"+"ZE=" + $Host.UI.RawUI.WindowSize.Width + "x" + $Host.UI.RawUI.WindowSize.Height)\r';

async function main() {
  // --- A creates a terminal and produces output ---------------------------
  const a = await connect('A');
  await waitFor(a, (c) => json(c, 'state'), 'the initial state');
  send(a, { t: 'spawn', project: PROJECT, agent: 'shell', resume: null, cols: 100, rows: 30 });
  const attached = await waitFor(a, (c) => json(c, 'attached'), 'attached');
  const term = attached.id;
  check(attached.cols === 100 && attached.rows === 30, `A spawns terminal ${term} at 100x30`);

  await waitFor(a, (c) => /PS [A-Z]:/.test(c.screen), 'the prompt');
  input(a, term, 'echo ("JEJAK"+"-LAMA")\r');
  await waitFor(a, (c) => hasText(c, 'JEJAK-LAMA'), 'the first output');
  ok('A sees its own output');

  // --- A closes the connection, then reconnects (acceptance #1) -----------
  a.ws.close();
  await sleep(2000);

  const a2 = await connect("A'");
  const state = await waitFor(a2, (c) => json(c, 'state'), 'state');
  const t0 = state.terminals.find((t) => t.id === term);
  check(!!t0 && t0.alive, 'the terminal stays alive after its client goes away');

  reset(a2);
  send(a2, { t: 'attach', id: term, cols: 100, rows: 30 });
  await waitFor(a2, (c) => json(c, 'attached'), 'attached after the reconnect');

  console.log("    A' event order after attach: " +
    a2.events.map((e) => (e.kind === 'bin' ? `bin(id=${e.id},${e.bytes}B)` : `json(${e.msg.t})`)).join(' -> '));
  const first = a2.events[0];
  check(first?.kind === 'bin', 'the ring buffer replay is sent BEFORE anything else');
  const idxBin = a2.events.findIndex((e) => e.kind === 'bin');
  const idxAtt = a2.events.findIndex((e) => e.kind === 'json' && e.msg.t === 'attached');
  check(idxBin >= 0 && idxBin < idxAtt, 'the order is right: binary replay -> {"t":"attached"}');
  check(first?.id === term, 'the replay frame uses the right terminal id');
  check(hasText(a2, 'JEJAK-LAMA'), 'the previous screen contents come back intact, not a blank screen');

  // --- B attaches too, with a smaller window (acceptance #2, #3) ----------
  const b = await connect('B');
  await waitFor(b, (c) => json(c, 'state'), 'state on B');
  reset(a2);
  reset(b);
  send(b, { t: 'attach', id: term, cols: 80, rows: 24 });
  await waitFor(b, (c) => json(c, 'attached'), 'attached on B');
  check(hasText(b, 'JEJAK-LAMA'), 'B receives the same replay');

  const sizeA = await waitFor(a2, (c) => json(c, 'size'), 'size on A');
  const sizeB = await waitFor(b, (c) => json(c, 'size'), 'size on B');
  check(
    sizeA.cols === 80 && sizeA.rows === 24 && sizeB.cols === 80 && sizeB.rows === 24,
    `the effective size drops to the minimum 80x24 and is broadcast to both`
  );

  reset(a2); reset(b);
  input(a2, term, querySize);
  await waitFor(a2, (c) => hasText(c, 'SIZE=80x24'), 'the size inside the child');
  ok('the child really sees 80x24, not just a number in the protocol');
  await waitFor(b, (c) => hasText(c, 'SIZE=80x24'), 'the same output on B');
  ok('typing on A shows up on both clients (broadcast)');

  // --- the axes are computed separately -----------------------------------
  reset(a2); reset(b);
  send(b, { t: 'resize', id: term, cols: 200, rows: 20 });
  const perAxis = await waitFor(a2, (c) => json(c, 'size'), 'size after B widened');
  console.log(`    broadcast size: ${perAxis.cols}x${perAxis.rows}`);
  await sleep(400);
  reset(a2);
  input(a2, term, querySize);
  await waitFor(a2, (c) => /SIZE=\d+x\d+/.test(c.screen), 'the size report from the child')
    .catch(() => { console.log("    A' screen: " + JSON.stringify(a2.screen.slice(-200))); throw new Error('the child did not report its size'); });
  const reported = a2.screen.match(/SIZE=(\d+)x(\d+)/);
  check(reported && reported[0] === 'SIZE=100x20', `the child reports ${reported?.[0]} (should be SIZE=100x20)`);

  // --- B leaves, the size comes back --------------------------------------
  reset(a2); reset(b);
  send(b, { t: 'detach', id: term });
  const back = await waitFor(a2, (c) => json(c, 'size'), 'size after the detach');
  check(back.cols === 100 && back.rows === 30, 'after B detaches, the size goes back to 100x30');
  reset(a2);
  input(a2, term, querySize);
  await waitFor(a2, (c) => hasText(c, 'SIZE=100x30'), 'the child size after the detach');
  ok('the child goes back to 100x30 as well');

  reset(b);
  await sleep(700);
  check(b.events.length === 0, 'a client that has detached stops receiving output');

  // --- clean up ------------------------------------------------------------
  send(a2, { t: 'kill', id: term });
  const exit = await waitFor(a2, (c) => json(c, 'exit'), 'exit');
  check(exit.id === term, `kill -> exit id=${exit.id} code=${exit.code}`);

  a2.ws.close();
  b.ws.close();
}

try {
  await main();
} catch (e) {
  bad(e.message);
}
const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
