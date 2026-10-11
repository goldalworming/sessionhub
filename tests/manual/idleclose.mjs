// A socket that says nothing for 150 s is dropped — a frozen background tab —
// while one that pings, as every page does, stays. Takes about three minutes.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\idlehome`;
const PORT = 7788;
const TOKEN = 'uji-idle';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
writeFileSync(`${HOME}\\.sessionhub\\config.toml`, `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3000);

function socket(name) {
  const s = { name, closedAt: 0, ws: new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`) };
  s.open = new Promise((r) => { s.ws.onopen = r; });
  s.ws.onclose = () => { s.closedAt = Date.now(); };
  return s;
}
const silent = socket('silent');
const pinging = socket('pinging');
await Promise.all([silent.open, pinging.open]);
const t0 = Date.now();
// Like a background tab the browser throttles: once a minute.
const beat = setInterval(() => pinging.ws.send(JSON.stringify({ t: 'ping' })), 60000);

await sleep(120000);
check(!silent.closedAt, 'after 2 minutes of silence, still connected (the limit is 150 s)');
await sleep(45000);
clearInterval(beat);
check(silent.closedAt > 0, `after 165 s of silence it has been dropped (at ${silent.closedAt ? Math.round((silent.closedAt - t0) / 1000) + ' s' : 'never'})`);
check(!pinging.closedAt, 'one that pings once a minute is still connected');

pinging.ws.close();
spawnSync(BIN, ['stop', '--home', HOME]);
daemon.kill();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
