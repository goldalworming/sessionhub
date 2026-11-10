// A file open in the editor that changes on disk can be reloaded from the ⋯
// menu; the reload takes what is on disk even over edits, and leaves the tab
// clean. An unedited tab reopened from the tree picks up the change without
// being marked unsaved. Needs headless Chrome on :9222.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP = process.env.SP || 'C:/Users/user/AppData/Local/Temp/sessionhub-mdreload';
const BIN = process.env.SH_BIN || 'C:/data/code/terminal-editor2/sessionhubd/target/debug/sessionhubd.exe';
const win = (p) => p.replaceAll('/', '\\');
const PORT = 7815, TOKEN = 'uji-mdreload', HOME = `${SP}/home`, PROJ = `${SP}/proj`;
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
rmSync(PROJ, { recursive: true, force: true });
mkdirSync(`${HOME}/.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(`${PROJ}/notes.md`, '# versi satu\n');
writeFileSync(`${HOME}/.sessionhub/config.toml`, `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nprojects = ['${win(PROJ)}']\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3500);
const { SESSIONHUB_TERMINAL: _own, ...bare } = process.env;
const cli = (args) => spawnSync(BIN, [...args, '--home', HOME], { encoding: 'utf8', env: bare }).stdout.trim();
const tid = cli(['spawn', '--agent', 'terminal', '--project', win(PROJ)]);

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
await sleep(500);
await ev(`localStorage.clear()`);
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}&t=${tid}` });
await waitFor(`document.querySelector('.tab.active')`, 15000);
await ev(`document.getElementById('files-btn').click()`);
const row = `[...document.querySelectorAll('.frow')].find(r => r.textContent.trim().endsWith('notes.md'))`;
check(await waitFor(`!!${row}`, 5000), 'notes.md is in the tree');
await ev(`${row}.click()`);
const text = `window.monaco?.editor.getModels().find(m => !m.isDisposed() && m.getValue().startsWith('#'))?.getValue()`;
check(await waitFor(`(${text} || '').includes('versi satu')`, 15000), 'it opens');

const unsaved = `document.querySelector('#editor .enote').textContent.includes('unsaved')`;
const reload = async () => {
  await ev(`document.querySelector('#editor .emore').click()`);
  await sleep(200);
  const items = await ev(`[...document.querySelectorAll('#menu *')].filter(n => n.children.length === 0).map(n => n.textContent.trim()).filter(Boolean)`);
  await ev(`[...document.querySelectorAll('#menu *')].find(n => n.children.length === 0 && n.textContent.trim().startsWith('Reload from disk')).click()`);
  return items;
};

writeFileSync(`${PROJ}/notes.md`, '# versi dua\n');
const items = await reload();
check(items.includes('Reload from disk'), `the ⋯ menu offers Reload from disk (${JSON.stringify(items)})`);
check(await waitFor(`(${text} || '').includes('versi dua')`, 5000), 'the reload shows what is on disk');
check(await ev(`!(${unsaved})`), 'and the tab is not marked unsaved');

// Edited here, changed there: the menu says what a reload drops, and does it.
await ev(`window.monaco.editor.getEditors()[0].trigger('t', 'type', { text: 'edit lokal ' })`);
await sleep(200);
check(await ev(unsaved), 'a local edit marks it unsaved');
writeFileSync(`${PROJ}/notes.md`, '# versi tiga\n');
const items2 = await reload();
check(items2.includes('Reload from disk, dropping edits'), 'with edits the item says they are dropped');
check(await waitFor(`(${text} || '') === '# versi tiga\\n'`, 5000), 'the reload replaces the edits with the disk copy');
check(await ev(`!(${unsaved})`), 'and leaves it clean');

// An unedited tab opened again from the tree picks up the change, clean.
writeFileSync(`${PROJ}/notes.md`, '# versi empat\n');
await ev(`${row}.click()`);
check(await waitFor(`(${text} || '').includes('versi empat')`, 5000) && await ev(`!(${unsaved})`), 'reopening from the tree updates it, still clean');

cli(['stop']);
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
