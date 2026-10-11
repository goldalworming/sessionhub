// Two page fixes, in headless Chrome:
//  - the file panel's auto-refresh does not ask again and again for a folder
//    that failed to open (868 errors in one hour, once), but opening that
//    folder again still tries;
//  - a phone or tablet with sessionhub open as a tab is offered the installed
//    app, once, and tapping the offer asks the browser to install.
// Needs headless Chrome on :9222.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\panelhome`;
const PROJ = `${SP}\\panelproj`;
const GONE = `${PROJ}\\gonefolder`;
const PORT = 7789;
const TOKEN = 'uji-panel';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
rmSync(PROJ, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
mkdirSync(GONE, { recursive: true });
writeFileSync(`${GONE}\\inside.txt`, 'x');
writeFileSync(`${HOME}\\.sessionhub\\config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nremote_commands = true\nprojects = ['${PROJ}']\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3000);
const cli = (...a) => spawnSync(BIN, [...a, '--home', HOME], { encoding: 'utf8' });
const id = cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'panel').stdout.trim();

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map(); const treeAsks = [];
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Network.webSocketFrameSent' && /"t":"tree"/.test(m.params.response.payloadData)) {
    treeAsks.push({ at: Date.now(), path: JSON.parse(m.params.response.payloadData).path });
  }
};
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr)) return true; await sleep(250); } return false; };
const row = (name) => `[...document.querySelectorAll('#side .frow')].find(r => r.textContent.includes('${name}'))`;
const asksForGone = () => treeAsks.filter((a) => /gonefolder$/.test(a.path)).length;

// ---- the file panel ----------------------------------------------------------
await cmd('Network.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 860, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}&t=panel` });
await sleep(4000);
await ev(`localStorage.setItem('sh.files.open', '1')`);
await cmd('Page.reload');
await sleep(4000);
check(await waitFor(`!!(${row('gonefolder')})`, 10000), 'the panel lists the folder');
await ev(`(${row('gonefolder')}).click()`);
check(await waitFor(`!!(${row('inside.txt')})`, 5000), 'opening it lists what is inside');

// The folder disappears while it is open, and the agent keeps writing — which
// is what makes the panel refresh itself every few seconds.
rmSync(GONE, { recursive: true, force: true });
const before = asksForGone();
cli('send', id, '1..40 | ForEach-Object { "work $_"; Start-Sleep -Milliseconds 700 }', '--enter');
await sleep(32000);
const during = asksForGone() - before;
check(during >= 1 && during <= 2, `while the agent writes for 30 s, the gone folder is asked for ${during} time(s), not over and over`);

// It comes back (or was only refused for a while): closing and opening it
// again tries again, though the quiet refresh no longer does.
mkdirSync(GONE, { recursive: true });
// The agent writes again: the quiet refresh lists the folder in its parent
// once more, and leaves the folder itself marked as failed.
cli('send', id, '1..20 | ForEach-Object { "more $_"; Start-Sleep -Milliseconds 700 }', '--enter');
await waitFor(`!!(${row('gonefolder')})`, 20000);
const beforeReopen = asksForGone();
await ev(`(${row('gonefolder')}).click()`);
await sleep(300);
await ev(`(${row('gonefolder')}).click()`);
await sleep(1500);
check(asksForGone() > beforeReopen, 'closing and opening it again tries again');

// ---- the install offer ------------------------------------------------------
await cmd('Emulation.setDeviceMetricsOverride', { width: 412, height: 900, deviceScaleFactor: 2, mobile: true });
await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'any-pointer', value: 'coarse' }, { name: 'pointer', value: 'coarse' }] });
await ev(`localStorage.removeItem('sh.install.offered')`);
// The browser's install dialog is `prompt` on the event; counted instead of
// shown. Chrome fires the real event itself now that the manifest and icons
// load without a token — the page is installable.
await cmd('Page.enable');
await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__prompted = 0;
  window.addEventListener('beforeinstallprompt', (e) => {
    window.__fired = true;
    window.__taken = () => e.defaultPrevented;
    Object.defineProperty(e, 'prompt', { value: () => { window.__prompted++; return Promise.resolve(); } });
  }, true);
` });
await cmd('Page.reload');
// Where the browser does not fire it (an older headless), the same event by hand.
const fire = `(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = () => { window.__prompted++; }; window.dispatchEvent(e); })()`;
if (!(await waitFor(`!!window.__fired`, 6000))) await ev(fire);
check(await waitFor(`!!document.querySelector('.toast[data-key="install"]')`, 3000), 'a touch screen with the page in a tab is offered the app');
check(await ev(`window.__taken ? window.__taken() : true`), "and the browser's own mini-bar is held back for it");
await ev(`document.querySelector('.toast[data-key="install"]').click()`);
check(await ev(`window.__prompted === 1`), "tapping the offer opens the browser's install dialog");
await cmd('Page.reload');
await sleep(4000);
await ev(fire);
await sleep(800);
check(!(await ev(`!!document.querySelector('.toast[data-key="install"]')`)), 'it is offered once, not again on the next visit');

cli('stop');
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
