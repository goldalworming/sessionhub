// The Explorer's "±" view lists the code files changed since the project's
// snapshot — never node_modules or build output — and a click opens a diff.
// "✓" takes a new snapshot. Needs headless Chrome on :9222.

import { mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:/Users/user/AppData/Local/Temp/claude/C--data-code-terminal-editor2-sessionhubd/' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912/scratchpad';
const BIN = process.env.SH_BIN || 'C:/data/code/terminal-editor2/sessionhubd/target/debug/sessionhubd.exe';
const HOME = `${SP}/chhome`;
const PROJ = `${SP}/chproj`;
const PORT = 7796;
const TOKEN = 'uji-changes';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const d of [HOME, PROJ]) rmSync(d, { recursive: true, force: true });
mkdirSync(`${HOME}/.sessionhub`, { recursive: true });
for (const d of ['src', 'node_modules/dep', 'build']) mkdirSync(`${PROJ}/${d}`, { recursive: true });
writeFileSync(`${PROJ}/src/a.rs`, 'fn main() {\n    println!("one");\n}\n');
writeFileSync(`${PROJ}/src/gone.rs`, 'old\n');
writeFileSync(`${PROJ}/node_modules/dep/index.js`, 'dep\n');
writeFileSync(`${PROJ}/build/out.js`, 'out\n');
writeFileSync(`${PROJ}/logo.png`, 'png');
// Enough code that copying it takes a while: the terminal must not wait for it.
mkdirSync(`${PROJ}/bulk`);
const filler = 'x'.repeat(8000) + '\n';
for (let i = 0; i < 3000; i++) writeFileSync(`${PROJ}/bulk/f${i}.js`, filler);
writeFileSync(`${HOME}/.sessionhub/config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nprojects = ['${PROJ.replaceAll('/', '\\')}']\n`);
const start = () => spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
let daemon = start();
await sleep(3000);
// Never the one of whatever terminal runs this test: `show` would aim at it.
const { SESSIONHUB_TERMINAL: _own, ...bare } = process.env;
const cli = (args, env = {}) => spawnSync(BIN, [...args, '--home', HOME], { encoding: 'utf8', env: { ...bare, ...env } });

const began = Date.now();
const t1 = cli(['spawn', '--agent', 'terminal', '--project', PROJ.replaceAll('/', '\\')]).stdout.trim();
const took = Date.now() - began;
check(/^\d+$/.test(t1) && took < 1500, `a terminal (${t1}) starts in ${took} ms with 24 MB of code to copy`);
await sleep(3000);

// What an agent would do.
writeFileSync(`${PROJ}/src/a.rs`, 'fn main() {\n    println!("two");\n    println!("three");\n}\n');
writeFileSync(`${PROJ}/src/new.ts`, 'export const x = 1;\n');
unlinkSync(`${PROJ}/src/gone.rs`);
writeFileSync(`${PROJ}/node_modules/dep/index.js`, 'dep changed\n');
writeFileSync(`${PROJ}/build/out.js`, 'out changed\n');
writeFileSync(`${PROJ}/logo.png`, 'png changed');

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
const logs = [];
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') logs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr)) return true; await sleep(250); } return false; };
await cmd('Runtime.enable');

