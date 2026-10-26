// Opening a terminal sends its replay packed (raw DEFLATE) when the browser can
// inflate it, and the screen comes out exactly as unpacked. A daemon that
// predates packing, and a browser that cannot inflate, both still get a whole
// screen. Two scratch daemons: `near` is this build, `far` an older one
// (FAR_BIN, the installed 0.0.56 by default), paired. Needs headless Chrome on
// :9222.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:/Users/user/AppData/Local/Temp/claude/C--data-code-terminal-editor2-sessionhubd/' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912/scratchpad';
const NEAR_BIN = process.env.SH_BIN || 'C:/data/code/terminal-editor2/sessionhubd/target/debug/sessionhubd.exe';
const FAR_BIN = process.env.FAR_BIN || 'C:/Users/user/AppData/Local/Programs/sessionhub/sessionhubd.exe';
const win = (p) => p.replaceAll('/', '\\');
const NEAR = { bin: NEAR_BIN, port: 7810, token: 'uji-pack-near', home: `${SP}/packnear`, proj: `${SP}/packproj-near` };
const FAR = { bin: FAR_BIN, port: 7811, token: 'uji-pack-far', home: `${SP}/packfar`, proj: `${SP}/packproj-far` };

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const m of [NEAR, FAR]) {
  rmSync(m.home, { recursive: true, force: true });
  rmSync(m.proj, { recursive: true, force: true });
  mkdirSync(`${m.home}/.sessionhub`, { recursive: true });
  mkdirSync(m.proj, { recursive: true });
  // About 1.8 MB of coloured lines, then a marker that must be on screen.
  writeFileSync(`${m.proj}/flood.py`,
    'import sys\n' +
    'for i in range(24000):\n' +
    '    sys.stdout.write("\\x1b[3%dmline %06d \\x1b[0m%s\\r\\n" % (i % 7 + 1, i, "abcdefghij" * 5))\n' +
    'sys.stdout.write("END-MARK-%s\\r\\n" % sys.argv[1])\n');
}
const cfg = (m, extra = '') =>
  `port = ${m.port}\nlan_access = false\ntoken = "${m.token}"\nprojects = ['${win(m.proj)}']\n${extra}`;
writeFileSync(`${FAR.home}/.sessionhub/config.toml`, cfg(FAR));
writeFileSync(`${NEAR.home}/.sessionhub/config.toml`,
  cfg(NEAR, `\n[[remotes]]\nname = "far"\naddr = "127.0.0.1:${FAR.port}"\ntoken = "${FAR.token}"\n`));

const daemons = [FAR, NEAR].map((m) =>
  spawn(m.bin, ['start', '--foreground', '--no-open', '--no-tray', '--home', m.home], { stdio: 'ignore' }));
await sleep(3500);
// Never the one of whatever terminal runs this test.
const { SESSIONHUB_TERMINAL: _own, ...bare } = process.env;
const cli = (m, args) => spawnSync(m.bin, [...args, '--home', m.home], { encoding: 'utf8', env: bare });
for (const [m, name] of [[NEAR, 'near'], [FAR, 'far']]) {
  m.term = cli(m, ['spawn', '--agent', 'terminal', '--project', win(m.proj)]).stdout.trim();
  await sleep(5000);
  cli(m, ['send', m.term, `python flood.py ${name}`, '--enter', '--raw']);
}
for (const m of [NEAR, FAR]) cli(m, ['wait', m.term, '--idle', '3', '--timeout', '60']);
check(/^\d+$/.test(NEAR.term) && /^\d+$/.test(FAR.term), `a flooded terminal on each machine (${NEAR.term}, ${FAR.term})`);

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
const sockets = new Map();
let frames = [];
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.webSocketCreated') sockets.set(m.params.requestId, m.params.url);
  for (const [method, dir] of [['Network.webSocketFrameSent', 'out'], ['Network.webSocketFrameReceived', 'in']]) {
    if (m.method !== method) continue;
    const r = m.params.response;
    frames.push({
      dir, url: sockets.get(m.params.requestId) || '', binary: r.opcode === 2,
      text: r.opcode === 1 ? r.payloadData : '',
      bytes: r.opcode === 2 ? Math.floor(r.payloadData.length * 3 / 4) : r.payloadData.length,
    });
  }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr)) return true; await sleep(250); } return false; };
