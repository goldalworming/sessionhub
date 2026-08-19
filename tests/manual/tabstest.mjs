// The terminal tab bar when it is full: no tab may overlap its neighbour,
// long titles are cut off with an ellipsis, and the buttons on the right must
// not get pushed off screen.
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

// Six terminals: more than fit across the width of the screen used for testing.
{
  const app = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise((r) => { app.onopen = r; });
  await sleep(800);
  for (let i = 0; i < 6; i++) {
    app.send(JSON.stringify({
      t: 'spawn', project: PROJECT, agent: 'cmd', resume: null, cols: 90, rows: 24,
    }));
    await sleep(700);
  }
  await sleep(1200);
  app.close();
}

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
const waitFor = async (expr, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(expr)) return true;
    await sleep(200);
  }
  return false;
};

await cmd('Emulation.setDeviceMetricsOverride', { width: 900, height: 500, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.setItem('sh.theme','light'); localStorage.setItem('sh.mem','1');
          localStorage.setItem('sh.files.open','0'); localStorage.setItem('sh.sidebar.hidden','1')`);
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(4000);
check(await waitFor(`document.querySelectorAll('.tab').length >= 5`), 'the tab bar is filled beyond what fits on screen');

// --- 1. no tab overlaps its neighbour ---------------------------------------
const measure = await ev(`
  (() => {
    const tabs = [...document.querySelectorAll('.tab')];
    const r = tabs.map(t => t.getBoundingClientRect());
    let overlap = 0;
    for (let i = 1; i < r.length; i++) if (r[i].left < r[i - 1].right - 0.5) overlap++;
    const tools = document.querySelector('.tools').getBoundingClientRect();
    const strip = document.querySelector('.tabstrip');
    return {
      jumlah: tabs.length,
      overlap,
      toolsKanan: Math.round(tools.right),
      lebarLayar: window.innerWidth,
      bisaGulir: strip.scrollWidth > strip.clientWidth,
      // A tab must not shrink below the width of its own contents.
      menyusut: tabs.some(t => t.getBoundingClientRect().width < t.scrollWidth - 0.5),
    };
  })()
`);
check(measure.overlap === 0, `no tab overlaps its neighbour (${measure.jumlah} tabs)`);
check(!measure.menyusut, 'no tab shrinks below the width of its own contents');
check(measure.bisaGulir, 'the tab bar scrolls instead of forcing everything to fit');
check(
  measure.toolsKanan <= measure.lebarLayar + 1,
  `the buttons on the right stay on screen (${measure.toolsKanan} <= ${measure.lebarLayar})`,
);

// --- 2. long titles are cut off instead of spilling over ---------------------
const longTitle = await ev(`
  (() => {
    const n = document.querySelector('.tab .tname');
    n.textContent = 'terminal-editor2 · claude · baca init.md dan buat smoke test yang panjang sekali';
    const tab = n.closest('.tab');
    const cs = getComputedStyle(n);
    const rt = tab.getBoundingClientRect();
    const rn = n.getBoundingClientRect();
    return {
      elipsis: cs.textOverflow,
      tabLebar: Math.round(rt.width),
      namaMuat: rn.right <= rt.right + 0.5,
      maxLebar: Math.round(parseFloat(getComputedStyle(tab).maxWidth)),
    };
  })()
`);
check(longTitle.elipsis === 'ellipsis', 'a long title is cut off with an ellipsis');
check(longTitle.namaMuat, 'the text stays inside its own tab box and does not spill over onto the neighbour');
check(
  longTitle.tabLebar <= longTitle.maxLebar + 1,
  `the tab does not stretch without limit (${longTitle.tabLebar}px, limit ${longTitle.maxLebar}px)`,
);

// --- 3. the active tab is always visible -------------------------------------
await ev(`document.querySelectorAll('.tab')[document.querySelectorAll('.tab').length - 1].click()`);
await sleep(600);
const visible = await ev(`
  (() => {
    const a = document.querySelector('.tab.active');
    if (!a) return null;
    const s = document.querySelector('.tabstrip').getBoundingClientRect();
    const r = a.getBoundingClientRect();
    return r.left >= s.left - 1 && r.right <= s.right + 1;
  })()
`);
check(visible === true, 'the selected tab is brought into view instead of being left off screen');

// --- done: close every test terminal -----------------------------------------
{
  const app = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise((r) => { app.onopen = r; });
  const ids = await new Promise((res) => {
    app.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data);
      if (m.t === 'state') res(m.terminals.filter((t) => t.alive).map((t) => t.id));
    };
  });
  for (const id of ids) app.send(JSON.stringify({ t: 'kill', id }));
  await sleep(1500);
  app.close();
}

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
