// A terminal that dies while a tab's own WebSocket stays open (no reconnect)
// must not leave that tab staring at a blank, un-switched pane.
//
// Reported: 127.0.0.1 showed an empty stage for a terminal that had just been
// killed and replaced, while a freshly-opened tab (which reconnected fresh)
// showed the new one correctly. Root cause: `onState` only reconciled the
// client's terminal list against the server's on an actual reconnect
// (`reattachAll`, gated by `pendingReattach`) — an ordinary state broadcast
// (the terminal simply dying) never pruned the dead entry or moved `activeId`
// off it. Fixed by running that reconciliation (`pruneDeadTerminals`) on every
// state update, not only a reconnect.
//
// This checks the client survives a kill of the *active* terminal with zero
// reconnects: no navigation happens anywhere in this script.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\deadtermhome`;
const PROJ = `${SP}\\deadtermproj`;
const PORT = 7753;
const TOKEN = 'uji-dead-term';

const steps = [];
const check = (c, m) => {
  steps.push(c);
  console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/api/status?token=${TOKEN}`)).json();
  } catch {
    return null;
  }
};

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(
  `${HOME}\\.sessionhub\\config.toml`,
  [
    `port = ${PORT}`,
    'lan_access = false',
    `token = "${TOKEN}"`,
    `projects = ["${PROJ.split('\\').join('\\\\')}"]`,
    '',
  ].join('\n'),
);
spawn(BIN, ['start', '--home', HOME], { detached: true, stdio: 'ignore' }).unref();
for (let i = 0; i < 40 && !(await status()); i++) await sleep(500);
check(!!(await status()), `test daemon up on ${PORT}`);

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => {
  cdp.onopen = r;
});
let seq = 0;
const pending = new Map();
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const cmd = (method, params = {}) => {
  const i = ++seq;
  cdp.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pending.set(i, r));
};
const ev = async (e) =>
  (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))
    .result?.result?.value;
const waitFor = async (expr, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(expr)) return true;
    await sleep(250);
  }
  return false;
};

await cmd('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 820,
  deviceScaleFactor: 1,
  mobile: false,
});
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5500);
await ev(`document.getElementById('backdrop')?.click()`);
await sleep(400);

// Two terminals: kill the active one, the other must be what's left standing.
for (let i = 0; i < 2; i++) {
  await ev(`
    (() => {
      const row = [...document.querySelectorAll('#tree .row')]
        .find(r => (r.dataset.path || '').toLowerCase().includes('deadtermproj'));
      row.querySelector('.add').click();
    })()
  `);
  await sleep(500);
  await ev(`
    [...document.querySelectorAll('#menu > div')]
      .find(x => /terminal/i.test(x.textContent)).click()
  `);
  await sleep(2500);
}
check(await waitFor(`document.querySelectorAll('.tab').length === 2`, 20000), 'two tabs open');
check((await status()).terminals_alive === 2, 'and two processes running');

const activeId = await ev(`document.querySelector('.tab.active')?.dataset.id`);
const otherId = await ev(`
  [...document.querySelectorAll('.tab')].map(t => t.dataset.id).find(id => id !== '${activeId}')
`);
check(activeId && otherId && activeId !== otherId, `active=${activeId} other=${otherId}`);
check(
  await ev(`document.querySelectorAll('.tab.active').length === 1`),
  'exactly one tab is active before the kill',
);

// Killed from an INDEPENDENT connection — not the page's own socket — which is
// exactly what happened in the field: something else (another tab, the CLI)
// ended the terminal a tab was looking at, and that tab's own socket never
// dropped, so it never reconnected. `app.js` is an ES module: its state
// (`terms`, `activeId`, `conn`) is not reachable from outside, so everything
// below is checked the same way a real user would see it — through the DOM.
const killer = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => { killer.onopen = r; });
killer.send(JSON.stringify({ t: 'kill', id: Number(activeId) }));
await sleep(500);
killer.close();

check(
  await waitFor(`document.querySelector('.tab.active')?.dataset.id === '${otherId}'`, 8000),
  'the surviving tab becomes active — with no reconnect anywhere in this script',
);
check(
  await ev(`document.querySelectorAll('.tab.active').length === 1`),
  'still exactly one active tab (not zero, not both)',
);
check(
  await ev(`
    (() => {
      const dead = document.querySelector('.tab[data-id="${activeId}"]');
      return !dead || (!dead.classList.contains('active'));
    })()
  `),
  'the killed tab is not the active one any more',
);

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
await sleep(1500);
cdp.close();
process.exit(steps.every(Boolean) ? 0 : 1);
