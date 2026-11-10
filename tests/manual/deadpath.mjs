// A folder that no longer exists is asked for once, not over and over: the
// picker's remembered folder falls back to its nearest existing parent and is
// forgotten, and a tree whose root was deleted stops asking for it. Counts the
// `browse`/`tree` messages the page sends. Needs headless Chrome on :9222.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP = process.env.SP || 'C:/Users/user/AppData/Local/Temp/sessionhub-deadpath';
const BIN = process.env.SH_BIN || 'C:/data/code/terminal-editor2/sessionhubd/target/debug/sessionhubd.exe';
const win = (p) => p.replaceAll('/', '\\');
const PORT = 7821, TOKEN = 'uji-deadpath', HOME = `${SP}/home`, PROJ = `${SP}/proj`, GONE = `${SP}/gone`;
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const d of [HOME, PROJ, GONE]) rmSync(d, { recursive: true, force: true });
mkdirSync(`${HOME}/.sessionhub`, { recursive: true });
mkdirSync(`${PROJ}/a/b`, { recursive: true });
mkdirSync(GONE, { recursive: true });
writeFileSync(`${GONE}/x.txt`, 'x');
writeFileSync(`${HOME}/.sessionhub/config.toml`, `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nprojects = ['${win(PROJ)}', '${win(GONE)}']\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3500);
const { SESSIONHUB_TERMINAL: _own, ...bare } = process.env;
process.on('uncaughtException', (e) => { console.error(e); cli(['stop']); process.exit(1); });
const cli = (args) => spawnSync(BIN, [...args, '--home', HOME], { encoding: 'utf8', env: bare }).stdout.trim();

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr)) return true; await sleep(200); } return false; };
await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
// Every message the page sends, so the requests can be counted.
await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__sent = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    if (typeof d === 'string') { try { const m = JSON.parse(d); if (m.t === 'browse' || m.t === 'tree') window.__sent.push(m); } catch {} }
    return send.call(this, d);
  };` });
await cmd('Page.enable');
const sent = (t, path) => ev(`window.__sent.filter(m => m.t === '${t}' && m.path.replaceAll('\\\\', '/').toLowerCase() === '${path.toLowerCase()}').length`);

// ---- picker: the remembered folder is gone, two levels down
const dead = `${PROJ}/a/b/gone/deeper`;
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}` });
await sleep(500);
await ev(`localStorage.clear(); localStorage.setItem('sh.picker.path.local', ${JSON.stringify(win(dead))})`);
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}` });
await waitFor(`!!document.getElementById('new-project')`, 10000);
await sleep(1000);
await ev(`document.getElementById('new-project').click()`);
const shown = `document.querySelector('.ppath').value.replaceAll('\\\\', '/').toLowerCase()`;
check(await waitFor(`${shown} === '${`${PROJ}/a/b`.toLowerCase()}'`, 5000), `the picker lands on the nearest folder that exists (${await ev(shown)})`);
await sleep(3000);
check(await sent('browse', dead) === 1, `the dead folder was asked for once (${await sent('browse', dead)})`);
const kept = await ev(`localStorage.getItem('sh.picker.path.local')`);
check(win(kept || '').toLowerCase() === win(`${PROJ}/a/b`).toLowerCase(), `and is forgotten (${kept})`);
const ups = await ev(`import('/picker.js').then(m => ['C:\\\\a\\\\b', 'C:\\\\a', 'C:\\\\', '/x/y/', '/x', '/', ''].map(m.parentOf))`);
check(JSON.stringify(ups) === JSON.stringify(['C:\\a', 'C:\\', null, '/x', '/', null, null]), `parentOf stops at the top (${JSON.stringify(ups)})`);
await ev(`document.querySelector('.picker .pclose, .picker [aria-label=Close]')?.click()`);

// ---- tree: the folder the tree is showing is deleted under it
const tid = cli(['spawn', '--agent', 'terminal', '--project', win(GONE)]);
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}&t=${tid}` });
await waitFor(`document.querySelector('.tab.active')`, 15000);
await ev(`document.getElementById('files-btn').click()`);
const row = `[...document.querySelectorAll('.frow')].some(r => r.textContent.trim().endsWith('x.txt'))`;
check(await waitFor(row, 5000), 'the tree shows the project');
// The shell sits in the folder; go elsewhere so Windows lets it be deleted —
// PowerShell's `cd` alone leaves the process's own directory where it was.
await sleep(2000);
cli(['send', tid, `cd ${win(SP)}; [Environment]::CurrentDirectory = (Get-Location).Path`, '--enter']);
await sleep(1500);
rmSync(GONE, { recursive: true, force: true });
const before = await sent('tree', GONE);
// Output from the terminal is what makes the tree look again (`nudgeTree`).
for (let i = 0; i < 4; i++) { cli(['send', tid, 'echo hi', '--enter']); await sleep(2500); }
const asked = (await sent('tree', GONE)) - before;
check(asked >= 1 && asked <= 2, `the deleted root was asked for at most twice after it went (${asked})`);

cli(['stop']);
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
