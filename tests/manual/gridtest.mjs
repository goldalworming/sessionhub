// Grid mode: several terminals on screen at once, each with a PTY size of its
// own. Plus the sidebar row for a terminal that has no session yet.
//
// Needs Chrome with --remote-debugging-port=9222 and the test daemon on 7719.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 7719;
const SEP = String.fromCharCode(92);
const HOME = [
  'C:', 'Users', 'user', 'AppData', 'Local', 'Temp', 'claude',
  'C--data-code-terminal-editor2', '1c72f2cc-7025-4869-a627-df2b835ecce0',
  'scratchpad', 'fakehome',
].join(SEP);
const CFG = join(HOME, '.sessionhub', 'config.toml');
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];
const PROJECT = ['C:', 'data', 'code', 'terminal-editor2'].join(SEP);

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => { app.onopen = r; });
const sizes = new Map();
app.onmessage = (e) => {
  if (typeof e.data !== 'string') return;
  const m = JSON.parse(e.data);
  if (m.t === 'size') sizes.set(m.id, `${m.cols}x${m.rows}`);
};
await sleep(600);

// Terminals left over from an earlier test run throw the column count off.
{
  const ids = await new Promise((res) => {
    const prev = app.onmessage;
    app.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data);
      if (m.t === 'state') { app.onmessage = prev; res(m.terminals.filter((t) => t.alive).map((t) => t.id)); }
    };
    app.send(JSON.stringify({ t: 'list' }));
  });
  for (const id of ids) app.send(JSON.stringify({ t: 'kill', id }));
  if (ids.length) await sleep(1500);
}

// Four shell terminals — deliberately without a session, which tests the
// sidebar row at the same time.
for (let i = 0; i < 4; i++) {
  app.send(JSON.stringify({
    t: 'spawn', project: PROJECT, agent: 'cmd', resume: null, cols: 90, rows: 24,
  }));
  await sleep(700);
}
await sleep(1200);

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cmd = (method, params = {}) => {
  const i = ++seq;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pending.set(i, r));
};
const ev = async (e) =>
  (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))
    .result?.result?.value;
const waitFor = async (expr, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(expr)) return true;
    await sleep(200);
  }
  return false;
};

await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.setItem('sh.theme','light'); localStorage.setItem('sh.mem','0');
          localStorage.setItem('sh.files.open','0'); localStorage.setItem('sh.sidebar.hidden','0');
          localStorage.setItem('sh.layout','tabs')`);
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(4000);
check(await waitFor(`document.querySelectorAll('.tab').length >= 4`), 'four test terminals are alive');

// --- 1. a terminal without a session turns up in the sidebar -----------------
const loose = await ev(`
  [...document.querySelectorAll('#tree .session.loose')].map(r => ({
    badge: r.querySelector('.badge').textContent,
    judul: r.querySelector('.stitle').textContent,
    hidup: r.querySelector('.dot').classList.contains('live'),
  }))
`);
check(loose.length >= 4, `a terminal without a session has a row of its own in the sidebar (${loose.length})`);
check(loose.every((r) => r.badge === 'cmd'), 'it is marked with the name of its agent');
check(loose.every((r) => /^terminal \d+$/.test(r.judul)), `its title is the terminal number (${loose[0]?.judul})`);
check(loose.every((r) => r.hidup), 'their dots are filled in — they really are all alive');
check(
  await ev(`!!document.querySelector('#tree .session.loose .fork')`),
  'there is a button for killing it straight from the sidebar',
);

// Clicking the row opens that terminal.
const firstId = await ev(`document.querySelector('.tab')?.dataset.id`);
await ev(`[...document.querySelectorAll('#tree .session.loose')].pop().click()`);
await sleep(800);
check(
  (await ev(`document.querySelector('.tab.active')?.dataset.id`)) !== firstId,
  'clicking the row switches over to that terminal',
);

// --- 2. tab mode: only a single terminal is visible -------------------------
const visibleTabs = await ev(`
  [...document.querySelectorAll('#terms .host')].filter(h => !h.hidden).length
`);
check(visibleTabs === 1, `tab mode shows one terminal (${visibleTabs})`);
check(await ev(`document.getElementById('layout-btn')?.textContent === 'Tabs'`), 'the layout button names the mode in force');

// --- 3. switch over to grid --------------------------------------------------
await ev(`document.getElementById('layout-btn').click()`);
await sleep(1500);
const grid = await ev(`
  (() => {
    const hosts = [...document.querySelectorAll('#terms .host')];
    const vis = hosts.filter(h => !h.hidden);
    const r = vis.map(h => h.getBoundingClientRect());
    // The first row: the ones whose top lines up with the topmost of them.
    const top = Math.min(...r.map(x => x.top));
    const kolom = r.filter(x => Math.abs(x.top - top) < 2).length;
    return {
      total: hosts.length,
      tampak: vis.length,
      kolom,
      cols: getComputedStyle(document.getElementById('terms')).getPropertyValue('--cols').trim(),
      tumpang: r.some((a, i) => r.some((b, j) => i < j &&
        a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1)),
      kepala: vis.every(h => h.querySelector('.hcap') && getComputedStyle(h.querySelector('.hcap')).display !== 'none'),
      berlabel: vis.every(h => (h.querySelector('.hcname')?.textContent || '').length > 3),
      aktif: document.querySelectorAll('#terms .host.on').length,
    };
  })()
