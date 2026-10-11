// Right-click on a tab → "Copy reference" puts on the clipboard which terminal
// it is and the command that reads it. Needs headless Chrome on :9222.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\crhome`;
const PROJ = `${SP}\\crproj`;
const PORT = 7792;
const TOKEN = 'uji-copyref';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(`${HOME}\\.sessionhub\\config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nremote_commands = true\nprojects = ['${PROJ}']\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3000);
const cli = (...a) => spawnSync(BIN, [...a, '--home', HOME], { encoding: 'utf8' });
const id = cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'cr-alpha').stdout.trim();

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
const waitFor = async (expr, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr)) return true; await sleep(250); } return false; };

await cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
await cmd('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: `http://127.0.0.1:${PORT}` });
await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 860, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}` });
check(await waitFor(`!!document.querySelector('.tab[data-id="${id}"]')`, 10000), 'the terminal has a tab');
await ev(`(() => { const t = document.querySelector('.tab[data-id="${id}"]'); const r = t.getBoundingClientRect();
  t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 5, clientY: r.y + 5 })); })()`);
const item = `[...document.querySelectorAll('#menu *')].find(e => e.children.length === 0 && e.textContent.trim() === 'Copy reference')`;
check(await waitFor(`!!(${item})`, 3000), 'its menu offers Copy reference');
await ev(`(${item}).click()`);
await sleep(500);
const clip = await ev(`navigator.clipboard.readText()`);
console.log('    clipboard:', clip);
check(clip?.includes(`terminal ${id} "cr-alpha"`) && clip.includes('crproj'), 'it names the terminal and its folder');
check(clip?.endsWith('sessionhubd capture cr-alpha'), 'and the command that reads it, by name, with no --on for this machine');

cli('stop');
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
