// The typing telemetry: keystrokes to a shell are timed from key to echo and
// from echo to drawn, summed up once a minute (`typing`), and a slow one is
// reported at once (`slow_echo`) with the network's share named.
//
// The page reaches the daemon through a proxy that can hold every byte back,
// which is what a slow link looks like. Needs headless Chrome on :9222; takes
// about two and a half minutes (the summary is once a minute).

import net from 'node:net';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\typehome`;
const PROJ = `${SP}\\typeproj`;
const PORT = 7765;
const PROXY = 7766;
const TOKEN = 'uji-type';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(`${HOME}\\.sessionhub\\config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nremote_commands = true\nprojects = ['${PROJ}']\n\n[telemetry]\nenabled = true\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3000);
const cli = (...a) => spawnSync(BIN, [...a, '--home', HOME], { encoding: 'utf8' });
const events = (name) => {
  const f = `${HOME}\\.sessionhub\\telemetry.jsonl`;
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.e === name);
};

// Each way, every chunk delivered `delay` ms after it arrived — a link's
// latency, not a queue: chunks in flight together arrive together, in order.
let delay = 0;
const proxy = net.createServer((client) => {
  const up = net.connect(PORT, '127.0.0.1');
  // Delivery times, per direction; closing waits for what is still on its way.
  let due = 0;
  const relay = (from, to) => {
    let last = 0;
    from.on('data', (d) => {
      const at = Math.max(Date.now() + delay, last);
      last = at;
      due = Math.max(due, at);
      setTimeout(() => to.write(d), Math.max(0, at - Date.now()));
    });
  };
  relay(client, up); relay(up, client);
  let closing = false;
  const end = () => {
    if (closing) return;
    closing = true;
    setTimeout(() => { client.destroy(); up.destroy(); }, Math.max(0, due - Date.now()) + 50);
  };
  client.on('error', end); up.on('error', end); client.on('close', end); up.on('close', end);
});
await new Promise((r) => proxy.listen(PROXY, '127.0.0.1', r));

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const key = async (ch) => {
  const code = `Key${ch.toUpperCase()}`;
  await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
  await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
};

await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: 'about:blank' });
await sleep(300);
await cmd('Page.navigate', { url: `http://127.0.0.1:${PROXY}/?token=${TOKEN}` });
await sleep(4000);
console.log('  page:', await ev(`location.href`), '| tabs:', await ev(`document.querySelectorAll('.mtab').length`));
const id = cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'type-t').stdout.trim();
for (let i = 0; i < 50 && !(await ev(`!!document.querySelector('.tab[data-id="${id}"]')`)); i++) await sleep(200);
await ev(`document.querySelector('.tab[data-id="${id}"]').click()`);
await sleep(4000);
await ev(`[...document.querySelectorAll('.xterm-helper-textarea')].find(t => t.closest('.xterm').offsetParent)?.focus()`);
// A ping or two first, so the round trip is known.
await sleep(16000);

// A healthy link: typing gets a summary, and nothing is called slow.
const t0 = Date.now();
for (const ch of 'abcdefghij') { await key(ch); await sleep(200); }
while (Date.now() - t0 < 64000 && !events('typing').length) await sleep(1000);
const fast = events('typing')[0];
check(!!fast && fast.n >= 5, `a minute of typing is summed up once (n=${fast?.n})`);
check(fast && fast.echo_p50 < 300 && fast.rtt_p50 >= 0 && fast.rtt_p50 < 100, `echo ${fast?.echo_p50} ms, rtt ${fast?.rtt_p50} ms on a healthy link`);
check(!events('slow_echo').length, 'and no keystroke is called slow');

// A slow link: 600 ms each way.
delay = 600;
await sleep(16000); // a ping through it, so rtt shows the delay
const t1 = Date.now();
for (const ch of 'klmnop') { await key(ch); await sleep(1800); }
// Telemetry is batched in the page and written by the daemon every few seconds.
for (let i = 0; i < 60 && !events('slow_echo').length; i++) await sleep(1000);
const slow = events('slow_echo')[0];
check(!!slow, 'a keystroke slower than a second is reported at once');
check(slow && slow.echo >= 1100 && slow.paint < 300, `with the time where it went: echo ${slow?.echo} ms, paint ${slow?.paint} ms`);
check(slow && slow.rtt >= 1100, `and the link's own round trip shows it is the network (rtt ${slow?.rtt} ms)`);
check(events('slow_echo').length === 1, 'reported once, not once per key');
while (Date.now() - t1 < 130000 && events('typing').length < 2) await sleep(1000);
const after = events('typing')[1];
check(after && after.echo_p50 >= 1100, `the next summary shows it too (echo_p50 ${after?.echo_p50} ms)`);

cli('stop');
daemon.kill();
proxy.close();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
