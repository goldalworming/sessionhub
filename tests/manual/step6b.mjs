// Ctrl+W (detach, the terminal stays alive) and Ctrl+Shift+W (kill, with a
// confirmation). Both touch daemon state, so they are checked from two sides:
// the DOM and the state the server sends.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const CDP = 'http://127.0.0.1:9222';
// Read from the config rather than hard-coded: the daemon's token changes, and
// a stale copy here fails as "cannot connect", which says nothing about what
// this test is actually checking.
const TOKEN = /token *= *"([^"]+)"/.exec(
  readFileSync(`${homedir()}/.sessionhub/config.toml`, 'utf8'),
)[1];
const URL = `http://127.0.0.1:7717/?token=${TOKEN}`;
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- a state observer on the daemon side -------------------------------------
const spy = new WebSocket(`ws://127.0.0.1:7717/ws?token=${TOKEN}`);
const states = [];
spy.onmessage = (e) => { if (typeof e.data === 'string') { const m = JSON.parse(e.data); if (m.t === 'state') states.push(m); } };
await new Promise((r) => { spy.onopen = r; });
while (!states.length) await sleep(100);

const aliveIds = () => {
  const last = states[states.length - 1];
  return last.terminals.filter((t) => t.alive).map((t) => t.id);
};
const refreshState = async () => {
  const n = states.length;
  spy.send(JSON.stringify({ t: 'list' }));
  const until = Date.now() + 5000;
  while (states.length === n && Date.now() < until) await sleep(80);
};

// Make sure there is one terminal to play with.
if (aliveIds().length === 0) {
  spy.send(JSON.stringify({
    t: 'spawn', project: 'C:\\data\\code\\terminal-editor2', agent: 'shell', resume: null, cols: 100, rows: 30,
  }));
  await sleep(4000);
  await refreshState();
}
console.log(`  live terminals: ${aliveIds().join(', ')}`);

// --- drive the page ----------------------------------------------------------
const targets = await (await fetch(`${CDP}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cmd = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
};
const evaluate = async (e) =>
  (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))
    .result?.result?.value;
async function press(key, { ctrl = false, shift = false } = {}) {
  let modifiers = 0;
  if (ctrl) modifiers |= 2;
  if (shift) modifiers |= 8;
  const base = { modifiers, key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) };
  await cmd('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

await evaluate(`location.href = '${URL}'`);
await sleep(4500);
await evaluate(`document.querySelector('.tab').click()`);
await sleep(2500);

const targetId = Number(await evaluate(`document.querySelector('.tab.active')?.dataset.id`));
check(await evaluate(`document.querySelectorAll('.xterm').length >= 1`), `terminal ${targetId} is open`);

// --- Ctrl+W: close the view, the process stays alive -------------------------
await press('w', { ctrl: true });
await sleep(1500);
check(await evaluate(`document.querySelectorAll('.xterm').length === 0`), 'Ctrl+W closes the terminal view');
await refreshState();
check(aliveIds().includes(targetId), `terminal ${targetId} is STILL ALIVE in the daemon — a detach, not a kill`);
check(
  await evaluate(`[...document.querySelectorAll('.tab')].some(t => t.dataset.id === '${targetId}')`),
  'its tab stays around so it can be opened again'
);

// --- Ctrl+Shift+W: kill, but only after it has been confirmed ----------------
await evaluate(`document.querySelector('.tab').click()`);
await sleep(2000);

// The confirmation is declined first: nothing may die.
await evaluate(`window.__tanya = null; window.confirm = (m) => { window.__tanya = m; return false; }`);
await press('w', { ctrl: true, shift: true });
await sleep(1500);
const confirmMsg = await evaluate(`window.__tanya`);
check(!!confirmMsg, `the confirmation is asked for first: "${confirmMsg}"`);
await refreshState();
check(aliveIds().includes(targetId), 'declining the confirmation kills nothing');

// Now it is accepted.
await evaluate(`window.confirm = () => true`);
await press('w', { ctrl: true, shift: true });
await sleep(3000);
await refreshState();
check(!aliveIds().includes(targetId), `terminal ${targetId} stops once the confirmation is accepted`);

spy.close();
ws.close();
const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