`);
check(grid.tampak === grid.total && grid.tampak >= 4, `every terminal is on screen at once (${grid.tampak})`);
check(grid.cols === '2' && grid.kolom === 2, `four terminals become a 2×2 (--cols=${grid.cols})`);
check(!grid.tumpang, 'no panel overlaps another');
check(grid.kepala, 'every panel has a little header');
check(grid.berlabel, 'the header names the project and the agent, not merely a number');
check(grid.aktif === 1, 'exactly one panel is marked as the active one');

// --- 4. every panel negotiates a size of its own ----------------------------
check(
  await waitFor(`
    (() => {
      const t = [...document.querySelectorAll('#terms .host:not([hidden]) .xterm-rows')];
      return t.length >= 4;
    })()
  `),
  'all four xterms really are drawn',
);
await sleep(2500);
const unique = new Set([...sizes.values()]);
check(sizes.size >= 4, `the daemon receives a size from every panel (${sizes.size} terminals)`);
check(
  [...sizes.values()].every((v) => {
    const [c, r] = v.split('x').map(Number);
    return c > 10 && r > 5;
  }),
  `the sizes are sensible, not 1×1: ${[...unique].slice(0, 4).join(', ')}`,
);

// --- 5. clicking a panel moves which one is active --------------------------
const before = await ev(`document.querySelector('#terms .host.on')?.dataset.id || ''`);
await ev(`
  (() => {
    const hosts = [...document.querySelectorAll('#terms .host')];
    const lain = hosts.find(h => !h.classList.contains('on'));
    lain.querySelector('.hview').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  })()
`);
await sleep(600);
check(
  (await ev(`document.querySelectorAll('#terms .host.on').length`)) === 1,
  'there is still exactly one active panel after the click',
);
check(
  await ev(`
    (() => {
      const on = document.querySelector('#terms .host.on');
      const tab = document.querySelector('.tab.active');
      return !!on && !!tab;
    })()
  `),
  'the tab bar marks that same terminal along with it',
);

// --- 6. back to tab mode, and the choice is remembered ----------------------
await ev(`document.getElementById('layout-btn').click()`);
await sleep(1200);
check(
  (await ev(`[...document.querySelectorAll('#terms .host')].filter(h => !h.hidden).length`)) === 1,
  'back to one terminal per screen',
);
check(await ev(`localStorage.getItem('sh.layout') === 'tabs'`), 'the choice is stored');

await ev(`document.getElementById('layout-btn').click()`);
await sleep(800);
await ev(`location.reload()`);
await sleep(4500);
check(
  await waitFor(`document.getElementById('terms').classList.contains('grid')`),
  'grid mode survives a reload',
);
await ev(`document.getElementById('layout-btn').click()`);
await sleep(600);

// --- a phone never grids -----------------------------------------------------
// Nine panels on a 390 px screen are nine unreadable postage stamps, so at
// phone width the view is tabs regardless of what is stored, and the button
// whose only honest answer would be "no" is not on the screen at all. The
// stored preference must survive untouched — it belongs to the desktop this
// browser may also be.
await ev(`localStorage.setItem('sh.layout','grid')`);
await cmd('Emulation.setDeviceMetricsOverride', { width: 420, height: 780, deviceScaleFactor: 2, mobile: true });
await ev(`location.reload()`);
await sleep(4500);
check(!(await ev(`document.getElementById('terms').classList.contains('grid')`)), 'at phone width the view is tabs even with grid stored');
check(await ev(`!document.getElementById('layout-btn')`), 'and the Tabs/Grid button is not offered');
check(await ev(`localStorage.getItem('sh.layout') === 'grid'`), 'the stored choice is left untouched');

// Growing past the breakpoint brings both back: the stored grid, and the button.
await cmd('Emulation.setDeviceMetricsOverride', { width: 1360, height: 820, deviceScaleFactor: 1, mobile: false });
await sleep(1500);
check(await ev(`document.getElementById('terms').classList.contains('grid')`), 'widening the window restores the stored grid');
check(await ev(`!!document.getElementById('layout-btn')`), 'and the button comes back with it');
await ev(`localStorage.setItem('sh.layout','tabs')`);
await cmd('Emulation.clearDeviceMetricsOverride');

// --- done: kill the test terminals ------------------------------------------
{
  const ids = await ev(`[...document.querySelectorAll('.tab')].map(t => Number(t.dataset.id))`);
  for (const id of ids) app.send(JSON.stringify({ t: 'kill', id }));
  await sleep(1500);
}
app.close();

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
