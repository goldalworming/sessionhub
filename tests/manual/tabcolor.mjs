// Tagging a tab with a colour.
//
// The mark has to be worth trusting, which means three things beyond "the tab
// turns blue": the same terminal wears it in the sidebar as well as on the tab,
// it reaches the daemon rather than one browser's storage — so the phone and the
// laptop agree — and on a *named* terminal it comes back after a restart.
//
// The daemon under test is its own, on its own port and home.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1af81868-b2d4-4560-8e29-8ce58f28d35a\\scratchpad';
const BIN = 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\colorhome`;
const PROJ = `${SP}\\savedproj`;
const CFG = `${HOME}\\.sessionhub\\config.toml`;
const PORT = 7727;
const TOKEN = 'uji-tab-color';

const steps = [];
const check = (c, m) => {
  steps.push(c);
  console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = async () => {
  try {
    return (await (await fetch(`http://127.0.0.1:${PORT}/api/status?token=${TOKEN}`)).json()).version;
  } catch {
    return null;
  }
};
const startDaemon = async () => {
  spawn(BIN, ['start', '--home', HOME], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40 && !(await alive()); i++) await sleep(500);
  return await alive();
};
const stopDaemon = async () => {
  spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
  for (let i = 0; i < 30 && (await alive()); i++) await sleep(500);
  return !(await alive());
};

// ------------------------------------------------------------------ CDP setup

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

const load = async () => {
  await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
  await sleep(5000);
  await ev(`document.getElementById('backdrop')?.click()`);
  await sleep(500);
};

// ------------------------------------------------------------------- the test

await stopDaemon();
const CFGDIR = `${HOME}\\.sessionhub`;
rmSync(CFGDIR, { recursive: true, force: true });
mkdirSync(CFGDIR, { recursive: true });
writeFileSync(
  CFG,
  [
    `port = ${PORT}`,
    'lan_access = false',
    `token = "${TOKEN}"`,
    `projects = ["${PROJ.split('\\').join('\\\\')}"]`,
    '',
  ].join('\n'),
);
check(!!(await startDaemon()), `test daemon up on ${PORT}`);

await cmd('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 820,
  deviceScaleFactor: 1,
  mobile: false,
});
await load();

// Two terminals in one project, so their tabs read alike — which is the whole
// reason to want a colour on one of them.
for (let i = 0; i < 2; i++) {
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
check(await waitFor(`document.querySelectorAll('.tab').length === 2`, 20000), 'two tabs, alike');
check(
  await ev(`
    (() => {
      const n = [...document.querySelectorAll('.tab .tname')].map(x => x.textContent);
      return n.length === 2 && n[0] === n[1];
    })()
  `),
  'and their labels really are identical, so only a colour can tell them apart',
);

// Right-click the first tab.
await ev(`
  document.querySelector('.tab').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 })
  )
`);
await sleep(500);
const menu = await ev(`[...document.querySelectorAll('#menu > div')].map(x => x.textContent)`);
check(
  ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'].every((c) => menu.includes(c)),
  `the menu offers the palette (${menu.join(', ')})`,
);
check(
  await ev(`document.querySelectorAll('#menu .mswatch').length >= 6`),
  'each one shown as a swatch, not just its name',
);
check(
  !menu.includes('No colour'),
  'with nothing to clear yet, "No colour" is not offered',
);

await ev(`[...document.querySelectorAll('#menu > div')].find(x => x.textContent === 'cyan').click()`);
check(
  await waitFor(`document.querySelector('.tab')?.dataset.color === 'cyan'`, 8000),
  'picking one tags the tab',
);
check(
  await ev(`!document.querySelectorAll('.tab')[1]?.dataset.color`),
  'and only that tab — the other is left alone',
);

// It has to be visible, not merely present in the DOM.
const paint = await ev(`
  (() => {
    const t = document.querySelector('.tab');
    const s = getComputedStyle(t);
    return { shadow: s.boxShadow, bg: s.backgroundColor, tag: s.getPropertyValue('--tag').trim() };
  })()
`);
console.log(`    painted: ${JSON.stringify(paint)}`);
check(
  paint.tag !== '' && /rgb/.test(paint.shadow),
  'the colour is actually painted, not just recorded in an attribute',
);

check(
  await ev(`
    (() => {
      const r = [...document.querySelectorAll('#tree [data-tid]')]
        .filter(x => x.dataset.color === 'cyan');
      return r.length > 0;
    })()
  `),
  'the same terminal wears the tag in the sidebar too',
);

// The panel itself, not only its tab: in grid mode there is no active tab, and
// in tab mode the strip scrolls out of the way.
const panel = await ev(`
  (() => {
    const h = [...document.querySelectorAll('#terms .host')].find(x => x.dataset.color === 'cyan');
    if (!h) return null;
    const v = h.querySelector('.hview');
    const bar = getComputedStyle(v, '::before');
    const term = v.querySelector('.xterm');
    return {
      pad: getComputedStyle(v).paddingLeft,
      barWidth: bar.width,
      barColor: bar.backgroundColor,
      // The terminal must start after the bar, not underneath it.
      termLeft: Math.round(term.getBoundingClientRect().left - v.getBoundingClientRect().left),
    };
  })()
`);
console.log(`    panel: ${JSON.stringify(panel)}`);
check(!!panel, 'the panel showing that terminal is tagged too');
check(
  panel && panel.barWidth === '3px' && /rgb/.test(panel.barColor),
  `a coloured bar is drawn down its side (${panel?.barWidth}, ${panel?.barColor})`,
);
check(
  panel && panel.termLeft >= 3,
  `and the terminal starts after it, so column one is not clipped (${panel?.termLeft}px)`,
);

// The mark lives on the daemon, not in this browser: a different client sees it.
{
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  const msgs = [];
  await new Promise((r) => {
    ws.onopen = r;
  });
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') msgs.push(JSON.parse(e.data));
  };
  await sleep(1000);
  const st = msgs.filter((m) => m.t === 'state').pop();
  check(
    st.terminals.filter((t) => t.color === 'cyan').length === 1,
    'a second client is told about it — so the phone and the laptop agree',
  );

  // A colour the daemon does not know must be refused, not stored and handed
  // back to every browser as an attribute.
  msgs.length = 0;
  ws.send(JSON.stringify({ t: 'set_color', id: st.terminals[0].id, color: 'red; background:url(x)' }));
  await sleep(800);
  check(
    msgs.some((m) => m.t === 'error' && m.code === 'bad_color'),
    'a colour outside the palette is refused',
  );
  ws.close();
}

