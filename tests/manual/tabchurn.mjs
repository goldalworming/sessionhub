// How much work the tab strip does when nothing about it has changed.
//
// The strip is rebuilt whole - every tab with its listeners, and the whole
// button bar - and memory is polled every two seconds while the RAM display is
// on. This counts actual teardowns of #tabs, so it measures the DOM rather than
// the code, and stays honest if the call sites move.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1af81868-b2d4-4560-8e29-8ce58f28d35a\\scratchpad';
const BIN = 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\rebuildhome`;
const PROJ = `${SP}\\savedproj`;
const PORT = 7753;
const TOKEN = 'uji-rebuild';

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


const churn = async (seconds, label) => {
  await ev(`
    (() => {
      window.__churn = 0;
      if (window.__obs) window.__obs.disconnect();
      window.__obs = new MutationObserver((ms) => {
        for (const m of ms) if (m.target.id === 'tabs' && m.removedNodes.length) window.__churn++;
      });
      window.__obs.observe(document.getElementById('tabs'), { childList: true, subtree: false });
    })()
  `);
  await sleep(seconds * 1000);
  const n = await ev(`window.__churn`);
  console.log(`  ${label}: strip torn down ${n} times in ${seconds}s`);
  return n;
};

// The RAM display on, which is how the reporter runs it.
const memOn = await ev(`document.getElementById('mem-btn')?.className === 'on'`);
if (!memOn) { await ev(`document.getElementById('mem-btn').click()`); await sleep(600); }
check(await ev(`document.getElementById('mem-btn').className === 'on'`), 'RAM display on');

const idle = await churn(20, 'idle, nothing touched');
check(idle <= 2, `an idle strip should barely be rebuilt at all (was ${idle})`);

// Switching between tabs: the active mark moves, nothing else changes.
const before = await ev(`window.__churn`);
for (let i = 0; i < 6; i++) {
  await ev(`document.querySelectorAll('.tab')[${i % 3}].click()`);
  await sleep(400);
}
const switches = (await ev(`window.__churn`)) - before;
console.log(`  six tab switches: ${switches} teardowns`);
check(switches <= 6, `switching tabs should not rebuild the strip more than once each (was ${switches})`);

// Counting teardowns alone would pass with both features broken, so this is
// what the strip is supposed to still be doing.
const memText = () => ev(`[...document.querySelectorAll('.tab .mem')].map(x => x.textContent)`);
const shown = await memText();
console.log(`  memory shown: ${JSON.stringify(shown)}`);
check(
  shown.length === 3 && shown.every((t) => /\d/.test(t)),
  'every tab still shows a real memory figure, without the strip being rebuilt',
);
await sleep(2500);
check((await memText()).every((t) => /\d/.test(t)), 'and it is still there after the next poll');

for (const i of [2, 0, 1]) {
  await ev(`document.querySelectorAll('.tab')[${i}].click()`);
  await sleep(500);
  const want = await ev(`document.querySelectorAll('.tab')[${i}].dataset.id`);
  const got = await ev(`document.querySelector('.tab.active')?.dataset.id`);
  check(want === got, `clicking tab ${i} moves the active mark to it (${got})`);
}

// Turning the display off and on adds and removes a span in every tab, which is
// a real change and must still go through a full render.
await ev(`document.getElementById('mem-btn').click()`);
await sleep(600);
check((await memText()).length === 0, 'turning RAM off removes the figures');
await ev(`document.getElementById('mem-btn').click()`);
await sleep(2500);
check((await memText()).length === 3, 'and turning it back on brings them back');

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
await sleep(1500);
cdp.close();
process.exit(steps.every(Boolean) ? 0 : 1);
