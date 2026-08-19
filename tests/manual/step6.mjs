// Step 6 tested in the browser: command palette, shortcuts, and theme.

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

// --- set up two terminals so that tab switching can be tested ---------------
let TARGET = null; // a real claude session that will be opened through the palette
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
  const st = seen.find((m) => m.t === 'state');

  // Take a real claude session from a project whose directory still exists —
  // a pi session is not used because its binary really is absent from the test
  // config.
  for (const p of st.projects) {
    if (!p.exists) continue;
    const s = p.sessions.find((x) => x.agent === 'claude' && !x.live_terminal_id);
    if (s) { TARGET = { title: s.title, project: p.name }; break; }
  }
  console.log(`  palette target: "${TARGET?.title}" in ${TARGET?.project}`);

  const live = st.terminals.filter((t) => t.alive).length;
  console.log(`  live terminals at the start: ${live}`);
  for (let i = live; i < 2; i++) {
    app.send(JSON.stringify({
      t: 'spawn', project: 'C:\\data\\code\\terminal-editor2', agent: 'shell', resume: null, cols: 110, rows: 30,
    }));
    const want = i + 1;
    const t0 = Date.now();
    while (seen.filter((m) => m.t === 'attached').length < want && Date.now() - t0 < 20000) await sleep(150);
  }
  const t1 = Date.now();
  while (!/PS [A-Z]:/.test(screen) && Date.now() - t1 < 20000) await sleep(150);
  app.close();
  await sleep(600);
}

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

/// Press a real key through DevTools, rather than calling an internal function.
const NAMED = { Escape: { code: 'Escape', vk: 27 }, Enter: { code: 'Enter', vk: 13 } };

async function press(key, { ctrl = false, shift = false } = {}) {
  let modifiers = 0;
  if (ctrl) modifiers |= 2;
  if (shift) modifiers |= 8;

  const named = NAMED[key];
  const digit = /^[0-9]$/.test(key);
  const base = {
    modifiers,
    key,
    code: named ? named.code : digit ? `Digit${key}` : `Key${key.toUpperCase()}`,
    windowsVirtualKeyCode: named ? named.vk : key.toUpperCase().charCodeAt(0),
  };
  await cmd('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: ctrl || named ? undefined : key });
  await cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// Go to the page first, and only then write the preferences: `localStorage` is
// per origin, so setting it while the browser still sits on whatever page the
// previous test left behind stores it somewhere this page never reads. The
// theme and sidebar checks below start from these two values.
await evaluate(`location.href = '${URL}'`);
await sleep(4500);
await evaluate(`localStorage.setItem('sh.theme','system'); localStorage.setItem('sh.sidebar.hidden','0')`);
await evaluate(`location.reload()`);
await sleep(4500);

// --- theme -------------------------------------------------------------------
check(await evaluate(`document.documentElement.hasAttribute('data-theme') === false`), 'the default follows prefers-color-scheme (with no attribute)');
const bgSystem = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`);

await evaluate(`document.getElementById('theme-btn').click()`);
await sleep(400);
check(await evaluate(`document.documentElement.getAttribute('data-theme') === 'dark'`), 'the first click -> dark');
const bgDark = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`);
check(bgDark === '#0F1113', `the background colour changes with it (${bgDark})`);

await evaluate(`document.getElementById('theme-btn').click()`);
await sleep(300);
check(await evaluate(`document.documentElement.getAttribute('data-theme') === 'light'`), 'the second click -> light');
const bgLight = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`);
check(bgLight === '#FBFBFA' && bgLight !== bgDark, `light wins out over the system preference (${bgLight})`);

await evaluate(`location.reload()`);
await sleep(3500);
check(await evaluate(`document.documentElement.getAttribute('data-theme') === 'light'`), 'the theme choice survives a reload');
await evaluate(`document.getElementById('theme-btn').click()`);
await sleep(300);
check(await evaluate(`!document.documentElement.hasAttribute('data-theme')`), 'the third click goes back to system');
check(
  (await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`)) === bgSystem,
  'back to the system colour'
);

// --- Ctrl+B: sidebar ---------------------------------------------------------
check(await evaluate(`document.getElementById('sidebar').hidden === false`), 'the sidebar is visible at the start');
await press('b', { ctrl: true });
await sleep(500);
check(await evaluate(`document.getElementById('sidebar').hidden === true`), 'Ctrl+B hides the sidebar');
await press('b', { ctrl: true });
await sleep(500);
check(await evaluate(`document.getElementById('sidebar').hidden === false`), 'Ctrl+B brings it back again');

