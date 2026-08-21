// A saved terminal starts with the daemon.
//
// Reported: "the terminal set to run immediately turns out not to run
// immediately - it has to be opened first and its tab appear". That was true
// and by design: nothing started a saved terminal at boot.
//
// The claim being checked here is the strict one. Not "it runs once you look at
// it" - that already worked - but that the command has run before any browser
// has connected at all. So the first thing this does is prove the effect on
// disk with no client in existence, and only then opens a page.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1af81868-b2d4-4560-8e29-8ce58f28d35a\\scratchpad';
const BIN = 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\autohome`;
const PROJ = `${SP}\\autoproj`;
const PORT = 7755;
const TOKEN = 'uji-autostart';
const STAMP = `${PROJ}\\it-ran.txt`;
const LATER = `${PROJ}\\not-me.txt`;

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
const stop = () => spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });

rmSync(HOME, { recursive: true, force: true });
rmSync(PROJ, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });

// Two scripts, so the run is visible on disk rather than only on a screen.
writeFileSync(`${PROJ}\\ran.bat`, '@echo off\r\necho ran > "%~dp0it-ran.txt"\r\n');
writeFileSync(`${PROJ}\\later.bat`, '@echo off\r\necho ran > "%~dp0not-me.txt"\r\n');

const esc = (p) => p.split('\\').join('\\\\');
writeFileSync(
  `${HOME}\\.sessionhub\\config.toml`,
  [
    `port = ${PORT}`,
    'lan_access = false',
    `token = "${TOKEN}"`,
    `projects = ["${esc(PROJ)}"]`,
    '',
    '[[saved]]',
    'name = "the-service"',
    `project = "${esc(PROJ)}"`,
    'agent = "terminal"',
    'command = "ran.bat"',
    '',
    // Written with no autostart key at all: this is what every entry saved
    // before the setting existed looks like, and it must come up.
    '[[saved]]',
    'name = "older-entry"',
    `project = "${esc(PROJ)}"`,
    'agent = "terminal"',
    'command = "later.bat"',
    '',
  ].join('\n'),
);

spawn(BIN, ['start', '--home', HOME], { detached: true, stdio: 'ignore' }).unref();
for (let i = 0; i < 40 && !(await status()); i++) await sleep(500);
check(!!(await status()), `test daemon up on ${PORT}`);

// No browser has been anywhere near this daemon.
for (let i = 0; i < 30 && !(existsSync(STAMP) && existsSync(LATER)); i++) await sleep(500);
check(existsSync(STAMP), 'the saved command ran without anybody opening a tab');
check(existsSync(LATER), 'and so did an entry saved before autostart existed');
check((await status()).terminals_alive === 2, 'both are running as terminals');

// The tab appears when a page finally connects - it is not created by looking.
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
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

await cmd('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 820,
  deviceScaleFactor: 1,
  mobile: false,
});
await ev(`localStorage.clear()`);
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(6000);
await ev(`document.getElementById('backdrop')?.click()`);
await sleep(600);
const names = await ev(`[...document.querySelectorAll('.tab .tname')].map(x => x.textContent)`);
console.log(`    tabs: ${JSON.stringify(names)}`);
check(
  names.length === 2 && names.join(' ').includes('the-service'),
  'a page that connects afterwards finds them already running, under their names',
);

// --- the save dialog asks -------------------------------------------------
// Not everything worth naming is worth starting. Leaving that to be discovered
// later on a row means every terminal anyone names is a service until they find
// the switch, so the dialog asks at the moment you actually know the answer.
await ev(`
  (() => {
    const row = [...document.querySelectorAll('#tree .row')]
      .find(r => (r.dataset.path || '').toLowerCase().includes('autoproj'));
    row.querySelector('.add').click();
  })()
`);
await sleep(500);
await ev(`
  [...document.querySelectorAll('#menu > div')].find(x => /terminal/i.test(x.textContent)).click()
