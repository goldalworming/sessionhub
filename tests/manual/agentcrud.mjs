// Adding and removing your own agents, over the protocol.
// Start the test daemon first at --home <scratchpad>\fakehome.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 7719;
const HOME =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome';
const CFG = join(HOME, '.sessionhub', 'config.toml');
const PROJECT = 'C:\\data\\code\\terminal-editor2';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!CFG.includes('fakehome')) { console.error('ABORT: not the test config.'); process.exit(1); }
const TOKEN = /token\s*=\s*"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];
const cfgText = () => readFileSync(CFG, 'utf8');

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
ws.binaryType = 'arraybuffer';
const send = (o) => ws.send(JSON.stringify(o));

let lastState = null;
let waiter = null;
const errors = [];
const want = (kind) =>
  new Promise((res, rej) => {
    waiter = { kind, res };
    setTimeout(() => rej(new Error(`timeout waiting for ${kind}`)), 15000);
  });

ws.onmessage = (ev) => {
  if (typeof ev.data !== 'string') return;
  const m = JSON.parse(ev.data);
  if (m.t === 'state') lastState = m;
  if (m.t === 'error') errors.push(m);
  if (!waiter) return;
  // `error` always wakes the waiter up: if it gets rejected, do not hang.
  if (m.t === waiter.kind || m.t === 'error') { waiter.res(m); waiter = null; }
};

await new Promise((r) => { ws.onopen = r; });
send({ t: 'config' });
const initial = await want('config');
const initialNames = initial.agents.map((a) => a.name);
console.log(`  initial agents: ${initialNames.join(', ')}`);

// --- 1. the shape of the config message --------------------------------------
check(
  initial.agents.every((a) => Array.isArray(a.fork_args) && typeof a.removable === 'boolean'),
  'every agent carries fork_args and a removable flag',
);
const term = initial.agents.find((a) => a.name === 'terminal');
check(term && term.removable === false, '`terminal` is marked as not removable');
check(initial.agents.filter((a) => a.name !== 'terminal').every((a) => a.removable), 'the rest can be removed');

// --- 2. add a harness of our own ---------------------------------------------
send({
  t: 'set_agent',
  name: 'myharness',
  command: 'powershell.exe',
  resume_args: ['--session', '{session_id}'],
  fork_args: ['--session', '{session_id}', '--fork', '--title', '{name}'],
  enabled: true,
});
let cfg = await want('config');
const added = cfg.agents.find((a) => a.name === 'myharness');
check(!!added, 'the new agent shows up in the list');
check(added?.resolved?.endsWith('powershell.exe'), `its command is looked up on PATH right away: ${added?.resolved}`);
check(added?.resume_args.join(' ') === '--session {session_id}', 'the resume args are stored');
check(added?.fork_args.join(' ').includes('--fork'), 'the fork args are stored');
check(/\[agents\.myharness\]/.test(cfgText()), 'written to the real config.toml');

await sleep(400);
check(
  (lastState?.agents || []).some((a) => (a.name || a) === 'myharness'),
  'it shows up in the "new terminal" menu too, without needing a reload',
);
const brief = (lastState?.agents || []).find((a) => a.name === 'myharness');
check(brief?.can_fork === true, 'because fork args are filled in, a fork button is offered as well');

// --- 3. the new agent can really be used -------------------------------------
send({ t: 'spawn', project: PROJECT, agent: 'myharness', resume: null, cols: 80, rows: 24 });
const att = await want('attached');
check(att.t === 'attached', `an agent we made ourselves can be spawned (id=${att.id})`);

// --- 4. names that make no sense are rejected --------------------------------
for (const [name2, why] of [
  ['My Agent', 'contains a space'],
  ['9lives', 'starts with a digit'],
  ['agent!', 'contains punctuation'],
]) {
  send({ t: 'set_agent', name: name2, command: 'cmd.exe', resume_args: [], enabled: true });
  const r = await want('config');
  check(r.t === 'error' && r.code === 'bad_agent', `the name "${name2}" is rejected (${why}): ${r.message || r.t}`);
}
send({ t: 'set_agent', name: 'x', command: '', resume_args: [], enabled: true });
const empty = await want('config');
check(empty.t === 'error', `an empty command is rejected: ${empty.message || empty.t}`);

// --- 5. `terminal` must not be removable -------------------------------------
send({ t: 'remove_agent', name: 'terminal' });
const refused = await want('config');
check(refused.t === 'error' && /rebuilt/.test(refused.message || ''), `removing terminal is refused, with a reason: ${refused.message}`);
check(/\[agents\.terminal\]/.test(cfgText()), 'and `terminal` really is still there in the config');

// --- 6. remove an unused agent (the `pi` case) -------------------------------
const hasPi = initialNames.includes('pi');
if (hasPi) {
  send({ t: 'remove_agent', name: 'pi' });
  cfg = await want('config');
  check(!cfg.agents.some((a) => a.name === 'pi'), '`pi` is gone from the agent list');
  check(!/\[agents\.pi\]/.test(cfgText()), '`pi` is gone from config.toml');
  await sleep(400);
  check(!(lastState?.agents || []).some((a) => (a.name || a) === 'pi'), '`pi` is gone from the new terminal menu');
} else {
  console.log('  (pi is not in the test config, the removal step is skipped)');
}

// --- 7. removing does not kill a terminal that is already running ------------
send({ t: 'remove_agent', name: 'myharness' });
cfg = await want('config');
check(!cfg.agents.some((a) => a.name === 'myharness'), 'the agent we made ourselves is removed');
await sleep(600);
const still = (lastState?.terminals || []).find((t) => t.id === att.id);
check(still?.alive === true, 'the terminal that was already running stays alive — the setting is removed, the work is not');

// --- 8. removing something that does not exist -------------------------------
send({ t: 'remove_agent', name: 'tidakada' });
const ghost = await want('config');
check(ghost.t === 'error' && ghost.code === 'unknown_agent', `removing something that does not exist -> ${ghost.code}`);

// --- done: put `pi` back the way it was --------------------------------------
send({ t: 'kill', id: att.id });
if (hasPi) {
  send({
    t: 'set_agent',
    name: 'pi',
    command: 'pi',
    resume_args: ['--session', '{session_id}'],
    fork_args: [],
    enabled: true,
  });
  await want('config');
}
await sleep(400);
ws.close();

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
