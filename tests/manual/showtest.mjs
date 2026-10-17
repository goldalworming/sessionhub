// `sessionhubd show PATH` moves the file panel of the browser showing the
// terminal that ran it: a file inside the project opens with its folders
// unfolded, a folder outside becomes the tree's root, a browser looking at
// another terminal stays put. Also: the filter says what it hid. Needs
// headless Chrome on :9222.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:/Users/user/AppData/Local/Temp/claude/C--data-code-terminal-editor2-sessionhubd/' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912/scratchpad';
const BIN = process.env.SH_BIN || 'C:/data/code/terminal-editor2/sessionhubd/target/debug/sessionhubd.exe';
const HOME = `${SP}/showhome`;
const PROJ = `${SP}/showproj`;
const OUT = `${SP}/showout`;
const PORT = 7795;
const TOKEN = 'uji-show';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const d of [HOME, PROJ, OUT]) rmSync(d, { recursive: true, force: true });
mkdirSync(`${HOME}/.sessionhub`, { recursive: true });
mkdirSync(`${PROJ}/sub/deep`, { recursive: true });
mkdirSync(`${OUT}/inner`, { recursive: true });
writeFileSync(`${PROJ}/sub/deep/target.txt`, 'hello from target\n');
writeFileSync(`${PROJ}/sub/a.md`, 'a\n');
writeFileSync(`${PROJ}/sub/b.md`, 'b\n');
writeFileSync(`${PROJ}/sub/note.txt`, 'n\n');
writeFileSync(`${HOME}/.sessionhub/config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nprojects = ['${PROJ.replaceAll('/', '\\')}']\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3000);
const cli = (args, env = {}) => spawnSync(BIN, [...args, '--home', HOME], { encoding: 'utf8', env: { ...process.env, ...env } });

const t1 = cli(['spawn', '--agent', 'terminal', '--project', PROJ]).stdout.trim();
const t2 = cli(['spawn', '--agent', 'terminal', '--project', PROJ]).stdout.trim();
check(/^\d+$/.test(t1) && /^\d+$/.test(t2), `two terminals (${t1}, ${t2})`);
await sleep(6000);
cli(['send', t1, process.platform === 'win32' ? 'echo T=$env:SESSIONHUB_TERMINAL' : 'echo T=$SESSIONHUB_TERMINAL', '--enter', '--raw']);
await sleep(3000);
check(cli(['capture', t1]).stdout.includes(`T=${t1}`), 'a terminal knows its own id from SESSIONHUB_TERMINAL');

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr)) return true; await sleep(250); } return false; };

await cmd('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}&t=${t2}` });
await sleep(3500);
const rows = `[...document.querySelectorAll('#files .frow')].map(r => r.textContent.trim())`;
const selected = `document.querySelector('#files .frow.on')?.textContent.trim() || ''`;

let r = cli(['show', `${PROJ}/sub/deep/target.txt`], { SESSIONHUB_TERMINAL: t1 });
await sleep(2000);
check(r.status === 0 && !(await ev(`!document.getElementById('side').hidden && (${rows}).some(t => t.includes('target.txt'))`)),
  'a browser showing another terminal does not move');

await ev(`document.querySelector('[data-id="${t1}"]')?.click()`);
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}&t=${t1}` });
await sleep(3500);
r = cli(['show', `${PROJ}/sub/deep/target.txt`], { SESSIONHUB_TERMINAL: t1 });
check(await waitFor(`!document.getElementById('side').hidden && (${rows}).some(t => t.includes('target.txt'))`, 8000),
  'the browser showing it opens the panel with the folders down to the file unfolded');
check(await waitFor(`(${selected}).includes('target.txt')`, 4000), 'and the file is the selected row');
check(await waitFor(`document.querySelector('#side .ptab.on')?.textContent.includes('target.txt')`, 15000),
  'and opened in the editor');

r = cli(['show', `${OUT}/inner`]);
check(await waitFor(`(${rows}).some(t => t.endsWith('inner')) && (${selected}).endsWith('inner') && !(${rows}).some(t => t.includes('showproj'))`, 8000),
  'a folder outside the project becomes the root itself');

r = cli(['show', `${PROJ}/sub`], { SESSIONHUB_TERMINAL: t1 });
check(await waitFor(`(${rows}).some(t => t.includes('showproj')) && (${selected}).endsWith('sub')`, 8000), 'back inside the project, the project is the root again');
await ev(`(() => { const f = document.querySelector('#files .ffilter'); f.value = 'note'; f.dispatchEvent(new Event('input')); })()`);
check(await waitFor(`(${rows}).includes('2 files hidden by the filter')`, 3000), 'the filter says how many files it hid');
check(cli(['show', `${PROJ}/nope.txt`]).status !== 0, 'a path that is not there is refused by the CLI');
await ev(`(() => { const f = document.querySelector('#files .ffilter'); f.value = ''; f.dispatchEvent(new Event('input')); })()`);

// A folder that cannot be read says why, and comes back by itself once it can.
const LOCKED = `${PROJ}/sub/locked`.replaceAll('/', '\\');
mkdirSync(LOCKED);
writeFileSync(`${LOCKED}/inside.txt`, 'x\n');
const who = process.env.USERNAME;
spawnSync('icacls', [LOCKED, '/deny', `${who}:(RD)`]);
cli(['show', LOCKED], { SESSIONHUB_TERMINAL: t1 });
await sleep(1500);
await ev(`[...document.querySelectorAll('#files .frow')].find(r => r.textContent.trim().endsWith('locked'))?.click()`);
check(await waitFor(`(${rows}).some(t => /Could not read this folder: .*denied/i.test(t))`, 5000), 'a folder that cannot be read says why');
spawnSync('icacls', [LOCKED, '/remove:d', who]);
// Output from a terminal in the project is what makes the tree look again.
const until = Date.now() + 45000;
let back = false;
while (!back && Date.now() < until) {
  cli(['send', t1, 'echo tick', '--enter', '--raw']);
  back = await waitFor(`(${rows}).some(t => t.includes('inside.txt'))`, 4000);
}
check(back, 'and shows its files by itself once it can be read again');

// The behaviour log says which machine, and why the folder failed — without
// the path. Leaving the page flushes what is queued.
await cmd('Page.navigate', { url: 'about:blank' });
await sleep(2000);
const log = (() => { try { return readFileSync(`${HOME}/.sessionhub/telemetry.jsonl`, 'utf8'); } catch { return ''; } })()
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const err = log.find((e) => e.e === 'error' && e.code === 'tree_failed');
check(err && err.machine === 'local' && err.why === 'os5', `a failed folder is logged with machine and cause (${JSON.stringify(err)})`);
check(!log.some((e) => JSON.stringify(e).includes('showproj')), 'and no path reaches the log');
const opened = log.find((e) => e.e === 'conn_lost' || e.e === 'machine' || e.e === 'first_input' || e.e === 'error');
check(!!opened?.machine, 'other events carry the machine too');

cli(['stop']);
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
