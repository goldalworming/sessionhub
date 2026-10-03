// Less sent to a page off screen, and bursts folded: a hidden socket gets
// `terminals` (not `state`, not `load`), still sees work finish, and gets the
// whole state once it shows again; a burst of changes is not one `state` each.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\briefhome`;
const PROJ = `${SP}\\briefproj`;
const PORT = 7769;
const TOKEN = 'uji-brief';

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

function client() {
  const c = { got: [], ws: new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`) };
  c.ws.onmessage = (e) => { if (typeof e.data === 'string') c.got.push(JSON.parse(e.data)); };
  c.open = new Promise((r) => { c.ws.onopen = r; });
  c.count = (t) => c.got.filter((m) => m.t === t).length;
  c.send = (o) => c.ws.send(JSON.stringify(o));
  return c;
}
const seen = client();
const away = client();
await Promise.all([seen.open, away.open]);
await sleep(500);
away.send({ t: 'visibility', visible: false });
await sleep(300);
seen.got.length = 0;
away.got.length = 0;

// A burst: five terminals as fast as the CLI can make them.
for (let i = 0; i < 5; i++) cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', `b${i}`);
await sleep(4000);
const states = seen.count('state');
check(states >= 1 && states < 5, `a burst of five changes reached the visible page as ${states} state(s)`);
const last = seen.got.filter((m) => m.t === 'state').at(-1);
check(last?.terminals?.length === 5, 'and the last one has all five terminals');
check(away.count('state') === 0, `the hidden page got no state (${away.count('state')})`);
check(away.count('terminals') >= 1, `it got the terminals alone (${away.count('terminals')})`);
const lastBrief = away.got.filter((m) => m.t === 'terminals').at(-1);
check(lastBrief?.terminals?.length === 5 && !('projects' in lastBrief), 'all five, without the project list');
check(seen.count('load') >= 1 && away.count('load') === 0, `load only to the visible page (${seen.count('load')} / ${away.count('load')})`);

// Back on screen: the whole state at once.
away.got.length = 0;
away.send({ t: 'visibility', visible: true });
await sleep(500);
check(away.count('state') === 1, 'shown again: one full state straight away');

cli('stop');
daemon.kill();
seen.ws.close();
away.ws.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
