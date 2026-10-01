// A terminal that is not on screen keeps its output and writes it when shown
// again — it does not throw its screen away for a replay, which redraws an
// agent's whole history at today's size and came back as lost letters and stale
// status lines after a few resizes.
//
// Needs headless Chrome on :9222.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\heldhome`;
const PROJ = `${SP}\\heldproj`;
const PORT = 7758;
const TOKEN = 'uji-held';

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

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
const attaches = [];
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Network.webSocketFrameSent' && /"t":"attach"/.test(m.params.response.payloadData)) {
    attaches.push(JSON.parse(m.params.response.payloadData).id);
  }
};
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await ev(expr)) return true; await sleep(200); }
  return false;
};

await cmd('Network.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(4000);

// Two shells, from the CLI: the second spawned is the one on screen.
const a = cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'held-a').stdout.trim();
await sleep(1500);
const b = cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'held-b').stdout.trim();
check(/^\d+$/.test(a) && /^\d+$/.test(b), `two terminals spawned (${a}, ${b})`);
check(await waitFor(`document.querySelectorAll('.tab').length >= 2`, 15000), 'both appear as tabs');
// Each shown once first: a terminal the page has never drawn needs its one
// attach to have a screen at all — that is not the replay under test.
await ev(`[...document.querySelectorAll('.tab')].find(t => t.dataset.id === '${a}').click()`);
await sleep(2500);
await ev(`[...document.querySelectorAll('.tab')].find(t => t.dataset.id === '${b}').click()`);
await sleep(2500);
check(await ev(`document.querySelector('.tab.active')?.dataset.id === '${b}'`), `terminal ${b} is on screen, ${a} hidden`);

// Output for the hidden one.
cli('send', a, 'echo HELD-MARK-7731', '--enter');
await sleep(3000);

const sentBefore = attaches.length;
await ev(`[...document.querySelectorAll('.tab')].find(t => t.dataset.id === '${a}').click()`);
const shown = await waitFor(`[...document.querySelectorAll('.xterm-rows')].some(r => r.offsetParent && /HELD-MARK-7731/.test(r.textContent))`, 6000);
check(shown, 'switching back shows what was printed while it was hidden');
check(!attaches.slice(sentBefore).includes(Number(a)), 'and no replay was asked for to do it');

cli('stop');
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