// Clearing it.
await ev(`
  document.querySelector('.tab').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 })
  )
`);
await sleep(500);
check(
  await ev(`[...document.querySelectorAll('#menu > div')].some(x => x.textContent === 'No colour')`),
  'now that one is set, the menu offers to clear it',
);
check(
  await ev(`[...document.querySelectorAll('#menu .mon')].some(x => /cyan/.test(x.textContent))`),
  'and marks the one in use',
);
await ev(`[...document.querySelectorAll('#menu > div')].find(x => x.textContent === 'cyan').click()`);
check(
  await waitFor(`!document.querySelector('.tab')?.dataset.color`, 8000),
  'picking the colour it already has takes the tag off again',
);

// The part that needs the daemon restarted: a tag on a NAMED terminal.
await ev(`document.querySelector('.tab').dispatchEvent(
  new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))`);
await sleep(400);
await ev(`[...document.querySelectorAll('#menu > div')].find(x => x.textContent === 'magenta').click()`);
await sleep(600);
await ev(`document.querySelector('#tree .session .act-save').click()`);
await waitFor(`!document.getElementById('ask').hidden`, 8000);
await ev(`
  (() => {
    const d = document.getElementById('ask');
    d.querySelector('input:not(.second)').value = 'bot warna';
    d.querySelector('input.second').value = 'echo halo';
    d.querySelector('.ok').click();
  })()
`);
await sleep(1500);
check(
  /color = "magenta"/.test(readFileSync(CFG, 'utf8')),
  'naming a tagged terminal stores its colour with the name',
);
check(
  await waitFor(`/bot warna/.test(document.querySelector('.tab .tname')?.textContent || '')`, 8000),
  'and the tab shows the name, not a third copy of "savedproj · terminal"',
);

check(await stopDaemon(), 'the daemon is stopped');
check(!!(await startDaemon()), 'and started again');
await load();
check(
  await waitFor(`
    [...document.querySelectorAll('#tree .session.saved')].some(r => r.dataset.color === 'magenta')
  `, 15000),
  'the saved terminal still wears its colour after the restart',
);
await ev(`
  [...document.querySelectorAll('#tree .session.saved')]
    .find(r => r.dataset.color === 'magenta').click()
`);
check(
  await waitFor(`document.querySelector('.tab')?.dataset.color === 'magenta'`, 25000),
  'and opening it brings the tag back onto its tab',
);

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
await stopDaemon();
cdp.close();
process.exit(steps.every(Boolean) ? 0 : 1);
