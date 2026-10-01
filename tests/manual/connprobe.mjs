// A socket that still says OPEN over a line that died — a tablet waking from
// sleep, a tunnel that blinked — must not leave the page deaf for the minute
// `SILENT_MS` takes. `Conn.probe` (run on typing into a quiet link, and on the
// page coming back into view) has to notice within `PROBE_MS` and reconnect.
//
// The dead line is made by a proxy between the page's socket and a real daemon
// that, on cue, stops passing bytes in either direction while keeping both
// sockets open — exactly what such a link looks like from the browser.

import net from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\probehome`;
const PORT = 7756;
const PROXY = 7757;
const TOKEN = 'uji-probe';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(50); }
  return false;
};

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
writeFileSync(`${HOME}\\.sessionhub\\config.toml`, `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });

// The proxy. `freeze()` silences every pair open right now; later ones pass.
const pairs = new Set();
const proxy = net.createServer((client) => {
  const up = net.connect(PORT, '127.0.0.1');
  const pair = { frozen: false };
  pairs.add(pair);
  client.on('data', (d) => pair.frozen || up.write(d));
  up.on('data', (d) => pair.frozen || client.write(d));
  const end = () => { pairs.delete(pair); client.destroy(); up.destroy(); };
  client.on('close', end); up.on('close', end);
  client.on('error', end); up.on('error', end);
});
await new Promise((r) => proxy.listen(PROXY, '127.0.0.1', r));
const freeze = () => { for (const p of pairs) p.frozen = true; };

globalThis.location = { protocol: 'http:', host: `127.0.0.1:${PROXY}` };
const { Conn } = await import('file:///C:/data/code/terminal-editor2/sessionhubd/web/conn.js');

let opens = 0;
const events = [];
const conn = new Conn(TOKEN);
conn.on.onStatus = (k) => { events.push(k); if (k === 'open') opens += 1; };
for (let i = 0; i < 40 && opens === 0; i++) {
  conn.connect();
  if (await waitFor(() => opens > 0, 1500)) break;
}
check(opens === 1, 'connected through the proxy');
conn.send({ t: 'ping' });
check(await waitFor(() => conn.answers, 5000), 'the daemon answers pings (the probe arms only then)');

// --- a healthy link is left alone --------------------------------------------
conn.probe();
await sleep(11000);
check(!events.includes('lost') && opens === 1, 'probing a live link does not reconnect it');

// --- typing into a dead link -----------------------------------------------------
freeze();
await sleep(5500); // quiet for more than 5 s, as a dead link is
const typedAt = Date.now();
conn.sendInput(1, 'x');
const back = await waitFor(() => opens === 2, 16000);
const took = Date.now() - typedAt;
check(events.includes('lost'), 'the dead link is called lost');
check(back, `and reconnected ${took} ms after the key press, not after a minute`);
check(took < 15000, 'within the probe window');
check(conn.ready, 'the new socket is open');

conn.close();
proxy.close();
daemon.kill();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
