// Driving headless Chrome over the DevTools Protocol: click a tab, make sure
// xterm really is painted and the terminal contents make it onto the screen.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const CDP = 'http://127.0.0.1:9222';
// Read from the config rather than hard-coded: the daemon's token changes, and
// a stale copy here fails as "cannot connect", which says nothing about what
// this test is actually checking.
const TOKEN = /token *= *"([^"]+)"/.exec(
  readFileSync(`${homedir()}/.sessionhub/config.toml`, 'utf8'),
)[1];
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- set up the terminal to be tested ourselves ------------------------------
{
  const app = new WebSocket(`ws://127.0.0.1:7717/ws?token=${TOKEN}`);
  app.binaryType = 'arraybuffer';
  const seen = [];
  let screen = '';
  app.onmessage = (ev) => {
    if (typeof ev.data === 'string') seen.push(JSON.parse(ev.data));
    else screen += Buffer.from(ev.data).subarray(4).toString('utf8');
  };
  await new Promise((res) => { app.onopen = res; });
  while (!seen.find((m) => m.t === 'state')) await sleep(120);
  app.send(JSON.stringify({
    t: 'spawn', project: 'C:\\data\\code\\terminal-editor2', agent: 'shell', resume: null, cols: 120, rows: 34,
  }));
  const t0 = Date.now();
  while (!/PS [A-Z]:/.test(screen) && Date.now() - t0 < 30000) await sleep(150);
  console.log('  the test terminal is ready');
  app.close();
  await sleep(500);
}

