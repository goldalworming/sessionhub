// Closing a tab takes it out of the strip.
//
// Reported: pressing ✕ on a tab appeared to do nothing. It did do something —
// the view was closed and the terminal detached — but the strip lists every live
// terminal, so the tab came straight back. Closing a tab that will not close is
// worse than not offering to close it.
//
// What must stay true is the part the ✕ has always promised: the process keeps
// running. So this checks both halves, because a fix that hides the tab by
// killing the terminal would pass a naive "is the tab gone" test.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1af81868-b2d4-4560-8e29-8ce58f28d35a\\scratchpad';
const BIN = 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\closehome`;
const PROJ = `${SP}\\savedproj`;
const PORT = 7749;
const TOKEN = 'uji-close-tab';

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

// --- close one -------------------------------------------------------------
await ev(`document.querySelectorAll('.tab')[1].querySelector('.x').click()`);
await sleep(1200);
const after = await tabs();
console.log(`    tabs now: ${after.length}`);
check(after.length === 2, 'closing a tab takes it out of the strip');
check(
  (await status()).terminals_alive === 3,
  'and the process keeps running — that is what ✕ has always promised',
);

// The sidebar is where it still shows, so it is not lost.
check(
  await ev(`document.querySelectorAll('#tree [data-tid]').length >= 3`),
  'it is still listed in the sidebar, so it can be found again',
);

// --- it stays closed -------------------------------------------------------
// A state broadcast rebuilds the strip from every live terminal. Without the
// tab being remembered as closed, this is exactly where it came back.
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
const grown = await tabs();
check(grown.length === 3, `a new terminal adds its own tab, the closed one stays away (${grown.length})`);
check((await status()).terminals_alive === 4, 'four processes running, three tabs');

// --- clicking it in the sidebar brings it back ------------------------------
await ev(`
  (() => {
    const shown = new Set([...document.querySelectorAll('.tab')].map(t => t.dataset.id));
    const row = [...document.querySelectorAll('#tree [data-tid]')]
      .find(r => !shown.has(r.dataset.tid));
    row.click();
  })()
`);
await sleep(2000);
const back = await tabs();
check(back.length === 4, `opening it from the sidebar brings its tab back (${back.length})`);

// --- the grid does not undo the tidying -------------------------------------
await ev(`document.querySelectorAll('.tab')[0].querySelector('.x').click()`);
await sleep(1200);
check((await tabs()).length === 3, 'close one again');
await ev(`
  [...document.querySelectorAll('#tabs button')].find(b => /Tabs|Grid/.test(b.textContent))?.click()
`);
await sleep(2500);
const inGrid = await tabs();
check(
  inGrid.length === 3,
  `switching to grid does not reopen it — that would undo the tidying (${inGrid.length})`,
);
check((await status()).terminals_alive === 4, 'and nothing was killed along the way');

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
await sleep(1500);
cdp.close();
process.exit(steps.every(Boolean) ? 0 : 1);
