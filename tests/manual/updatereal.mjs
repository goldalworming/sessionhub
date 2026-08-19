// Does the update button actually install the newest release?
//
// The binary under test is DOWNLOADED FROM THE RELEASE PAGE — the same artifact
// anyone else gets — and left to update itself through the UI. Nothing here is
// mocked: the check is a real request to the real API, the download is the real
// asset, and the swap replaces the running program.
//
// Two things only this can catch, which no unit test can:
//   - assets named something the updater does not recognise, and
//   - a daemon that swaps its binary correctly and then fails to come back.
// Both have happened.
//
// Usage: node updatereal.mjs <from-version> <to-version>
//   e.g. node updatereal.mjs 0.0.2 0.0.3

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';

const FROM = process.argv[2] || '0.0.2';
const TO = process.argv[3] || '0.0.3';
const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1af81868-b2d4-4560-8e29-8ce58f28d35a\\scratchpad';
const DIR = `${SP}\\u3bin`;
const BIN = `${DIR}\\sessionhubd.exe`;
const HOME = `${SP}\\u3home`;
const PORT = 7739;
const TOKEN = 'uji-update-nyata';

const steps = [];
const check = (c, m) => {
  steps.push(c);
  console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const version = async () => {
  try {
    return (await (await fetch(`http://127.0.0.1:${PORT}/api/status?token=${TOKEN}`)).json()).version;
  } catch {
    return null;
  }
};

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
writeFileSync(
  `${HOME}\\.sessionhub\\config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\n`,
);

spawn(BIN, ['start', '--home', HOME], { detached: true, stdio: 'ignore' }).unref();
for (let i = 0; i < 40 && !(await version()); i++) await sleep(500);
const before = await version();
check(before === FROM, `the released ${FROM} binary is running (${before})`);

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
const waitFor = async (expr, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(expr)) return true;
    await sleep(300);
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
await sleep(5000);
await ev(`document.getElementById('backdrop')?.click()`);
await sleep(400);
await ev(`document.getElementById('settings-btn')?.click() || document.querySelector('#sfoot button')?.click()`);
await sleep(700);
await ev(`document.querySelector('#settings .sitem[data-section="update"]').click()`);
await sleep(500);
await ev(`document.getElementById('update-check').click()`);

check(
  await waitFor(`!!document.getElementById('update-apply')`, 30000),
  'the release page is read and a newer build offered',
);
const panel = (await ev(`document.querySelector('#settings .sec.update').textContent`)) || '';
console.log(`    panel: ${panel.replace(/\s+/g, ' ').slice(0, 160)}`);
check(panel.includes(TO), `and the panel names ${TO}`);

await ev(`document.getElementById('update-apply').click()`);
await sleep(300);
check(
  /Click again/.test(await ev(`document.getElementById('update-apply').textContent`)),
  'the first click only arms it',
);
check((await version()) === FROM, 'and nothing is installed yet');

await ev(`document.getElementById('update-apply').click()`);
console.log('    downloading and swapping…');

let after = null;
for (let i = 0; i < 150; i++) {
  await sleep(1000);
  after = await version();
  if (after && after !== FROM) break;
}
check(after === TO, `it comes back as the new release: ${before} → ${after}`);
check(
  existsSync(`${DIR}\\sessionhubd.old.exe`),
  'the binary it replaced is kept alongside, so a bad update can be undone',
);
check(!existsSync(`${DIR}\\sessionhub-swap.ps1`), 'and the swap script cleans itself up');
const size = existsSync(BIN) ? statSync(BIN).size : 0;
check(size > 7_000_000, `the installed binary is a real one (${(size / 1048576).toFixed(1)} MB)`);

// Checking again on the new build must say there is nothing to do — otherwise
// it would offer to reinstall what it just installed, forever.
await ev(`location.reload()`);
await sleep(5000);
await ev(`document.getElementById('backdrop')?.click()`);
await sleep(400);
await ev(`document.getElementById('settings-btn')?.click() || document.querySelector('#sfoot button')?.click()`);
await sleep(700);
await ev(`document.querySelector('#settings .sitem[data-section="update"]').click()`);
await sleep(500);
await ev(`document.getElementById('update-check').click()`);
await waitFor(`/newest release|is available/.test(document.querySelector('#settings .sec.update')?.textContent || '')`, 30000);
const again = (await ev(`document.querySelector('#settings .sec.update').textContent`)) || '';
check(/newest release/.test(again), 'and once installed it stops offering itself');
check(
  !(await ev(`!!document.getElementById('update-apply')`)),
  'with no button to press a second time',
);

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
await sleep(2000);
cdp.close();
process.exit(steps.every(Boolean) ? 0 : 1);
