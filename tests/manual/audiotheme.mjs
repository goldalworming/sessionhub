// A sound file opens with a player and plays; Download is in ⋯. The editor
// follows the app theme until a theme of its own is chosen. Needs headless
// Chrome on :9222.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP = process.env.SP || 'C:/Users/user/AppData/Local/Temp/sessionhub-audiotheme';
const BIN = process.env.SH_BIN || 'C:/data/code/terminal-editor2/sessionhubd/target/debug/sessionhubd.exe';
const win = (p) => p.replaceAll('/', String.fromCharCode(92));
const PORT = 7816, TOKEN = 'uji-audio', HOME = `${SP}/home`, PROJ = `${SP}/proj`;
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
rmSync(PROJ, { recursive: true, force: true });
mkdirSync(`${HOME}/.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
// One second of a 440 Hz tone, 8 kHz mono 16-bit.
const n = 8000, wav = Buffer.alloc(44 + n * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 8000)), 44 + i * 2);
writeFileSync(`${PROJ}/nada.wav`, wav);
writeFileSync(`${PROJ}/lagu.MP3`, Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb]));
writeFileSync(`${PROJ}/a.txt`, 'teks\n');
writeFileSync(`${HOME}/.sessionhub/config.toml`, `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nprojects = ['${win(PROJ)}']\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3500);
const { SESSIONHUB_TERMINAL: _own, ...bare } = process.env;
const cli = (args) => spawnSync(BIN, [...args, '--home', HOME], { encoding: 'utf8', env: bare }).stdout.trim();
const tid = cli(['spawn', '--agent', 'terminal', '--project', win(PROJ)]);

const head = await fetch(`http://127.0.0.1:${PORT}/api/file?token=${TOKEN}&path=${encodeURIComponent(win(`${PROJ}/lagu.MP3`))}`);
check(head.headers.get('content-type') === 'audio/mpeg', `an .MP3 is served as audio/mpeg (${head.headers.get('content-type')})`);

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr)) return true; await sleep(200); } return false; };
await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd('Emulation.setAutoplayPolicy', { autoplayPolicy: 'no-user-gesture-required' }).catch(() => {});
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}` });
await sleep(500);
await ev(`localStorage.clear(); localStorage.setItem('sh.theme', 'light')`);
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}&t=${tid}` });
await waitFor(`document.querySelector('.tab.active')`, 15000);
await ev(`document.getElementById('files-btn').click()`);
const row = (name) => `[...document.querySelectorAll('.frow')].find(r => r.textContent.trim().endsWith(${JSON.stringify(name)}))`;
check(await waitFor(`!!${row('nada.wav')}`, 5000), 'nada.wav is in the tree');

await ev(`${row('nada.wav')}.click()`);
const audio = `document.querySelector('#editor .eaudio audio')`;
check(await waitFor(`!document.querySelector('#editor .eaudio').hidden && ${audio}.duration > 0.9`, 8000), 'it opens with a player that knows its length');
await ev(`${audio}.loop = true`);
check(await ev(`${audio}.play().then(() => new Promise(r => setTimeout(r, 400))).then(() => ${audio}.currentTime > 0)`), 'and plays');
await ev(`document.querySelector('#editor .espeed [data-speed="1.5"]').click()`);
check(await ev(`${audio}.playbackRate === 1.5 && ${audio}.preservesPitch && localStorage.getItem('sh.audio.speed') === '1.5' && document.querySelector('#editor .espeed .on').dataset.speed === '1.5'`),
  'the 1.5× button speeds it up, pitch kept, and is remembered');
await ev(`document.querySelector('#editor .emore').click()`);
await sleep(200);
const items = await ev(`[...document.querySelectorAll('#menu *')].filter(n => n.children.length === 0).map(n => n.textContent.trim()).filter(Boolean)`);
check(JSON.stringify(items) === '["Download"]', `⋯ offers Download only (${JSON.stringify(items)})`);
await ev(`document.body.click()`);

// Light app, editor never set: light. Then the app goes dark, it follows.
await ev(`${row('a.txt')}.click()`);
check(await waitFor(`!!document.querySelector('#editor .monaco-editor')`, 15000), 'a text file opens in Monaco');
const light = `document.querySelector('#editor .monaco-editor').classList.contains('vs')`;
check(await waitFor(light, 3000), 'with the app in light, the editor is light');
check(await ev(`!${audio}.paused`), 'switching tabs leaves the sound playing');
// The app goes to "system", and the system turns dark: the editor follows.
await ev(`document.getElementById('theme-btn').click()`);
await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
check(await waitFor(`localStorage.getItem('sh.theme') === 'system' && document.querySelector('#editor .monaco-editor').classList.contains('vs-dark')`, 3000),
  'with the app on system and the system dark, the editor turns dark');

// Closing the sound's tab stops it.
const closeBtn = `[...document.querySelectorAll('.ptab')].find(t => t.textContent.includes('nada.wav'))?.querySelector('.ptx')`;
await ev(`${closeBtn}?.click()`);
await sleep(300);
check(await ev(`${audio}.paused && !${audio}.getAttribute('src')`), 'closing its tab stops the sound');

cli(['stop']);
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
