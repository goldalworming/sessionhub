// Going back to a terminal already open, from the sidebar, must not fetch its
// whole history again: it was attached all along. What it printed while hidden
// still shows. Needs headless Chrome on :9222.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\swhome`;
const PROJ = `${SP}\\swproj`;
const PORT = 7791;
const TOKEN = 'uji-switch';

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
const a = cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'sw-alpha').stdout.trim();
const b = cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'sw-beta').stdout.trim();

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map(); const attaches = []; let binBytes = 0;
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Network.webSocketFrameSent' && /"t":"attach"/.test(m.params.response.payloadData)) {
    attaches.push(JSON.parse(m.params.response.payloadData));
  }
  if (m.method === 'Network.webSocketFrameReceived' && m.params.response.opcode === 2) {
    binBytes += Math.floor(m.params.response.payloadData.length * 3 / 4);
  }
};
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
const waitFor = async (expr, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr)) return true; await sleep(250); } return false; };
const screen = `[...document.querySelectorAll('.xterm-rows')].filter(r => r.offsetParent).map(r => r.textContent).join('')`;
// The sidebar row for a terminal, by its name: a session row, not the tab.
const sideRow = (name) => `[...document.querySelectorAll('#tree *')].filter(e => e.children.length === 0 && e.textContent.trim() === '${name}').map(e => e.closest('[data-id],[data-session],.session,.row,.trow') || e.parentElement)[0]`;

await cmd('Network.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 860, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}` });
await sleep(4000);

// Both open, with plenty already in each.
for (const [id, mark] of [[a, 'ALPHA'], [b, 'BETA']]) {
  cli('send', id, `1..3000 | ForEach-Object { "${mark} history line $_" }`, '--enter');
}
// Until both have finished printing: an echo sent before that waits in line.
for (const name of ['sw-alpha', 'sw-beta']) {
  const until = Date.now() + 30000;
  while (Date.now() < until && !/history line 3000/.test(cli('capture', name, '--lines', '5').stdout)) await sleep(500);
}
await ev(`document.querySelector('.tab[data-id="${a}"]').click()`);
await sleep(1500);
await ev(`document.querySelector('.tab[data-id="${b}"]').click()`);
await sleep(1500);
check(await waitFor(`!!(${sideRow('sw-alpha')})`, 5000), 'the sidebar lists both terminals');

// Back and forth from the sidebar, with sw-alpha printing while hidden.
attaches.length = 0; binBytes = 0;
cli('send', a, 'echo WHILE-HIDDEN-63', '--enter');
await sleep(1500);
for (let i = 0; i < 3; i++) {
  await ev(`(${sideRow('sw-alpha')}).click()`);
  await sleep(1200);
  await ev(`(${sideRow('sw-beta')}).click()`);
  await sleep(1200);
}
await ev(`(${sideRow('sw-alpha')}).click()`);
await sleep(1500);
const full = attaches.filter((x) => x.since === undefined).length;
check(full === 0, `six switches from the sidebar fetch no whole history (${attaches.length} attach(es), ${full} full)`);
check(binBytes < 50000, `and move little data (${Math.round(binBytes / 1024)} KB)`);
check(await ev(`document.querySelector('.tab.active')?.dataset.id`) === a, 'the clicked terminal is the one shown');
check(await waitFor(`/WHILE-HIDDEN-63/.test(${screen})`, 5000), 'what it printed while hidden is on screen');

cli('stop');
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