const targets = await (await fetch(`${CDP}/json`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) { console.log('  [FAIL] there is no page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP failed')); });

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function cmd(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
}
async function evaluate(expression) {
  const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

// --- load the page -----------------------------------------------------------
await cmd('Page.enable');
await evaluate(`location.href = 'http://127.0.0.1:7717/?token=${TOKEN}'`);
await sleep(4000);

check(await evaluate(`document.title === 'sessionhub'`), 'the page loads');
check(await evaluate(`typeof Terminal === 'function'`), 'xterm.js loads from /vendor (not from a CDN)');
check(await evaluate(`typeof FitAddon?.FitAddon === 'function'`), 'the fit addon loads');
check(await evaluate(`document.querySelectorAll('.project').length > 5`), 'the sidebar contains projects');

// --- click a tab -> attach -> xterm is painted -------------------------------
const tabs = await evaluate(`document.querySelectorAll('.tab').length`);
check(tabs >= 1, `there are ${tabs} live terminal tabs`);
await evaluate(`document.querySelector('.tab').click()`);
await sleep(3000);

check(await evaluate(`document.querySelectorAll('.xterm').length === 1`), 'xterm is created after the tab is clicked');
check(await evaluate(`document.querySelectorAll('.xterm-screen').length === 1`), 'the xterm screen is mounted');
check(await evaluate(`document.getElementById('empty').hidden === true`), 'the "pick a session" message goes away once a terminal is open');

const text = await evaluate(`
  (() => {
    const rows = document.querySelectorAll('.xterm-rows > div');
    return Array.from(rows).map(r => r.textContent).join('\\n');
  })()
`);
const trimmed = (text || '').replace(/\s+/g, ' ').trim();
console.log(`  screen contents (120 chars): ${trimmed.slice(0, 120)}`);
check(trimmed.length > 20, 'the ring buffer contents are replayed onto the screen, not an empty terminal');

// The grid must not simply follow the size of one client: the server takes the
// minimum across all clients. What is tested is that loop — shrink the window
// and the grid has to shrink too, because the server is the one that orders it.
const rowsOf = () => evaluate(`document.querySelectorAll('.xterm-rows > div').length`);
const rows0 = await rowsOf();
check(rows0 > 5, `the grid is filled with ${rows0} rows (the terminal was created with 30 rows, this window is shorter)`);

await cmd('Emulation.setDeviceMetricsOverride', { width: 900, height: 380, deviceScaleFactor: 1, mobile: false });
await evaluate(`window.dispatchEvent(new Event('resize'))`);
await sleep(2000);
const rows1 = await rowsOf();
check(rows1 < rows0, `the window is shrunk -> the server lowers the effective size (${rows0} -> ${rows1} rows)`);
await cmd('Emulation.clearDeviceMetricsOverride');
await evaluate(`window.dispatchEvent(new Event('resize'))`);
await sleep(1500);

// --- the RAM button ----------------------------------------------------------
// Start from the off state so that the first click really does switch it on.
await evaluate(`localStorage.setItem('sh.mem','0')`);
await evaluate(`location.reload()`);
await sleep(3500);
await evaluate(`document.querySelector('.tab').click()`);
await sleep(1500);
check(await evaluate(`document.querySelector('.tab .mem') === null`), 'the memory figure is hidden while the button is off');

await evaluate(`document.querySelector('#mem-btn').click()`);
await sleep(2500);
const memText = await evaluate(`document.querySelector('.tab .mem')?.textContent || ''`);
console.log(`  the tab shows: "${memText}"`);
check(/\d/.test(memText) && /(B|KB|MB|GB)/.test(memText), 'the RAM button shows a memory figure on the tab');
check(await evaluate(`document.querySelector('#mem-btn').classList.contains('on')`), 'the RAM button marks itself as active');

// After a reload the figure has to come back on its own: the button state is
// persisted and the periodic sampling starts up again as well.
await evaluate(`location.reload()`);
await sleep(4000);
const memAfterReload = await evaluate(`document.querySelector('.tab .mem')?.textContent || ''`);
check(/\d/.test(memAfterReload), `the memory figure comes back after a reload without being clicked again ("${memAfterReload}")`);

await evaluate(`document.querySelector('#mem-btn').click()`);
await sleep(500);
check(await evaluate(`document.querySelector('.tab .mem') === null`), 'clicking again hides the memory figure');

// --- the sidebar can be dragged and is persisted -----------------------------
await evaluate(`localStorage.setItem('sh.sidebar.width','320')`);
await evaluate(`location.reload()`);
await sleep(3500);
check(await evaluate(`document.getElementById('sidebar').style.width === '320px'`), 'the sidebar width is restored from localStorage');

// --- Ctrl+V has to stay the browser's ----------------------------------------
// xterm's default is to read Ctrl+V as the control byte 0x16 and preventDefault
// the key. That kills the browser's own paste, and with it the only event that
// can read the clipboard — so pasting into the terminal silently did nothing on
// a desktop. `attachCustomKeyEventHandler` in app.js hands the key back.
//
// What is asserted is the signal that broke: the key comes out unprevented, and
// a paste event follows. The clipboard's CONTENT cannot be checked here — a
// headless browser has its own, permanently empty, clipboard.
await evaluate(`
  window.__pasteSeen = 0;
  document.addEventListener('paste', () => { window.__pasteSeen++; }, true);
  window.__vPrevented = null;
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      setTimeout(() => { window.__vPrevented = e.defaultPrevented; }, 0);
    }
  }, true);
  const t = document.querySelector('.host:not([hidden]) .xterm-helper-textarea');
  if (t) t.focus();
  true
`);
await cmd('Input.dispatchKeyEvent', {
  type: 'keyDown', modifiers: 2, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86,
  commands: ['paste'],
});
await cmd('Input.dispatchKeyEvent', {
  type: 'keyUp', modifiers: 2, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86,
});
await sleep(800);
check(
  (await evaluate(`window.__vPrevented`)) === false,
  'Ctrl+V is left to the browser, not swallowed as the control byte ^V',
);
check(
  (await evaluate(`window.__pasteSeen`)) > 0,
  'so a paste event actually reaches the terminal',
);

// --- console errors ----------------------------------------------------------
const errs = await evaluate(`window.__errs ? window.__errs.length : 0`);
check(errs === 0, 'the page recorded no errors');

ws.close();
const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
