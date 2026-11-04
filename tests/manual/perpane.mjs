// The file panel belongs to the session it was opened beside, and the grid to
// the machine it was chosen on. Two scratch daemons, `near` and `far`, paired;
// shells only. Needs headless Chrome on :9222.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP = process.env.SP || 'C:/Users/user/AppData/Local/Temp/sessionhub-perpane';
const BIN = process.env.SH_BIN || 'C:/data/code/terminal-editor2/sessionhubd/target/debug/sessionhubd.exe';
const win = (p) => p.replaceAll('/', '\\');
const NEAR = { port: 7813, token: 'uji-pane-near', home: `${SP}/panenear`, proj: `${SP}/paneproj-near` };
const FAR = { port: 7814, token: 'uji-pane-far', home: `${SP}/panefar`, proj: `${SP}/paneproj-far` };

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const m of [NEAR, FAR]) {
  rmSync(m.home, { recursive: true, force: true });
  rmSync(m.proj, { recursive: true, force: true });
  mkdirSync(`${m.home}/.sessionhub`, { recursive: true });
  mkdirSync(m.proj, { recursive: true });
  writeFileSync(`${m.proj}/a.txt`, 'hello\n');
}
const cfg = (m, extra = '') =>
  `port = ${m.port}\nlan_access = false\ntoken = "${m.token}"\nprojects = ['${win(m.proj)}']\n${extra}`;
writeFileSync(`${FAR.home}/.sessionhub/config.toml`, cfg(FAR));
writeFileSync(`${NEAR.home}/.sessionhub/config.toml`,
  cfg(NEAR, `\n[[remotes]]\nname = "far"\naddr = "127.0.0.1:${FAR.port}"\ntoken = "${FAR.token}"\n`));
const daemons = [FAR, NEAR].map((m) =>
  spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', m.home], { stdio: 'ignore' }));
await sleep(3500);
const { SESSIONHUB_TERMINAL: _own, ...bare } = process.env;
const cli = (m, args) => spawnSync(BIN, [...args, '--home', m.home], { encoding: 'utf8', env: bare }).stdout.trim();
const A = cli(NEAR, ['spawn', '--agent', 'terminal', '--project', win(NEAR.proj)]);
const B = cli(NEAR, ['spawn', '--agent', 'terminal', '--project', win(NEAR.proj)]);
const F = cli(FAR, ['spawn', '--agent', 'terminal', '--project', win(FAR.proj)]);
check([A, B, F].every((x) => /^\d+$/.test(x)), `terminals ${A}, ${B} near and ${F} far`);

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr)) return true; await sleep(200); } return false; };
await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `http://127.0.0.1:${NEAR.port}/?token=${NEAR.token}` });
await sleep(500);
await ev(`localStorage.clear()`);
await cmd('Page.navigate', { url: `http://127.0.0.1:${NEAR.port}/?token=${NEAR.token}&t=${A}` });

const filesOpen = `!document.getElementById('side').hidden`;
const tab = (id) => `document.querySelector('.tab[data-id="${id}"]')`;
const activeTab = `document.querySelector('.tab.active')?.dataset.id`;
const pick = async (id) => { await ev(`${tab(id)}.click()`); await waitFor(`${activeTab} === '${id}'`, 5000); await sleep(300); };

check(await waitFor(`${activeTab} === '${A}'`, 15000), 'session A is on screen');
check(await ev(`!(${filesOpen})`), 'the file panel starts shut');
await ev(`document.getElementById('files-btn').click()`);
check(await waitFor(filesOpen, 3000), 'Files opened beside A');
await pick(B);
check(await ev(`!(${filesOpen})`), 'switching to B leaves it shut there');
await pick(A);
check(await ev(filesOpen), 'back on A it is open again');
await cmd('Page.reload');
check(await waitFor(`${activeTab} === '${A}'`, 15000) && await waitFor(filesOpen, 5000), 'and after a reload, still open beside A');
await pick(B);
check(await ev(`!(${filesOpen})`), 'still shut beside B');

// Grid on near, then to far: tabs there; back: grid again.
await ev(`document.getElementById('layout-btn').click()`);
check(await waitFor(`document.getElementById('terms').classList.contains('grid')`, 3000), 'grid on near');
await ev(`[...document.querySelectorAll('.mtab')].find(t => t.textContent.includes('far'))?.click()`);
await sleep(1500);
check(await ev(`!document.getElementById('terms').classList.contains('grid') && document.getElementById('layout-btn')?.textContent === 'Tabs'`), 'far stays on tabs');
await ev(`[...document.querySelectorAll('.mtab')].find(t => !t.textContent.includes('far'))?.click()`);
await sleep(1500);
check(await ev(`document.getElementById('terms').classList.contains('grid')`), 'near is back in grid');
await cmd('Page.reload');
await sleep(4000);
check(await ev(`document.getElementById('terms').classList.contains('grid')`), 'and near is still grid after a reload');

for (const m of [NEAR, FAR]) cli(m, ['stop']);
for (const d of daemons) d.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
