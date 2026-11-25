// Settings → Machines can add a machine itself: its button opens the pairing
// dialog on top of the settings window. Also: a daemon with network access on
// listens on the machine's address and does not reopen it while nothing
// changes. Needs headless Chrome on :9222.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP = process.env.SP || 'C:/Users/user/AppData/Local/Temp/sessionhub-addmachine';
const BIN = process.env.SH_BIN || 'C:/data/code/terminal-editor2/sessionhubd/target/debug/sessionhubd.exe';
const win = (p) => p.replaceAll('/', String.fromCharCode(92));
const PORT = 7818, TOKEN = 'uji-mesin', HOME = `${SP}/home`, PROJ = `${SP}/proj`;
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}/.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(`${HOME}/.sessionhub/config.toml`, `port = ${PORT}\nlan_access = true\ntoken = "${TOKEN}"\nprojects = ['${win(PROJ)}']\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3500);
const { SESSIONHUB_TERMINAL: _own, ...bare } = process.env;
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
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}` });
check(await waitFor(`!!document.getElementById('settings-btn')`, 15000), 'the page is up');
await ev(`document.getElementById('settings-btn').click()`);
const tab = `[...document.querySelectorAll('#settings *')].find(n => n.children.length === 0 && n.textContent.trim() === 'Machines')`;
check(await waitFor(`!!${tab}`, 5000), 'Settings has a Machines tab');
await ev(`${tab}.click()`);
const add = `[...document.querySelectorAll('#settings .machines .addbtn')].find(b => b.textContent.includes('Add a machine'))`;
check(await waitFor(`!!${add}`, 3000), 'with an Add a machine button, even with none paired');
await ev(`${add}.click()`);
check(await waitFor(`!document.getElementById('pairdlg').hidden`, 2000), 'which opens the pairing dialog');
check(await ev(`(() => { const r = document.querySelector('#pairdlg .pdlink').getBoundingClientRect(); return document.elementFromPoint(r.x + 5, r.y + 5)?.classList.contains('pdlink'); })()`),
  'on top of the settings window, its field reachable');

// The network side. Nothing changed in these 35 seconds, so nothing reopens.
await sleep(35000 - 3500);
const log = readFileSync(`${HOME}/.sessionhub/sessionhubd.log`, 'utf8');
check(/listening on the local network — reachable/.test(log), 'network access opened on the machine\'s addresses');
check((log.match(/stopped listening on the local network/g) || []).length === 0 && !/addresses changed/.test(log),
  'and was left alone while the addresses stayed the same');

cli(['stop']);
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