const screen = `[...document.querySelectorAll('.xterm-rows')].filter(r => r.offsetParent).map(r => r.textContent).join('')`;
await cmd('Network.enable');
await cmd('Runtime.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });

/// The replay a page got for one socket: its `replay` message and the binary
/// frame right after it.
const replayOn = (via) => {
  const on = frames.filter((f) => f.dir === 'in' && (via ? f.url.includes(`via=${via}`) : !f.url.includes('via=')));
  const i = on.findIndex((f) => /"t":"replay"/.test(f.text));
  return i < 0 ? null : { msg: JSON.parse(on[i].text), frame: on.slice(i + 1).find((f) => f.binary) };
};

// 1. This build, a browser that can inflate: packed.
frames = [];
let began = Date.now();
await cmd('Page.navigate', { url: `http://127.0.0.1:${NEAR.port}/?token=${NEAR.token}&t=${NEAR.term}` });
check(await waitFor(`(${screen}).includes('END-MARK-near')`, 20000), `the screen comes back whole (${Date.now() - began} ms)`);
const asked = frames.find((f) => f.dir === 'out' && !f.url.includes('via=') && /"t":"attach"/.test(f.text));
check(asked && /"deflate":true/.test(asked.text), 'the page asks for a packed replay');
const near = replayOn('');
check(near?.msg.deflate === true && near.frame, `and gets one (${near?.frame?.bytes} bytes on the wire)`);
const log = readFileSync(`${NEAR.home}/.sessionhub/sessionhubd.log`, 'utf8');
const line = [...log.matchAll(/client attached .*replay=(\d+) wire=(\d+)/g)].pop();
const [ring, wire] = line ? [Number(line[1]), Number(line[2])] : [0, 0];
check(ring > 1_000_000 && wire > 0 && wire * 4 < ring, `the daemon packed ${ring} bytes into ${wire} (${(ring / Math.max(wire, 1)).toFixed(1)}x)`);
check(await ev(`!!document.querySelector('.xterm-rows') && !document.body.textContent.includes('reconnecting')`), 'no reconnect, nothing left waiting');
const packedScreen = await ev(screen);

// 2. A machine still on the old daemon, through the relay: unpacked, still whole.
frames = [];
await ev(`[...document.querySelectorAll('.mtab')].find(t => t.textContent.includes('far'))?.click()`);
await sleep(1500);
await ev(`document.querySelector('[data-id="${FAR.term}"]')?.click()`);
check(await waitFor(`(${screen}).includes('END-MARK-far')`, 20000), 'a machine that predates packing still shows its whole screen');
const far = replayOn('far');
check(far && !far.msg.deflate && far.frame?.bytes > 1_000_000, `unpacked from it (${far?.frame?.bytes} bytes)`);

// 3. A browser that cannot inflate: never asks, gets it unpacked — over a slow
// link, timed, against the same open packed below.
const SLOW = { offline: false, latency: 150, downloadThroughput: 250_000, uploadThroughput: 125_000 };
const openTimed = async () => {
  await cmd('Network.emulateNetworkConditions', SLOW);
  const t0 = Date.now();
  await cmd('Page.navigate', { url: `http://127.0.0.1:${NEAR.port}/?token=${NEAR.token}&t=${NEAR.term}` });
  const ok = await waitFor(`(${screen}).includes('END-MARK-near')`, 60000);
  const ms = Date.now() - t0;
  await cmd('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  return { ok, ms };
};
frames = [];
await cmd('Page.enable');
const hide = await cmd('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(window, 'DecompressionStream', { value: undefined, configurable: true });" });
const slowPlain = await openTimed();
check(slowPlain.ok, 'a browser without DecompressionStream still gets the whole screen');
const plain = frames.find((f) => f.dir === 'out' && !f.url.includes('via=') && /"t":"attach"/.test(f.text));
check(plain && !/"deflate":true/.test(plain.text) && !replayOn('')?.msg.deflate, 'it never asks, and nothing comes packed');
check(await waitFor(`(${screen}) === ${JSON.stringify(packedScreen)}`, 5000), 'and its screen is exactly the one the packed replay drew');

// 4. The same open, packed, on the same slow link.
await cmd('Page.removeScriptToEvaluateOnNewDocument', { identifier: hide.result.identifier });
const slowPacked = await openTimed();
check(slowPacked.ok && slowPacked.ms < slowPlain.ms,
  `on a 2 Mbit/s, 150 ms link: ${slowPlain.ms} ms unpacked, ${slowPacked.ms} ms packed`);

// 5. Inflating fails: the page stops asking and puts the screen right unpacked.
frames = [];
const broken = await cmd('Page.addScriptToEvaluateOnNewDocument', { source:
  "window.DecompressionStream = class extends TransformStream { constructor() { super({ transform() { throw new Error('broken on purpose'); } }); } };" });
await cmd('Page.navigate', { url: `http://127.0.0.1:${NEAR.port}/?token=${NEAR.token}&t=${NEAR.term}` });
check(await waitFor(`(${screen}).includes('END-MARK-near')`, 30000) && await ev(screen) === packedScreen,
  'when a packed replay will not inflate, the screen still comes back whole');
// The ask comes once the terminal has been quiet a moment (`RESYNC_QUIET_MS`).
const attaches = () => frames.filter((f) => f.dir === 'out' && !f.url.includes('via=') && /"t":"attach"/.test(f.text)).map((f) => JSON.parse(f.text).deflate);
const until = Date.now() + 10000;
while (attaches().at(-1) !== false && Date.now() < until) await sleep(250);
check(attaches()[0] === true && attaches().at(-1) === false, `by asking again unpacked (${JSON.stringify(attaches())})`);
await cmd('Page.removeScriptToEvaluateOnNewDocument', { identifier: broken.result.identifier });

for (const m of [NEAR, FAR]) cli(m, ['stop']);
for (const d of daemons) d.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
