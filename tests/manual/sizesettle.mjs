// A layout that wobbles for a moment must not resize the terminal: every
// resize makes the agent redraw its whole screen. A real change still goes
// through, once. Needs headless Chrome on :9222.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\settlehome`;
const PROJ = `${SP}\\settleproj`;
const PORT = 7786;
const TOKEN = 'uji-settle';

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
cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'settle');

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map(); const resizes = [];
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Network.webSocketFrameSent' && /"t":"resize"/.test(m.params.response.payloadData)) {
    resizes.push(JSON.parse(m.params.response.payloadData));
  }
};
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
const size = (h) => cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: h, deviceScaleFactor: 1, mobile: false });

await cmd('Network.enable');
await size(820);
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}&t=settle` });
await sleep(5000);
check(await ev(`!!document.querySelector('.tab.active')`), 'the terminal is open');

// A wobble: 40 px shorter, then back, within a tenth of a second — twice.
resizes.length = 0;
for (let i = 0; i < 2; i++) {
  await size(780);
  await sleep(60);
  await size(820);
  await sleep(1500);
}
check(resizes.length === 0, `a layout that wobbles and comes back sends no resize (${resizes.length} sent)`);

// A real change: shorter, and it stays so.
resizes.length = 0;
await size(700);
await sleep(1500);
check(resizes.length === 1, `a change that holds is sent once (${resizes.length} sent: ${resizes.map((r) => r.rows).join(',')})`);
const rows = JSON.parse(cli('ls', '--json').stdout).find((t) => t.name === 'settle').rows;
check(resizes[0] && rows === resizes[0].rows, `and the terminal takes that size (${rows} rows)`);

cli('stop');
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
