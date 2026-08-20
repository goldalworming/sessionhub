// The close-tab fix passed its own test, and the report says it still does not
// work in the app. So the first test exercises a gesture the user does not make.
// This tries the ones it skipped: the ACTIVE tab, Ctrl+W, the LAST tab, a state
// broadcast afterwards, and grid layout.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1af81868-b2d4-4560-8e29-8ce58f28d35a\\scratchpad';
const BIN = 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\close2home`;
const PROJ = `${SP}\\savedproj`;
const PORT = 7751;
const TOKEN = 'uji-close-tab-2';

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
const tabs = () => ev(`[...document.querySelectorAll('.tab .tname')].map(x => x.textContent)`);

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

// Three terminals, so closing one leaves something behind to check.
for (let i = 0; i < 3; i++) {
  await ev(`
    (() => {
      const row = [...document.querySelectorAll('#tree .row')]
        .find(r => (r.dataset.path || '').toLowerCase().includes('savedproj'));
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
check(await waitFor(`document.querySelectorAll('.tab').length === 3`, 20000), 'three tabs open');
check((await status()).terminals_alive === 3, 'and three processes running');


const tabIds = () => ev(`[...document.querySelectorAll('.tab')].map(x => x.dataset.id)`);
const activeTab = () => ev(`document.querySelector('.tab.active')?.dataset.id ?? null`);
async function newTerminal() {
  await ev(`
    (() => {
      const row = [...document.querySelectorAll('#tree .row')]
        .find(r => (r.dataset.path || '').toLowerCase().includes('savedproj'));
      row.querySelector('.add').click();
    })()
  `);
  await sleep(500);
  await ev(`[...document.querySelectorAll('#menu > div')].find(x => /terminal/i.test(x.textContent)).click()`);
  await sleep(2500);
}

// --- 1. the ACTIVE tab, by its close mark -----------------------------------
const act = await activeTab();
await ev(`document.querySelector('.tab.active .x').click()`);
await sleep(1500);
let now = await tabIds();
check(!now.includes(act) && now.length === 2, `closing the ACTIVE tab removes it (${now.length} left)`);

// --- 2. Ctrl+W --------------------------------------------------------------
const act2 = await activeTab();
for (const type of ['keyDown', 'keyUp']) {
  await cmd('Input.dispatchKeyEvent', {
    type, modifiers: 2, key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87,
  });
}
await sleep(1500);
now = await tabIds();
check(!now.includes(act2) && now.length === 1, `Ctrl+W removes the tab too (${now.length} left)`);

// --- 3. the LAST tab --------------------------------------------------------
await ev(`document.querySelector('.tab .x').click()`);
await sleep(1500);
now = await tabIds();
check(now.length === 0, `closing the last tab leaves the strip empty (${now.length})`);
check(await ev(`!document.getElementById('empty').hidden`), 'and the stage offers to pick a session');
check((await status()).terminals_alive === 3, 'all three processes still running');

// --- 4. a state broadcast must not bring them back --------------------------
await newTerminal();
now = await tabIds();
check(now.length === 1, `after a broadcast, only the new terminal has a tab (${now.length})`);

// --- 5. grid layout ---------------------------------------------------------
await ev(`[...document.querySelectorAll('#tabs button')].find(b => /Grid/.test(b.textContent))?.click()`);
await sleep(2500);
now = await tabIds();
check(now.length === 1, `grid does not bring the closed ones back (${now.length})`);
await ev(`document.querySelector('.tab .x').click()`);
await sleep(1500);
now = await tabIds();
check(now.length === 0, `closing a tab while in GRID removes it (${now.length})`);

// --- 6. after a RELOAD: tabs for terminals this page never opened -----------
// This is how the app is normally met: you load it and the strip already lists
// everything running, without a single view attached. It is also the case the
// first test never reached, because it opened every terminal by hand first.
await ev(`location.reload()`);
await sleep(6000);
await ev(`document.getElementById('backdrop')?.click()`);
await sleep(500);
const fresh = await tabIds();
check(fresh.length >= 3, `a reloaded page lists what is running (${fresh.length} tabs, none of them attached)`);
const victim = fresh[1];
await ev(`document.querySelectorAll('.tab')[1].querySelector('.x').click()`);
await sleep(2000);
now = await tabIds();
check(
  !now.includes(victim) && now.length === fresh.length - 1,
  `closing a tab that was never opened here removes it (${now.length} left)`,
);
await sleep(3000);
now = await tabIds();
check(!now.includes(victim), 'and it stays gone through the next broadcast');
check((await status()).terminals_alive === 4, 'nothing was killed');

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
await sleep(1500);
cdp.close();
process.exit(steps.every(Boolean) ? 0 : 1);
