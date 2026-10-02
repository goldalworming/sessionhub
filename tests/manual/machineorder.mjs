// Paired machines can be dragged into another order — on their tabs and in
// Settings → Machines — and the daemon keeps it. Needs headless Chrome on :9222.

import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\orderhome`;
const PORT = 7764;
const TOKEN = 'uji-order';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
const remote = (n, port) => `[[remotes]]\nname = "${n}"\naddr = "127.0.0.1:${port}"\ntoken = "t-${n}"\n`;
writeFileSync(`${HOME}\\.sessionhub\\config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\n\n` + remote('alpha', 9) + remote('beta', 9) + remote('gamma', 9));
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3000);
const order = () => [...readFileSync(`${HOME}\\.sessionhub\\config.toml`, 'utf8').matchAll(/name = "(\w+)"/g)].map((m) => m[1]).join(',');

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const tabs = `[...document.querySelectorAll('#mbar .mtab .mname')].map(n => n.textContent).join(',')`;
const centre = async (sel) => JSON.parse(await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
const mouse = (type, p, buttons = 1) => cmd('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons, clickCount: 1 });
const drag = async (from, to) => {
  await mouse('mouseMoved', from, 0);
  await mouse('mousePressed', from);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
    await sleep(30);
  }
  await mouse('mouseReleased', to, 0);
};

await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
// Real mouse events, so the page must think it has one.
await cmd('Emulation.setEmitTouchEventsForMouse', { enabled: false });
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(4000);
check((await ev(tabs)) === 'This machine,alpha,beta,gamma', `tabs start in the config's order (${await ev(tabs)})`);

// Drag gamma's tab before alpha's.
const g = await centre('#mbar .mtab[data-machine="r:gamma"]');
const a = await centre('#mbar .mtab[data-machine="r:alpha"]');
await drag(g, { x: a.x - 10, y: a.y });
await sleep(800);
check((await ev(tabs)) === 'This machine,gamma,alpha,beta', `dragging a tab reorders them (${await ev(tabs)})`);
check(order() === 'gamma,alpha,beta', `and the daemon keeps it in config.toml (${order()})`);
check(await ev(`document.querySelector('#mbar .mtab.on')?.dataset.machine === 'local'`), 'the drag did not switch machines');

// This machine cannot be moved, nor anything put before it.
const loc = await centre('#mbar .mtab[data-machine="local"]');
await drag(loc, { x: loc.x + 300, y: loc.y });
await sleep(500);
check((await ev(tabs)).startsWith('This machine,'), 'this machine stays first');

// A plain click still switches.
await ev(`document.querySelector('#mbar .mtab[data-machine="r:beta"]').click()`);
await sleep(300);
check(await ev(`document.querySelector('#mbar .mtab.on')?.dataset.machine === 'r:beta'`), 'a click on a tab still switches to it');
await ev(`document.querySelector('#mbar .mtab[data-machine="local"]').click()`);
await sleep(500);

// Settings → Machines: drag beta's row to the top by its grip.
await ev(`document.getElementById('settings-btn').click()`);
await sleep(800);
await ev(`document.querySelector('#settings .sitem[data-section="machines"]')?.click()`);
await sleep(800);
const rows = `[...document.querySelectorAll('#settings .machines .agent')].map(r => r.dataset.name).join(',')`;
check((await ev(rows)) === 'gamma,alpha,beta', `Settings lists them in the same order (${await ev(rows)})`);
check(await ev(`document.querySelectorAll('#settings .machines .agrip').length === 3`), 'each row has a grip');
const b = await centre('#settings .machines .agent[data-name="beta"] .agrip');
const top = await centre('#settings .machines .agent[data-name="gamma"]');
await drag(b, { x: b.x, y: top.y - 12 });
await sleep(800);
check(order() === 'beta,gamma,alpha', `dragging a row reorders them (${order()})`);
check((await ev(tabs)) === 'This machine,beta,gamma,alpha', `and the tabs follow (${await ev(tabs)})`);

// A finger: a hold, then a drag, moves a tab; a swipe without the hold does not.
await ev(`document.getElementById('settings').querySelector('.close')?.click()`);
await sleep(400);
const touch = (type, p) => cmd('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y }] : [] });
const fingerDrag = async (from, to, holdMs) => {
  await touch('touchStart', from);
  await sleep(holdMs);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', { x: from.x + ((to.x - from.x) * i) / 8, y: from.y });
    await sleep(30);
  }
  await touch('touchEnd');
};
const al = await centre('#mbar .mtab[data-machine="r:alpha"]');
const be = await centre('#mbar .mtab[data-machine="r:beta"]');
await fingerDrag(al, { x: be.x - 10, y: be.y }, 60);
await sleep(600);
check(order() === 'beta,gamma,alpha', `a quick swipe moves nothing (${order()})`);
await fingerDrag(al, { x: be.x - 10, y: be.y }, 500);
await sleep(800);
check(order() === 'alpha,beta,gamma', `a hold, then a drag, moves it (${order()})`);

spawnSync(BIN, ['stop', '--home', HOME]);
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
