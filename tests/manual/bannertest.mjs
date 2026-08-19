// The "connection lost" banner in the UI, tested by genuinely stopping the daemon.

import { execFileSync, spawn } from 'node:child_process';

const EXE = 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome';
const CDP = 'http://127.0.0.1:9222';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`${CDP}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => { ws.onopen = res; });
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

await evaluate(`location.href = 'http://127.0.0.1:7719/?token=uji-token-rahasia-untuk-langkah-satu-abc123'`);
await sleep(4000);
check(await evaluate(`document.getElementById('banner').hidden`), 'the banner stays hidden while things are healthy');
const projectsBefore = await evaluate(`document.querySelectorAll('.project').length`);
check(projectsBefore > 5, `sidebar is populated (${projectsBefore} projects)`);

// --- stop the daemon ---------------------------------------------------------
console.log('  stopping the daemon…');
execFileSync(EXE, ['stop', '--home', HOME], { stdio: 'ignore' });
await sleep(3000);

const text = await evaluate(`document.getElementById('banner').textContent`);
check(!(await evaluate(`document.getElementById('banner').hidden`)), `the banner appears: "${text}"`);
check(/reconnecting/i.test(text || ''), 'the banner says that it is reconnecting');

// --- start it up again -------------------------------------------------------
console.log('  starting the daemon up again…');
spawn(EXE, ['start', '--home', HOME], { detached: true, stdio: 'ignore' }).unref();

let back = false;
const t0 = Date.now();
while (Date.now() - t0 < 30000) {
  if (await evaluate(`document.getElementById('banner').hidden === true`)) { back = true; break; }
  await sleep(500);
}
check(back, `the banner goes away by itself once the daemon is back (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// A freshly woken daemon needs a few seconds to scan; during that time the sidebar
// must say "scanning" rather than give misleading guidance.
const scanningHint = await evaluate(`document.querySelector('.empty-hint')?.textContent || ''`);
check(
  scanningHint === '' || /Scanning/.test(scanningHint),
  `gives no misleading guidance while scanning ("${scanningHint}")`
);

let projectsAfter = 0;
const t1 = Date.now();
while (Date.now() - t1 < 20000) {
  projectsAfter = await evaluate(`document.querySelectorAll('.project').length`);
  if (projectsAfter > 5) break;
  await sleep(500);
}
check(projectsAfter > 5, `sidebar is populated again without a refresh (${projectsAfter} projects, ${((Date.now() - t1) / 1000).toFixed(1)}s)`);
check(
  await evaluate(`document.querySelectorAll('.xterm').length === 0`),
  'terminals that no longer exist are cleaned up, not left behind as ghost views'
);
check(
  await evaluate(`document.getElementById('empty').hidden === false`),
  'back to the empty state with guidance, not an error message'
);

ws.close();
const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
