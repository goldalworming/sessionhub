// Exercise the reconnect module (web/conn.js) directly against a real daemon.
// Chrome's offline emulation does not touch loopback connections, so the
// disconnects are performed here for real.

import { readFileSync } from 'node:fs';

globalThis.location = { protocol: 'http:', host: '127.0.0.1:7719' };

const { Conn } = await import('file:///C:/data/code/terminal-editor2/sessionhubd/web/conn.js');

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read from the config rather than hard-coded: the daemon's token changes, and
// a stale copy here does not fail as "wrong token" — it hangs until the wait
// for the first connection times out, which says nothing about reconnecting.
const CFG = 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome\\.sessionhub\\config.toml';
const conn = new Conn(/token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1]);
const events = [];
let states = 0;
conn.on.onStatus = (k) => events.push(k);
conn.on.onState = () => (states += 1);
conn.connect();

const waitFor = async (pred, what, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(80); }
  throw new Error(`timed out waiting for ${what}`);
};

await waitFor(() => events.includes('open'), 'first connection');
await waitFor(() => states >= 1, 'first state');
check(true, 'connected and received a state');
check(conn.delay === 500, 'backoff starts at 0.5s');

// --- forced disconnect -------------------------------------------------------
const opensBefore = events.filter((e) => e === 'open').length;
const statesBefore = states;
conn.ws.close();

await waitFor(() => events.includes('lost'), 'disconnect detection');
check(true, 'the disconnect is detected (onStatus "lost")');

const t0 = Date.now();
await waitFor(() => events.filter((e) => e === 'open').length > opensBefore, 'reconnect');
const took = Date.now() - t0;
check(took < 3000, `reconnects by itself within ${took}ms, with no intervention`);

await waitFor(() => states > statesBefore, 'state after the reconnect');
check(true, 'the server re-sends the state once reconnected');
check(conn.delay === 500, 'the backoff drops back to 0.5s after a success');

// --- repeated failures: the backoff must grow while connecting keeps failing --
const conn2 = new Conn('token');
globalThis.location.host = '127.0.0.1:9';  // closed port
const seen = [];
conn2.on.onStatus = (k) => seen.push(`${k}:${conn2.delay}`);
conn2.connect();
await sleep(4000);
const delays = seen.filter((s) => s.startsWith('lost')).map((s) => Number(s.split(':')[1]));
console.log(`  successive backoffs: ${delays.join(', ')}`);
check(delays.length >= 3, `retries several times (${delays.length} times)`);
check(
  delays.every((d, i) => i === 0 || d >= delays[i - 1]),
  'the interval grows instead of flooding the server'
);
check(Math.max(...delays) <= 8000, 'the interval stops growing at 8s');

conn.closedByUs = true;
conn.ws.close();
conn2.closedByUs = true;
try { conn2.ws.close(); } catch {}

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
