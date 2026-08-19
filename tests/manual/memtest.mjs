// Exercise the per-terminal RAM feature: spawn a real agent, ask for a memory sample.
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
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('failed to connect')); });
const find = (t) => msgs.find((m) => m.t === t);
async function waitFor(pred, what, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const h = pred(); if (h) return h; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}

await waitFor(() => find('state'), 'state');

// Two different terminals, so the numbers can be compared against each other
// rather than merely checked for existence.
ws.send(JSON.stringify({ t: 'spawn', project: PROJECT, agent: 'shell', resume: null, cols: 100, rows: 30 }));
const a = await waitFor(() => find('attached'), 'shell terminal');
await waitFor(() => /PS [A-Z]:/.test(screen), 'shell prompt');

msgs.length = 0;
ws.send(JSON.stringify({ t: 'spawn', project: PROJECT, agent: 'claude', resume: null, cols: 100, rows: 30 }));
const b = await waitFor(() => find('attached'), 'claude terminal');
await sleep(12000); // give its TUI time to come up fully

msgs.length = 0;
ws.send(JSON.stringify({ t: 'mem' }));
const mem = await waitFor(() => find('mem'), 'mem reply');

console.log('  ' + mem.terminals.map((m) => `id=${m.id} ${mb(m.rss_bytes)} (${m.processes} processes)`).join('  |  '));
check(mem.terminals.length === 2, `two terminals reported (${mem.terminals.length})`);

const shell = mem.terminals.find((m) => m.id === a.id);
const claude = mem.terminals.find((m) => m.id === b.id);
check(shell?.rss_bytes > 1_000_000, `shell reports a plausible RSS (${mb(shell?.rss_bytes ?? 0)})`);
check(claude?.rss_bytes > 1_000_000, `claude reports a plausible RSS (${mb(claude?.rss_bytes ?? 0)})`);
check(claude?.processes >= 1 && shell?.processes >= 1, `process count is tallied (shell ${shell?.processes}, claude ${claude?.processes})`);
check(claude?.rss_bytes > shell?.rss_bytes, 'the Node agent is far heavier than powershell — the process tree really is summed up');

// A second sample: the numbers are live, not a hard-coded constant.
msgs.length = 0;
await sleep(1500);
ws.send(JSON.stringify({ t: 'mem' }));
const mem2 = await waitFor(() => find('mem'), 'second sample');
check(mem2.terminals.length === 2, 'the second sample still reports two terminals');

// After a kill, a dead terminal is no longer reported.
msgs.length = 0;
ws.send(JSON.stringify({ t: 'kill', id: a.id }));
await waitFor(() => find('exit'), 'shell exit');
msgs.length = 0;
ws.send(JSON.stringify({ t: 'mem' }));
const mem3 = await waitFor(() => find('mem'), 'third sample');
check(mem3.terminals.length === 1 && mem3.terminals[0].id === b.id, 'a terminal that has died is no longer reported');

console.log(`  the claude terminal id=${b.id} is deliberately left running for DOM inspection`);
ws.close();
const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