await cmd('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}&t=${t1}` });
await sleep(3500);
cli(['show', PROJ], { SESSIONHUB_TERMINAL: t1 });
check(await waitFor(`!document.getElementById('side').hidden && !!document.querySelector('#files .fchanges')`, 8000), 'the Explorer has a ± button');
await ev(`document.querySelector('#files .fchanges').click()`);

const rows = `[...document.querySelectorAll('#changes .crow')].map(r => r.querySelector('.fname').firstChild.textContent + '|' + r.className.split(' ').pop() + '|' + r.querySelector('.ccount').textContent)`;
check(await waitFor(`(${rows}).length === 3`, 8000), `three code files listed (${JSON.stringify(await ev(rows))})`);
const got = (await ev(rows)) || [];
check(got.includes('a.rs|modified|+2−1') && got.includes('new.ts|added|+1') && got.includes('gone.rs|deleted|−1'),
  'each with how it changed and its line counts');
check(!got.some((r) => /index\.js|out\.js|logo/.test(r)), 'node_modules, build output and images are not listed');
check(/3 files changed since/.test(await ev(`document.querySelector('#changes .cnote').textContent`)), 'the note says how many and since when');

await ev(`[...document.querySelectorAll('#changes .crow')].find(r => r.textContent.includes('a.rs')).click()`);
check(await waitFor(`document.querySelector('#side .ptab.on')?.textContent.includes('± a.rs')`, 15000), 'a click opens a diff tab');
check(await waitFor(`!!document.querySelector('.ediff:not([hidden]) .monaco-diff-editor') && document.querySelectorAll('.ediff .line-insert, .ediff .char-insert').length > 0`, 10000),
  'showing the old and new side by side, with the insertions marked');
await ev("document.getElementById('side').style.width = '900px'"); await sleep(800);
await cmd('Page.captureScreenshot', { format: 'png' }).then((r) =>
  writeFileSync(`${SP}/changes-diff.png`, Buffer.from(r.result.data, 'base64')));

// Opening the diff folded the list away; the strip brings it back.
await ev(`document.querySelector('.foldstrip').click()`);
check(await waitFor(`!document.querySelector('.pexp').classList.contains('folded') && !document.getElementById('changes').hidden`, 3000),
  'the list folds away for the diff and comes back from the strip');
// More work by the agent; output from its terminal is what makes the list look again.
writeFileSync(`${PROJ}/src/b.py`, 'print(1)\n');
cli(['send', t1, 'echo tick', '--enter', '--raw']);
check(await waitFor(`(${rows}).some(r => r.startsWith('b.py|added'))`, 20000), 'a new change shows up by itself while the list is open');

await ev(`document.querySelector('#changes .creset').click()`);
check(await waitFor(`(${rows}).length === 0 && /Nothing changed since/.test(document.querySelector('#changes .cnote').textContent)`, 8000),
  '✓ marks everything reviewed: nothing is listed after it');
const recs = `[...document.querySelectorAll('#changes .crec')].map(r => r.textContent)`;
check(await waitFor(`(${recs}).length === 1 && (${recs})[0].includes('4 files')`, 5000), `and keeps them under Earlier (${JSON.stringify(await ev(recs))})`);

// The terminal ends: its snapshot goes, and what changed since ✓ is kept too.
writeFileSync(`${PROJ}/src/c.go`, 'package main\n');
cli(['send', t1, 'exit', '--enter', '--raw']);
// Checked on disk: with its only terminal gone, the page moves on to whatever
// project is left, so the list on screen is not this one's any more.
const kept = () => {
  try {
    return readdirSync(`${HOME}/.sessionhub/changes`).flatMap((d) => readdirSync(`${HOME}/.sessionhub/changes/${d}`)).filter((f) => f.endsWith('.jsonl')).length;
  } catch { return 0; }
};
const until = Date.now() + 10000;
while (kept() < 2 && Date.now() < until) await sleep(250);
check(kept() === 2, `when the last terminal ends its changes are kept on disk (${kept()} records)`);

// Tomorrow: a new daemon, and the records are still there to read.
cli(['stop']);
daemon.kill();
await sleep(1500);
daemon = start();
await sleep(3000);
const t2 = cli(['spawn', '--agent', 'terminal', '--project', PROJ.replaceAll('/', '\\')]).stdout.trim();
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}&t=${t2}` });
await sleep(3500);
cli(['show', PROJ], { SESSIONHUB_TERMINAL: t2 });
await waitFor(`!!document.querySelector('#files .fchanges')`, 8000);
await ev(`document.querySelector('#files .fchanges').click()`);
check(await waitFor(`(${recs}).length === 2`, 8000), 'after a restart the records are still listed');
await ev(`[...document.querySelectorAll('#changes .crec')].find(r => r.textContent.includes('4 files')).click()`);
check(await waitFor(`(${rows}).length === 4 && (${rows}).includes('a.rs|modified|+2−1')`, 5000), `a record opens to its files (${JSON.stringify(await ev(rows))})`);
await ev(`[...document.querySelectorAll('#changes .crow')].find(r => r.textContent.includes('a.rs')).click()`);
check(await waitFor(`(document.querySelector('#side .ptab.on')?.textContent || '').includes('± a.rs · ') && document.querySelectorAll('.ediff .line-insert, .ediff .char-insert').length > 0`, 15000),
  'and its diff opens, marked with the day it is from');
await ev(`document.querySelector('.foldstrip').click()`);
await ev(`document.querySelector('#changes .clink')?.click()`);
check(await waitFor(`(${recs}).length === 2 && !document.querySelector('#changes .clink')`, 3000), '‹ goes back to now');
await cmd('Page.captureScreenshot', { format: 'png' }).then((r) =>
  writeFileSync(`${SP}/changes-earlier.png`, Buffer.from(r.result.data, 'base64')));
await ev(`document.querySelector('#changes .cback').click()`);
check(await ev(`!document.getElementById('files').hidden && document.getElementById('changes').hidden`), '☰ goes back to the files');
check(!(await ev(`(localStorage.getItem([...Object.keys(localStorage)].find(k => k.startsWith('sh.files.')) ) || '').includes('diff:')`)),
  'a diff tab is not remembered for next time');
check(logs.length === 0, `no errors on the page (${JSON.stringify(logs.slice(0, 3))})`);

cli(['stop']);
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
