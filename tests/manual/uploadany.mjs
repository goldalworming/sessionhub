// The key bar's File key takes any file, not only images: a phone has no
// drag-and-drop, and `accept="image/*"` sent it straight to the gallery with no
// way to a markdown file or subtitles. Needs headless Chrome on :9222.

import { mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\uphome`;
const PROJ = `${SP}\\upproj`;
const PORT = 7778;
const TOKEN = 'uji-upload';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(`${HOME}\\.sessionhub\\config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nremote_commands = true\nprojects = ['${PROJ}']\n`);
const md = `${SP}\\notes-upload.md`;
const srt = `${SP}\\subs-upload.srt`;
writeFileSync(md, '# notes\n\nhello\n');
writeFileSync(srt, '1\n00:00:01,000 --> 00:00:02,000\nhello\n');
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3000);
const cli = (...a) => spawnSync(BIN, [...a, '--home', HOME], { encoding: 'utf8' });
const id = cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'up').stdout.trim();

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;

// A phone: narrow, touch.
await cmd('Emulation.setDeviceMetricsOverride', { width: 412, height: 900, deviceScaleFactor: 2, mobile: true });
await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}&t=up` });
await sleep(5000);
check(await ev(`document.querySelector('.tab.active')?.dataset.id`) === id, 'the terminal is open');
// The File key sits on the second row, behind the ⋯.
await ev(`document.querySelector('#keybar .kkey.kmore').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' }))`);
await sleep(500);

const key = await ev(`(() => { const k = document.querySelector('#keybar .kkey[data-act="upload"]'); return k && k.textContent.trim(); })()`);
check(key === 'File', `the key bar offers a File key (${key})`);
const input = await ev(`(() => { const i = document.getElementById('upfile'); return i && { accept: i.accept, multiple: i.multiple }; })()`);
check(input && input.accept === '' && input.multiple, `its input takes any file, several at once (${JSON.stringify(input)})`);

// Pick a markdown file and subtitles through that input, as the phone's
// file chooser would.
const doc = await cmd('DOM.getDocument');
const node = await cmd('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#upfile' });
await cmd('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [md, srt] });
await sleep(3000);

check(/path inserted/.test(await ev(`document.getElementById('banner')?.textContent || ''`)), 'the page says the path went in');
const dropped = readdirSync(`${HOME}\\.sessionhub\\dropped`);
check(dropped.some((f) => f.endsWith('notes-upload.md')) && dropped.some((f) => f.endsWith('subs-upload.srt')),
  `both were saved on the daemon (${dropped.join(', ')})`);
// The long paths wrap at a phone's width; what was typed is read with the
// wrapping taken out, and given time to be drawn.
const typed = async () =>
  (await ev(`[...document.querySelectorAll('.xterm-rows')].filter(r => r.offsetParent).map(r => r.textContent).join('')`)).replace(/\s+/g, '');
let both = false;
for (let i = 0; i < 20 && !both; i++) {
  const t = await typed();
  both = t.includes('notes-upload.md') && t.includes('subs-upload.srt');
  if (!both) await sleep(300);
}
check(both, 'and both paths were typed into the terminal');

cli('stop');
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
