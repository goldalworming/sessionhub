// A tab says what its sidebar row says, including a name you gave the session,
// and right-clicking a tab offers Rename… which edits the name in place. A
// scratch daemon with a fake Claude session file; `claude` is stood in for by
// cmd.exe so nothing real starts. Needs headless Chrome on :9222.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP = process.env.SP || 'C:/Users/user/AppData/Local/Temp/sessionhub-tabrename';
const BIN = process.env.SH_BIN || 'C:/data/code/terminal-editor2/sessionhubd/target/debug/sessionhubd.exe';
const win = (p) => p.replaceAll('/', '\\');
const PORT = 7812, TOKEN = 'uji-rename', HOME = `${SP}/renhome`, PROJ = `${SP}/renproj`;
const SID = '7a1d2c3e-0000-4000-8000-00000000abcd';
const TITLE = 'judul asli dari sesi';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
rmSync(PROJ, { recursive: true, force: true });
mkdirSync(`${HOME}/.sessionhub`, { recursive: true });
mkdirSync(`${HOME}/.claude/projects/renproj`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(`${HOME}/.claude/projects/renproj/${SID}.jsonl`,
  JSON.stringify({ type: 'user', cwd: win(PROJ), sessionId: SID, message: { role: 'user', content: TITLE } }) + '\n');
writeFileSync(`${HOME}/.sessionhub/config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nprojects = ['${win(PROJ)}']\n\n` +
  `[agents.claude]\ncommand = "cmd.exe"\nargs = ["/k"]\nresume_args = ["echo", "{session_id}"]\n`);

let daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3500);
const { SESSIONHUB_TERMINAL: _own, ...bare } = process.env;
const cli = (args) => spawnSync(BIN, [...args, '--home', HOME], { encoding: 'utf8', env: bare });
let tid = cli(['spawn', '--agent', 'claude', '--project', win(PROJ), '--resume', SID]).stdout.trim();
check(/^\d+$/.test(tid), `a terminal on the fake session (${tid})`);

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr)) return true; await sleep(250); } return false; };
const key = async (k, code, text) => {
  await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: code === 'Enter' ? 13 : code === 'Escape' ? 27 : 0, text });
  await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code });
};
await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}&t=${tid}` });
await ev(`localStorage.removeItem('sh.alias')`);
await cmd('Page.reload');

const tabName = `document.querySelector('.tab[data-id="${tid}"] .tname')?.textContent`;
const rowTitle = `document.querySelector('.zrow[data-tid="${tid}"] .stitle')?.textContent`;
check(await waitFor(`(${tabName} || '').includes(${JSON.stringify(TITLE)})`, 15000), 'the tab shows the session title');

// A right-click on the tab, then Rename… from the menu.
const openMenu = async () => {
  const r = await ev(`(() => { const b = document.querySelector('.tab[data-id="${tid}"]').getBoundingClientRect(); return [b.x + 20, b.y + b.height / 2]; })()`);
  await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: r[0], y: r[1], button: 'right', clickCount: 1 });
  await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r[0], y: r[1], button: 'right', clickCount: 1 });
  await sleep(300);
};
await openMenu();
const items = await ev(`[...document.querySelectorAll('#menu *')].filter(n => n.children.length === 0).map(n => n.textContent.trim()).filter(Boolean)`);
check(items?.[0] === 'Rename…', `the menu leads with Rename… (${JSON.stringify(items?.slice(0, 3))})`);
await ev(`[...document.querySelectorAll('#menu *')].find(n => n.textContent.trim() === 'Rename…' && n.children.length === 0).click()`);
await sleep(200);
check(await ev(`document.activeElement?.matches('.tab[data-id="${tid}"] input')`), 'an input opens on the tab, focused');
await cmd('Input.insertText', { text: 'upwork' });
await sleep(2500); // state broadcasts arrive meanwhile; the input must survive them
check(await ev(`document.activeElement?.value === 'upwork'`), 'it survives the strip being redrawn while typing');
await key('Enter', 'Enter', '\r');
await sleep(300);
check(await ev(`(${tabName} || '').endsWith('· upwork')`), `the tab reads the new name (${await ev(tabName)})`);
check(await ev(`${rowTitle} === 'upwork'`), `the sidebar row reads the same (${await ev(rowTitle)})`);

// After a reload both still agree; Escape leaves it alone; empty restores.
await cmd('Page.reload');
check(await waitFor(`(${tabName} || '').endsWith('· upwork') && ${rowTitle} === 'upwork'`, 15000), 'both keep it across a reload');
await openMenu();
await ev(`[...document.querySelectorAll('#menu *')].find(n => n.textContent.trim() === 'Rename…' && n.children.length === 0).click()`);
await sleep(200);
await cmd('Input.insertText', { text: 'dibuang' });
await key('Escape', 'Escape');
await sleep(300);
check(await ev(`(${tabName} || '').endsWith('· upwork')`), 'Escape cancels');
await openMenu();
await ev(`[...document.querySelectorAll('#menu *')].find(n => n.textContent.trim() === 'Rename…' && n.children.length === 0).click()`);
await sleep(200);
await ev(`document.activeElement.value = ''`);
await key('Enter', 'Enter', '\r');
await sleep(300);
check(await ev(`(${tabName} || '').includes(${JSON.stringify(TITLE)}) && ${rowTitle} === ${JSON.stringify(TITLE)}`), 'emptying it goes back to the original title, in both');

// The name lives on the daemon now: in its config, and seen from another
// address — another origin, so none of this page's storage — after a restart.
await openMenu();
await ev(`[...document.querySelectorAll('#menu *')].find(n => n.textContent.trim() === 'Rename…' && n.children.length === 0).click()`);
await sleep(200);
await cmd('Input.insertText', { text: 'upwork' });
await key('Enter', 'Enter', '\r');
await sleep(800);
const conf = () => readFileSync(`${HOME}/.sessionhub/config.toml`, 'utf8');
check(conf().includes('[session_names]') && conf().includes('upwork'), 'config.toml keeps the name');
cli(['stop']);
daemon.kill();
await sleep(1500);
daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3500);
tid = cli(['spawn', '--agent', 'claude', '--project', win(PROJ), '--resume', SID]).stdout.trim();
await cmd('Page.navigate', { url: `http://localhost:${PORT}/?token=${TOKEN}&t=${tid}` });
check(await waitFor(`(${tabName.replace(/data-id="\d+"/, `data-id="${tid}"`)} || '').endsWith('· upwork')`, 15000),
  'after a daemon restart, from another address, the tab still reads it');

// A name this browser kept before the daemon could: handed over, once.
await ev(`localStorage.setItem('sh.alias', JSON.stringify({ ${JSON.stringify(SID)}: 'lokal lama' }))`);
cli(['stop']);
daemon.kill();
await sleep(1500);
writeFileSync(`${HOME}/.sessionhub/config.toml`, conf().replace(/\[session_names\][^\[]*/, ''));
daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3500);
await cmd('Page.reload');
check(await waitFor(`document.querySelector('[data-sid="${SID}"] .stitle')?.textContent === 'lokal lama'`, 15000),
  'a name kept in this browser shows');
await sleep(800);
check(conf().includes('lokal lama') && await ev(`!JSON.parse(localStorage.getItem('sh.alias') || '{}')[${JSON.stringify(SID)}]`),
  'and is handed to the daemon, then forgotten here');

cli(['stop']);
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
