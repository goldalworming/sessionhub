// The empty stage on a phone: "No session open." and a button that opens the
// drawer.
//
// The bug this exists for: `#empty` comes before `#terms` in the DOM and both
// are `inset: 0`, so each machine's host — which stays in place whether or not
// it holds a terminal — painted over the button and took every tap. On a phone
// the button did nothing at all.
//
// It is tested with a REAL TAP, not `element.click()`. Dispatching a click to an
// element skips hit-testing entirely, so it would have reported success while
// the button was unusable — which is exactly what happened while looking for
// this. The point is checked directly too: whatever is at the button's centre
// has to BE the button.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1af81868-b2d4-4560-8e29-8ce58f28d35a\\scratchpad';
const BIN = 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\emptyhome`;
const PROJ = `${SP}\\savedproj`;
const PORT = 7740;
const TOKEN = 'uji-empty';

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
for (let i = 0; i < 40 && !(await alive()); i++) await sleep(500);
check(!!(await alive()), `test daemon up on ${PORT}`);

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

// Two live terminals, none attached — the state in the report: tabs across the
// top, an empty stage below.
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  ws.onopen = r;
});
for (let i = 0; i < 2; i++) {
  ws.send(
    JSON.stringify({ t: 'spawn', project: PROJ, agent: 'terminal', resume: null, cols: 80, rows: 24 }),
  );
  await sleep(2200);
}
ws.close();

await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cmd('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
});
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5000);
await ev(`localStorage.setItem('sh.sidebar.hidden','1')`);
await ev(`location.reload()`);
await sleep(6000);
// The drawer opens itself once on a narrow screen; the reported state is with it
// shut, so shut it.
await ev(`document.getElementById('backdrop').click()`);
await sleep(700);

check(
  await ev(`document.getElementById('sidebar').hidden === true`),
  'the drawer starts shut',
);
check(
  await ev(`!document.getElementById('empty').hidden && !!document.getElementById('empty-open')`),
  'the empty stage offers a button',
);
check((await ev(`document.querySelectorAll('.tab').length`)) === 2, 'with terminals alive above it');

// The button has to be the thing at its own position. This is what actually
// broke, and the only check that would have caught it.
const hit = await ev(`
  (() => {
    const b = document.getElementById('empty-open');
    const r = b.getBoundingClientRect();
    const at = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    return { same: at === b || b.contains(at), got: at ? at.tagName.toLowerCase() + (at.id ? '#' + at.id : '.' + at.className) : null };
  })()
`);
check(hit.same, `nothing covers the button — the point hits ${hit.got}`);

// And now a real tap, the way a finger does it.
const box = JSON.parse(
  await ev(`
    JSON.stringify((() => {
      const r = document.getElementById('empty-open').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })())
  `),
);
await cmd('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
await sleep(60);
await cmd('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

check(
  await waitFor(`document.getElementById('sidebar').hidden === false`, 8000),
  'tapping it opens the drawer',
);
check(
  await ev(`!document.getElementById('backdrop').hidden`),
  'with the backdrop behind it, exactly as the hamburger leaves it',
);
check(
  (await ev(`Math.round(document.getElementById('sidebar').getBoundingClientRect().width)`)) > 200,
  'and the drawer is really on screen, not just un-hidden',
);

// The hamburger keeps working; this must be the same door, not a second one.
await ev(`document.getElementById('backdrop').click()`);
await sleep(600);
await ev(`document.getElementById('menu-btn').click()`);
await sleep(600);
check(
  await ev(`document.getElementById('sidebar').hidden === false`),
  'the hamburger still opens the same drawer',
);

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
await sleep(1500);
cdp.close();
process.exit(steps.every(Boolean) ? 0 : 1);