// --- Ctrl+K: palette ---------------------------------------------------------
await press('k', { ctrl: true });
await sleep(600);
check(await evaluate(`document.getElementById('palette').hidden === false`), 'Ctrl+K opens the palette');
check(await evaluate(`document.activeElement === document.querySelector('#palette input')`), 'the focus is in the search field straight away');

const total = await evaluate(`document.querySelectorAll('#palette .prow').length`);
check(total > 5, `the initial list holds projects and sessions (${total} rows)`);

await evaluate(`
  (() => {
    const i = document.querySelector('#palette input');
    i.value = 'notex';
    i.dispatchEvent(new Event('input'));
  })()
`);
await sleep(400);
const filtered = await evaluate(`document.querySelectorAll('#palette .prow').length`);
const firstLabel = await evaluate(`document.querySelector('#palette .prow .plabel')?.textContent || ''`);
check(filtered > 0 && filtered < total, `typing filters the list down (${total} -> ${filtered})`);
check(/notex/i.test(firstLabel), `the top result is relevant: "${firstLabel}"`);
check(await evaluate(`document.querySelectorAll('#palette .prow b').length > 0`), 'the matching letters are marked');

// Esc closes without opening anything at all.
await press('Escape');
await sleep(400);
check(await evaluate(`document.getElementById('palette').hidden === true`), 'Escape closes the palette');

// --- the palette opens a session ---------------------------------------------
const before = await evaluate(`document.querySelectorAll('.xterm').length`);
await press('k', { ctrl: true });
await sleep(500);
const query = JSON.stringify(TARGET.title.slice(0, 24));
await evaluate(`
  (() => {
    const i = document.querySelector('#palette input');
    i.value = ${query};
    i.dispatchEvent(new Event('input'));
  })()
`);
await sleep(500);
// A project row only scrolls the sidebar; what opens a terminal is a session
// row, so pick a row whose kind is claude.
const picked = await evaluate(`
  (() => {
    const rows = [...document.querySelectorAll('#palette .prow')];
    const row = rows.find(r => r.querySelector('.pkind').textContent === 'claude');
    if (!row) return null;
    const label = row.querySelector('.plabel').textContent;
    row.click();
    return label;
  })()
`);
await sleep(4000);
const after = await evaluate(`document.querySelectorAll('.xterm').length`);
check(!!picked, `there is a session row among the search results ("${picked}")`);
check(after > before, `picking a session from the palette opens a terminal (${before} -> ${after})`);

// --- Ctrl+1 / Ctrl+2 ---------------------------------------------------------
await evaluate(`document.querySelectorAll('.tab')[0].click()`);
await sleep(1200);
const firstTab = await evaluate(`document.querySelector('.tab.active')?.dataset.id`);
await press('2', { ctrl: true, code: 'Digit2' });
await sleep(1500);
const secondTab = await evaluate(`document.querySelector('.tab.active')?.dataset.id`);
check(secondTab && secondTab !== firstTab, `Ctrl+2 switches to the second terminal (${firstTab} -> ${secondTab})`);
await press('1', { ctrl: true, code: 'Digit1' });
await sleep(1200);
check(
  (await evaluate(`document.querySelector('.tab.active')?.dataset.id`)) === firstTab,
  'Ctrl+1 goes back to the first terminal'
);

// --- keys that belong to the agent must not be hijacked ----------------------
const claimed = await evaluate(`
  (() => {
    const ev = (key, opts) => Object.assign(new KeyboardEvent('keydown', { key, ctrlKey: true, ...opts }));
    const hasil = {};
    for (const k of ['c','d','p','r','a','e','l','u']) {
      const e = ev(k);
      let dicegah = false;
      const h = (x) => { if (x.defaultPrevented) dicegah = true; };
      document.addEventListener('keydown', h, true);
      document.dispatchEvent(e);
      document.removeEventListener('keydown', h, true);
      hasil[k] = e.defaultPrevented;
    }
    return hasil;
  })()
`);
const hijacked = Object.entries(claimed).filter(([, v]) => v).map(([k]) => k);
check(hijacked.length === 0, `Ctrl+C/D/P/R and friends are passed on to the agent (hijacked: ${hijacked.join(',') || 'none'})`);

ws.close();
const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
