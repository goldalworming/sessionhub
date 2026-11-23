// On a phone the text editor has a row of keys the on-screen keyboard lacks
// (Find, Esc, Undo, arrows), and a sound says when it is loading. Needs
// headless Chrome on :9222.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP = process.env.SP || 'C:/Users/user/AppData/Local/Temp/sessionhub-editorkeys';
const BIN = process.env.SH_BIN || 'C:/data/code/terminal-editor2/sessionhubd/target/debug/sessionhubd.exe';
const win = (p) => p.replaceAll('/', String.fromCharCode(92));
const PORT = 7817, TOKEN = 'uji-tombol', HOME = `${SP}/home`, PROJ = `${SP}/proj`;
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
rmSync(PROJ, { recursive: true, force: true });
mkdirSync(`${HOME}/.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
const n = 8000, wav = Buffer.alloc(44 + n * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
writeFileSync(`${PROJ}/nada.wav`, wav);
writeFileSync(`${PROJ}/rusak.mp3`, Buffer.from([0, 1, 2, 3, 0, 0, 9, 9, 0, 7]));
writeFileSync(`${PROJ}/a.txt`, 'satu dua\ntiga\n');
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

const row = (name) => `[...document.querySelectorAll('.frow')].find(r => r.textContent.trim().endsWith(${JSON.stringify(name)}))`;
const keys = `document.querySelector('#editor .ekeys')`;
await cmd('Page.enable');
let faked = null;
const open = async (phone) => {
  await cmd('Emulation.setDeviceMetricsOverride', phone
    ? { width: 390, height: 800, deviceScaleFactor: 2, mobile: true }
    : { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: phone });
  // Headless Chrome answers `pointer: coarse` whatever it is told, so the
  // page is given the answer of the device being played.
  if (faked) await cmd('Page.removeScriptToEvaluateOnNewDocument', { identifier: faked });
  faked = (await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `{
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q) => /pointer: (coarse|fine|none)/.test(q) ? { matches: q.includes(${JSON.stringify(phone ? 'coarse' : 'fine')}) } : real(q);
  }` })).result.identifier;
  await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}&t=${tid}` });
  await waitFor(`document.querySelector('.tab.active')`, 15000);
  // The panel is remembered open from one load to the next.
  await sleep(500);
  await ev(`document.getElementById('side').hidden && document.getElementById('files-btn').click()`);
  await waitFor(`!!${row('a.txt')}`, 5000);
  await ev(`${row('a.txt')}.click()`);
  return waitFor(`!!document.querySelector('#editor .monaco-editor') && !!window.monaco?.editor.getEditors()[0]?.getModel()`, 15000);
};

check(await open(false), 'on a laptop a text file opens in Monaco');
check(await ev(`${keys}.offsetHeight === 0`), 'and there is no key row');

check(await open(true), 'on a phone it opens too');
check(await ev(`${keys}.offsetHeight > 0 && ${keys}.getBoundingClientRect().right <= innerWidth + 1`), 'with the key row showing, inside the screen');
const ed = `monaco.editor.getEditors()[0]`;
const press = (label) => ev(`[...${keys}.children].find(b => b.textContent === ${JSON.stringify(label)}).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))`);
const found = `!!document.querySelector('#editor .find-widget.visible')`;
await press('Find');
check(await waitFor(found, 3000), 'Find opens the search');
await press('Esc');
check(await waitFor(`!${found}`, 3000), 'Esc closes it');
await press('All');
check(await ev(`!${ed}.getSelection().isEmpty()`), 'All selects everything');
await press('Esc');
check(await ev(`${ed}.getSelection().isEmpty()`), 'Esc drops the selection');
await ev(`${ed}.setPosition({ lineNumber: 1, column: 1 })`);
await press('→'); await press('↓');
check(await ev(`${ed}.getPosition().lineNumber === 2 && ${ed}.getPosition().column === 2`), 'the arrows move the cursor');
await ev(`${ed}.focus(); ${ed}.trigger('uji', 'type', { text: 'X' })`);
check(await ev(`${ed}.getValue().includes('X')`), '(typed an X)');
await press('Undo');
check(await ev(`!${ed}.getValue().includes('X')`), 'Undo takes it back');
await press('Redo');
check(await ev(`${ed}.getValue().includes('X')`), 'Redo puts it back');

const audio = `document.querySelector('#editor .eaudio audio')`;
const state = `document.querySelector('#editor .eastate').textContent`;
await ev(`window.__said = []; ${audio}.addEventListener('loadstart', () => setTimeout(() => __said.push(${state}), 0))`);
await ev(`${row('nada.wav')}.click()`);
check(await waitFor(`${audio}.duration > 0.9`, 8000), 'a sound opens');
check(await ev(`__said[0] === 'Loading the sound…' && ${state} === ''`), 'it said it was loading, and stopped saying so once it had');
check(await ev(`${keys}.offsetHeight === 0`), 'the key row is not shown beside a sound');
await ev(`${row('rusak.mp3')}.click()`);
check(await waitFor(`/could not be played here \\(.+\\)/.test(document.querySelector('#editor .eplace').textContent)`, 8000),
  `a sound that cannot be played says why (${await ev(`document.querySelector('#editor .eplace').textContent`)})`);

cli(['stop']);
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
