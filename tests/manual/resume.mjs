// A page that reconnects gets only the output it missed, not the whole ring
// buffer again — and its screen keeps what it had.
//
// The page reaches the daemon through a TCP proxy this script can cut, which is
// what a phone sleeping or the tunnel blinking looks like to it. Needs headless
// Chrome on :9222.

import net from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\resumehome`;
const PROJ = `${SP}\\resumeproj`;
const PORT = 7760;
const PROXY = 7761;
const TOKEN = 'uji-resume';

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

const socks = new Set();
const proxy = net.createServer((client) => {
  const up = net.connect(PORT, '127.0.0.1');
  socks.add(client); socks.add(up);
  client.pipe(up); up.pipe(client);
  const end = () => { client.destroy(); up.destroy(); socks.delete(client); socks.delete(up); };
  client.on('error', end); up.on('error', end); client.on('close', end); up.on('close', end);
});
await new Promise((r) => proxy.listen(PROXY, '127.0.0.1', r));
const cut = () => { for (const s of socks) s.destroy(); };

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
const sentAttach = []; const gotReplay = []; let binBytes = 0;
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Network.webSocketFrameSent' && /"t":"attach"/.test(m.params.response.payloadData)) {
    sentAttach.push(JSON.parse(m.params.response.payloadData));
  }
  if (m.method === 'Network.webSocketFrameReceived') {
    const r = m.params.response;
    if (r.opcode === 2) binBytes += Math.floor(r.payloadData.length * 3 / 4) - 4;
    else if (/"t":"replay"/.test(r.payloadData)) gotReplay.push(JSON.parse(r.payloadData));
  }
};
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await ev(expr)) return true; await sleep(200); }
  return false;
};
const screen = `[...document.querySelectorAll('.xterm-rows')].filter(r => r.offsetParent).map(r => r.textContent).join('')`;

await cmd('Network.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
await ev(`location.href = 'http://127.0.0.1:${PROXY}/?token=${TOKEN}'`);
await sleep(4000);

const id = cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'resume-t').stdout.trim();
check(await waitFor(`!!document.querySelector('.tab[data-id="${id}"]')`, 10000), `terminal ${id} has a tab`);
await ev(`document.querySelector('.tab[data-id="${id}"]').click()`);
await sleep(2500);
// Enough output that a full replay would be unmistakable.
cli('send', id, '1..4000 | ForEach-Object { "filler line $_ of the history" }; echo BEFORE-MARK-41', '--enter');
check(await waitFor(`/BEFORE-MARK-41/.test(${screen})`, 20000), 'the screen shows output from before');

binBytes = 0; sentAttach.length = 0; gotReplay.length = 0;
cut();
await sleep(150);
cli('send', id, 'echo DURING-MARK-42', '--enter');
check(await waitFor(`/DURING-MARK-42/.test(${screen})`, 15000), 'after reconnecting it shows what was printed while cut off');
check(await ev(`/BEFORE-MARK-41/.test(${screen})`), 'and still shows what it had before');
const a = sentAttach.find((x) => x.id === Number(id));
check(!!a && typeof a.since === 'number' && typeof a.tail === 'number', `it asked to resume (since=${a?.since})`);
const r = gotReplay.find((x) => x.id === Number(id));
check(!!r && a && r.from === a.since, `and the daemon resumed from there (from=${r?.from})`);
check(binBytes < 20000, `only what it missed came over: ${binBytes} bytes`);
// (A position the daemon cannot vouch for falls back to a full replay — see
// the `ring::resume` tests.)

cli('stop');
daemon.kill();
proxy.close();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