`);
await sleep(2500);
await ev(`
  (() => {
    const shown = new Set([...document.querySelectorAll('.tab')].map(t => t.dataset.id));
    const rows = [...document.querySelectorAll('#tree [data-tid]')];
    const row = rows[rows.length - 1];
    row.querySelector('.act-save').click();
  })()
`);
await sleep(1200);
check(await ev(`!document.getElementById('ask').hidden`), 'the save dialog opens');
check(
  await ev(`!document.querySelector('#ask .acheck').hidden`),
  'and it asks about autostart',
);
check(
  await ev(`document.querySelector('#ask .tick').checked`),
  'ticked by default - naming a shell usually means you want it up',
);
await ev(`document.querySelector('#ask .tick').click()`);
await ev(`document.querySelector('#ask input').value = 'hands-off'`);
await ev(`document.querySelector('#ask .ok').click()`);
await sleep(1500);
{
  const text = readFileSync(`${HOME}\\.sessionhub\\config.toml`, 'utf8');
  const block = text.split('[[saved]]').find((b) => b.includes('hands-off')) || '';
  check(/autostart = false/.test(block), 'unticking it is what gets written');
}


// --- the switch has to be reachable while it is running --------------------
// The saved row carries the same switch, but that row only exists while nothing
// is running under the name - and something that starts with the daemon is
// running nearly always. Without the tab menu the switch could only be reached
// by first stopping the thing you want to keep running.
await ev(`
  document.querySelector('.tab').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 40 }),
  )
`);
await sleep(600);
const menu = await ev(`[...document.querySelectorAll('#menu > div')].map(x => x.textContent)`);
console.log(`    tab menu: ${JSON.stringify(menu)}`);
check(
  menu.some((x) => /Autostart with sessionhub/.test(x)),
  'the running terminal offers the switch in its tab menu',
);
await ev(`
  [...document.querySelectorAll('#menu > div')]
    .find(x => /Autostart with sessionhub/.test(x.textContent)).click()
`);
await sleep(1200);
check(
  /autostart = false/.test(readFileSync(`${HOME}\\.sessionhub\\config.toml`, 'utf8')),
  'and using it writes the change through to config.toml',
);
// Put it back: the rest of this turns the OTHER one off.
await ev(`
  (async () => {
    const ws = new WebSocket('ws://127.0.0.1:${PORT}/ws?token=${TOKEN}');
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({
      t: 'set_autostart', project: ${JSON.stringify(PROJ)}, name: 'the-service', on: true,
    }));
    await new Promise((r) => setTimeout(r, 800));
    ws.close();
  })()
`);
await sleep(1500);


// --- turning it off -------------------------------------------------------
// The control is on the saved row, which only shows when nothing is running
// under that name - so this goes through the message the row sends.
await ev(`
  (async () => {
    const ws = new WebSocket('ws://127.0.0.1:${PORT}/ws?token=${TOKEN}');
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({
      t: 'set_autostart', project: ${JSON.stringify(PROJ)}, name: 'older-entry', on: false,
    }));
    await new Promise((r) => setTimeout(r, 800));
    ws.close();
  })()
`);
await sleep(1500);
const written = readFileSync(`${HOME}\\.sessionhub\\config.toml`, 'utf8');
check(/autostart = false/.test(written), 'turning it off is written to config.toml');

// --- and the next start honours it ----------------------------------------
stop();
for (let i = 0; i < 30 && (await status()); i++) await sleep(500);
rmSync(STAMP, { force: true });
rmSync(LATER, { force: true });
spawn(BIN, ['start', '--home', HOME], { detached: true, stdio: 'ignore' }).unref();
for (let i = 0; i < 40 && !(await status()); i++) await sleep(500);
for (let i = 0; i < 20 && !existsSync(STAMP); i++) await sleep(500);
check(existsSync(STAMP), 'the one still set to start comes back up');
await sleep(3000);
check(!existsSync(LATER), 'the one turned off stays down - that is the whole point of the switch');
check((await status()).terminals_alive === 1, 'exactly one terminal running');

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
stop();
await sleep(1500);
cdp.close();
process.exit(steps.every(Boolean) ? 0 : 1);
