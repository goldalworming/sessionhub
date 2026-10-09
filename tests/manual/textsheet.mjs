// Selecting text on a phone: the key bar's Select key shows the terminal's
// lines as page text, where the device's own selection works, opened at the
// newest output, with Copy all. Also: ⏎ sits right after Ctrl.
// Needs headless Chrome on :9222.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\selhome`;
const PROJ = `${SP}\\selproj`;
const PORT = 7779;
const TOKEN = 'uji-select';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The rule for what the sheet shows, without a page.
const { sheetText } = await import('file:///C:/data/code/terminal-editor2/sessionhubd/web/textsheet.js');
check(sheetText(['a  ', 'b', '', '   ', '']) === 'a\nb', 'trailing padding and blank rows below the output are cut');
check(sheetText(Array.from({ length: 1500 }, (_, i) => `l${i}`)).split('\n').length === 1000, 'only the newest 1000 lines');

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(`${HOME}\\.sessionhub\\config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nremote_commands = true\nprojects = ['${PROJ}']\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3000);
const cli = (...a) => spawnSync(BIN, [...a, '--home', HOME], { encoding: 'utf8' });
const id = cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'sel').stdout.trim();

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const tap = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' }))`);

await cmd('Emulation.setDeviceMetricsOverride', { width: 412, height: 900, deviceScaleFactor: 2, mobile: true });
await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
// Headless counts no page as focused, and the clipboard needs a focused one.
await cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
await cmd('Browser.grantPermissions', { origin: `http://127.0.0.1:${PORT}`, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}&t=sel` });
await sleep(5000);
cli('send', id, '1..300 | ForEach-Object { "row $_ of the history" }; echo NEWEST-MARK-77', '--enter');
await sleep(4000);

const row1 = await ev(`[...document.querySelectorAll('#keybar .kkey')].map(b => b.textContent.trim())`);
const ctrl = row1.indexOf('Ctrl');
check(ctrl >= 0 && row1[ctrl + 1] === '⏎', `⏎ sits right after Ctrl (${row1.join(' ')})`);

await tap('#keybar .kkey.kmore');
await sleep(400);
check(await ev(`!!document.querySelector('#keybar .kkey[data-act="select"]')`), 'the second row offers a Select key');
await tap('#keybar .kkey[data-act="select"]');
await sleep(500);

const s = await ev(`(() => { const b = document.querySelector('#textsheet .tsbody'); return {
  open: !document.getElementById('textsheet').hidden,
  text: b.textContent, atBottom: b.scrollHeight - b.scrollTop - b.clientHeight < 4,
  selectable: getComputedStyle(b).userSelect }; })()`);
check(s.open, 'the sheet opens');
check(/NEWEST-MARK-77/.test(s.text) && /row 1 of the history/.test(s.text), "it holds the terminal's lines, old and new");
check(s.atBottom, 'it opens at the newest output');
check(s.selectable === 'text', 'its text is selectable');

// What a long press and the handles would do: a range over part of the text.
const picked = await ev(`(() => { const b = document.querySelector('#textsheet .tsbody'); const t = b.firstChild;
  const at = t.data.indexOf('NEWEST-MARK-77'); const r = document.createRange(); r.setStart(t, at); r.setEnd(t, at + 14);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); return sel.toString(); })()`);
check(picked === 'NEWEST-MARK-77', `a selection in it reads back as plain text (${picked})`);

// A tap is a user gesture; a script's click is not, and the clipboard
// refuses without one.
await cmd('Runtime.evaluate', { expression: `document.querySelector('#textsheet .tsall').click()`, userGesture: true });
await sleep(500);
const clip = await ev(`navigator.clipboard.readText().catch(e => 'ERR ' + e.message)`);
check(typeof clip === 'string' && clip.includes('NEWEST-MARK-77') && clip.includes('row 300 of the history'), 'Copy all puts the whole text on the clipboard');

await ev(`document.querySelector('#textsheet .tsclose').click()`);
check(await ev(`document.getElementById('textsheet').hidden && getSelection().toString() === ''`), 'Close hides it and clears the selection');

cli('stop');
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
