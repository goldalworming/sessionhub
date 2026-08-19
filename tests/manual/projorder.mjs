// Where a folder you are working in sits in the project list.
//
// The registry orders projects by their newest agent session. A plain shell is
// not a session, so a folder with no agent history sank to the very bottom the
// moment you opened a terminal in it — under every project with any history at
// all, which is where it was hardest to find at exactly the moment it was being
// used. Reported from real use: "saat saya membuat terminal baru di folder data,
// posisinya ternyata ada paling bawah".
//
// The fixture is built to make the old behaviour fail loudly: a folder with no
// sessions is registered LAST, so registry order alone would leave it last.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1af81868-b2d4-4560-8e29-8ce58f28d35a\\scratchpad';
const BIN = 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\orderhome`;
const ROOT = `${SP}\\orderproj`;
const PORT = 7735;
const TOKEN = 'uji-urutan';

const steps = [];
const check = (c, m) => {
  steps.push(c);
  console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = async () => {
  try {
    return (await (await fetch(`http://127.0.0.1:${PORT}/api/status?token=${TOKEN}`)).json()).version;
  } catch {
    return null;
  }
};

// Three folders, none of them with agent sessions, registered in a fixed order.
const NAMES = ['alpha', 'beta', 'data'];
rmSync(HOME, { recursive: true, force: true });
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
for (const n of NAMES) mkdirSync(`${ROOT}\\${n}`, { recursive: true });
writeFileSync(
  `${HOME}\\.sessionhub\\config.toml`,
  [
    `port = ${PORT}`,
    'lan_access = false',
    `token = "${TOKEN}"`,
    'projects = [',
    ...NAMES.map((n) => `  "${`${ROOT}\\${n}`.split('\\').join('\\\\')}",`),
    ']',
    '',
  ].join('\n'),
);

spawn(BIN, ['start', '--home', HOME], { detached: true, stdio: 'ignore' }).unref();
for (let i = 0; i < 40 && !(await alive()); i++) await sleep(500);
check(!!(await alive()), `test daemon up on ${PORT}`);

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
const msgs = [];
await new Promise((r) => {
  ws.onopen = r;
});
ws.onmessage = (e) => {
  if (typeof e.data === 'string') msgs.push(JSON.parse(e.data));
};
const state = async () => {
  msgs.length = 0;
  ws.send(JSON.stringify({ t: 'list' }));
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const st = msgs.filter((m) => m.t === 'state').pop();
    if (st) return st;
  }
  return null;
};
const order = (st) => st.projects.map((p) => p.name);

await sleep(2500);
const first = await state();
console.log(`    before: ${order(first).join(', ')}`);
check(
  order(first).indexOf('data') === order(first).length - 1,
  'with nothing running, `data` sits last — the fixture the old behaviour produced',
);

// Open a terminal in the last one.
const proj = `${ROOT}\\data`;
ws.send(
  JSON.stringify({ t: 'spawn', project: proj, agent: 'terminal', resume: null, cols: 90, rows: 26 }),
);
await sleep(2500);
const tid = msgs.filter((m) => m.t === 'attached').pop()?.id;
check(tid !== undefined, 'a terminal opens in it');

const withTerm = await state();
console.log(`    running: ${order(withTerm).join(', ')}`);
check(order(withTerm)[0] === 'data', 'the folder being worked in comes first');
check(
  order(withTerm).slice(1).join(',') === 'alpha,beta',
  'and the others keep the order they had — only the band changed',
);

// Naming it keeps it high even once the terminal is gone: it is still something
// set up here on purpose.
ws.send(JSON.stringify({ t: 'save_terminal', id: tid, name: 'prevent-sleep', command: '' }));
await sleep(1200);
ws.send(JSON.stringify({ t: 'kill', id: tid }));
await sleep(1800);

const afterKill = await state();
console.log(`    saved:   ${order(afterKill).join(', ')}`);
check(
  order(afterKill)[0] === 'data',
  'and a saved terminal keeps it above folders with nothing set up in them',
);

// A folder with neither goes back to where it was.
ws.send(JSON.stringify({ t: 'forget_terminal', project: proj, name: 'prevent-sleep' }));
await sleep(1500);
const afterForget = await state();
console.log(`    forgot:  ${order(afterForget).join(', ')}`);
check(
  order(afterForget).indexOf('data') === order(afterForget).length - 1,
  'forgetting it lets the folder fall back to plain registry order',
);

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
ws.close();
spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
await sleep(1500);
process.exit(steps.every(Boolean) ? 0 : 1);
