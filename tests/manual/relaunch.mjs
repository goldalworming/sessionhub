// Updating an agent, and putting the new build to work.
//
// `claude update` installs in place, but a process that is already running keeps
// the binary it started with — Claude Code says so itself: "Update installed ·
// Restart to update". So sessionhub does the second half: restart the terminal
// where it stands.
//
// Relaunch keeps the terminal id. That is what makes it a restart rather than a
// new tab: the tab stays put, everyone attached stays attached, and the saved
// name and colour ride along. The subtle part is that the replaced process dies
// moments after its replacement starts, and both answer to the same terminal id
// — so its dying EOF must not mark the new terminal dead.

import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1af81868-b2d4-4560-8e29-8ce58f28d35a\\scratchpad';
const BIN = 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\relhome`;
const PROJ = `${SP}\\relproj`;
const PORT = 7745;
const TOKEN = 'uji-relaunch';

const steps = [];
const check = (c, m) => {
  steps.push(c);
  console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/api/status?token=${TOKEN}`)).json();
  } catch {
    return null;
  }
};

// A stray child from an earlier run can still hold the folder open on Windows,
// and being unable to delete it is no reason to refuse to run. What has to be
// fresh is the counter the assertions read.
const wipe = (p) => {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    // held open by something that has not finished dying yet
  }
};
wipe(HOME);
wipe(PROJ);
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
wipe(`${PROJ}\\runs.txt`);
// A stand-in agent: it prints which run it is, so a relaunch is visible, and it
// stays alive like a real one.
writeFileSync(
  `${PROJ}\\fakeagent.bat`,
  '@echo off\r\n' +
    'set /a N=1\r\n' +
    'if exist "%~dp0runs.txt" (for /f %%A in (\'type "%~dp0runs.txt"\') do set /a N=%%A+1)\r\n' +
    'echo %N% > "%~dp0runs.txt"\r\n' +
    'echo AGENT-RUN-%N% args=%*\r\n' +
    ':loop\r\n' +
    'timeout /t 5 /nobreak > nul\r\n' +
    'goto loop\r\n',
);
writeFileSync(
  `${HOME}\\.sessionhub\\config.toml`,
  [
    `port = ${PORT}`,
    'lan_access = false',
    `token = "${TOKEN}"`,
    `projects = ["${PROJ.split('\\').join('\\\\')}"]`,
    '',
    '[agents.faux]',
    `command = '${PROJ}\\fakeagent.bat'`,
    'resume_args = ["--resume", "{session_id}"]',
    'enabled = true',
    'fork_args = []',
    'update_args = ["--do-update"]',
    '',
  ].join('\n'),
);
spawn(BIN, ['start', '--home', HOME], { detached: true, stdio: 'ignore' }).unref();
for (let i = 0; i < 40 && !(await alive()); i++) await sleep(500);
check(!!(await alive()), `test daemon up on ${PORT}`);

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
ws.binaryType = 'arraybuffer';
const msgs = [];
let screen = '';
await new Promise((r) => {
  ws.onopen = r;
});
ws.onmessage = (e) => {
  if (typeof e.data === 'string') msgs.push(JSON.parse(e.data));
  else screen += Buffer.from(e.data).subarray(4).toString('utf8');
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
const waitScreen = async (re, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (re.test(screen)) return true;
    await sleep(200);
  }
  return false;
};

// --- a session running, with a name and a colour ----------------------------
ws.send(
  JSON.stringify({
    t: 'spawn',
    project: PROJ,
    agent: 'faux',
    resume: 'sesi-lama',
    cols: 90,
    rows: 26,
  }),
);
await sleep(2500);
const id = msgs.filter((m) => m.t === 'attached').pop()?.id;
check(id !== undefined, `a session is running (terminal ${id})`);
check(await waitScreen(/AGENT-RUN-1/), 'the agent started once');
check(/--resume sesi-lama/.test(screen), 'and was given the session to resume');

ws.send(JSON.stringify({ t: 'set_color', id, color: 'magenta' }));
await sleep(500);
ws.send(JSON.stringify({ t: 'save_terminal', id, name: 'agen', command: '' }));
await sleep(1000);

const before = await state();
const b = before.terminals.find((t) => t.id === id);
check(b && b.alive && b.name === 'agen' && b.color === 'magenta', 'named, coloured, alive');

// --- relaunch ---------------------------------------------------------------
screen = '';
ws.send(JSON.stringify({ t: 'relaunch', id, cols: 90, rows: 26 }));
check(await waitScreen(/AGENT-RUN-2/, 25000), 'relaunching starts the agent a second time');
check(/--resume sesi-lama/.test(screen), 'with the same session resumed');
check(/\x1bc/.test(screen), 'and the old screen is cleared first, so it does not read as one run');

await sleep(3000);
const after = await state();
const a = after.terminals.find((t) => t.id === id);
check(!!a, 'the terminal keeps its id — same tab, not a new one');
check(
  a && a.alive,
  'and is alive: the replaced process dying must not mark its replacement dead',
);
check(a && a.name === 'agen' && a.color === 'magenta', 'the name and colour ride along');
check(
  after.terminals.filter((t) => t.alive).length === 1,
  `only one process is running (${after.terminals.filter((t) => t.alive).length}) — the old one was killed`,
);

// The counter file is the honest witness: two runs, not three.
const runs = Number(readFileSync(`${PROJ}\\runs.txt`, 'utf8').trim());
check(runs === 2, `the agent really ran twice, not more (${runs})`);

// --- still alive a while later ----------------------------------------------
// The dying EOF of the first process arrives a moment after the second starts.
// If it were accepted, the terminal would go dead here rather than immediately.
await sleep(4000);
const late = await state();
const l = late.terminals.find((t) => t.id === id);
check(l && l.alive, 'and still alive seconds later, once every stale event has landed');

// --- updating the agent -----------------------------------------------------
const beforeUpdate = (await state()).terminals.length;
ws.send(JSON.stringify({ t: 'update_agent_cli', name: 'faux', cols: 90, rows: 26 }));
await sleep(3000);
const upd = await state();
check(
  upd.terminals.length === beforeUpdate + 1,
  'updating an agent opens a terminal of its own to run it in',
);
const runner = upd.terminals.find((t) => !before.terminals.some((x) => x.id === t.id) && t.id !== id);
check(runner && runner.agent === 'faux', 'running that agent');
check(
  runner && !runner.project.includes('relproj'),
  `and not inside a project — it runs in ${runner?.project?.split(/[\\/]/).pop()}`,
);

// An agent with no update command must be refused, not run with nothing.
msgs.length = 0;
ws.send(JSON.stringify({ t: 'update_agent_cli', name: 'terminal', cols: 90, rows: 26 }));
await sleep(1200);
check(
  msgs.some((m) => m.t === 'error' && m.code === 'no_update_command'),
  'an agent with no updater says so instead of running its bare command',
);

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
ws.close();
spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
await sleep(1500);
process.exit(steps.every(Boolean) ? 0 : 1);
