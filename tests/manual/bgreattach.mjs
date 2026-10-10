// A paired machine whose link drops and comes back while another machine is
// on screen: its terminals must work again when it is switched back to —
// output arriving, typing echoed — without a click in the sidebar.
// Two scratch daemons (one paired as "far"), a cutting proxy in front of the
// page, headless Chrome on :9222.

import net from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const A = { home: `${SP}\\bgA`, port: 7782, token: 'uji-bg-a' };
const B = { home: `${SP}\\bgB`, port: 7783, token: 'uji-bg-b' };
const PROJ = `${SP}\\bgproj`;
const PROXY = 7784;

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(PROJ, { recursive: true });
for (const d of [A, B]) {
  rmSync(d.home, { recursive: true, force: true });
  mkdirSync(`${d.home}\\.sessionhub`, { recursive: true });
}
writeFileSync(`${B.home}\\.sessionhub\\config.toml`,
  `port = ${B.port}\nlan_access = false\ntoken = "${B.token}"\nremote_commands = true\nprojects = ['${PROJ}']\n`);
writeFileSync(`${A.home}\\.sessionhub\\config.toml`,
  `port = ${A.port}\nlan_access = false\ntoken = "${A.token}"\nremote_commands = true\nprojects = ['${PROJ}']\n\n` +
  `[[remotes]]\nname = "far"\naddr = "127.0.0.1:${B.port}"\ntoken = "${B.token}"\n`);
const daemons = [A, B].map((d) => spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', d.home], { stdio: 'ignore' }));
await sleep(3500);
const cli = (d, ...a) => spawnSync(BIN, [...a, '--home', d.home], { encoding: 'utf8' });
const farId = cli(B, 'spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'farterm').stdout.trim();
const nearId = cli(A, 'spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'nearterm').stdout.trim();
check(/^\d+$/.test(farId) && /^\d+$/.test(nearId), `a terminal on each machine (${nearId}, far ${farId})`);

const socks = new Set();
const proxy = net.createServer((client) => {
  const up = net.connect(A.port, '127.0.0.1');
  socks.add(client); socks.add(up);
  client.pipe(up); up.pipe(client);
  const end = () => { client.destroy(); up.destroy(); socks.delete(client); socks.delete(up); };
  client.on('error', end); up.on('error', end); client.on('close', end); up.on('close', end);
});
await new Promise((r) => proxy.listen(PROXY, '127.0.0.1', r));
const cut = () => { for (const s of socks) s.destroy(); };

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr)) return true; await sleep(250); } return false; };
const screen = `[...document.querySelectorAll('.xterm-rows')].filter(r => r.offsetParent).map(r => r.textContent).join('')`;
const machineTab = (label) => `[...document.querySelectorAll('#mbar *')].find(e => e.children.length === 0 && e.textContent.trim() === '${label}')?.closest('button,[data-id],.mtab') || [...document.querySelectorAll('#mbar *')].find(e => e.children.length === 0 && e.textContent.trim() === '${label}')`;

await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `http://127.0.0.1:${PROXY}/?token=${A.token}` });
await sleep(5000);

// Open the far machine's terminal, then go back to this machine.
check(await waitFor(`!!(${machineTab('far')})`, 10000), 'the far machine has a tab');
await ev(`(${machineTab('far')}).click()`);
check(await waitFor(`!!document.querySelector('.tab[data-id="${farId}"]')`, 10000), 'its terminal shows as a tab');
await ev(`document.querySelector('.tab[data-id="${farId}"]').click()`);
await sleep(1500);
await ev(`(${machineTab('This machine')}).click()`);
await sleep(1000);

// The links drop and come back while this machine is the one on screen.
cut();
await sleep(6000);

// Back to the far machine: something printed now must show, and typing there
// must echo, with no click in the sidebar.
await ev(`(${machineTab('far')}).click()`);
await sleep(1500);
cli(B, 'send', farId, 'echo AFTER-DROP-91', '--enter');
check(await waitFor(`/AFTER-DROP-91/.test(${screen})`, 10000), 'output printed after the drop arrives on screen');
await ev(`document.querySelector('.xterm-helper-textarea:not([disabled])') && [...document.querySelectorAll('.xterm-helper-textarea')].find(t => t.closest('.xterm').offsetParent)?.focus()`);
for (const ch of 'echo TYPED-92') await cmd('Input.dispatchKeyEvent', { type: 'char', text: ch });
await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
check(await waitFor(`/TYPED-92[\\s\\S]*TYPED-92/.test(${screen})`, 10000), 'typing there is echoed and runs');

for (const d of [A, B]) cli(d, 'stop');
daemons.forEach((p) => p.kill());
proxy.close();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
