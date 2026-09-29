// `sessionhubd spawn --env NAME=VALUE` — per-terminal environment, isolated
// from other terminals of the same agent, never logged, and refused before
// any terminal exists when the input is bad or Remote commands is off.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\envhome`;
const PROJ = `${SP}\\envproj`;
const PORT = 7761;
const TOKEN = 'uji-env';
const LOG = `${HOME}\\.sessionhub\\sessionhubd.log`;

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/api/status?token=${TOKEN}`)).json();
  } catch {
    return null;
  }
};
// Every call goes through --home, same as a real user would from a shell
// that never `cd`d into sessionhub's own install — this is the actual
// interface being tested, not the raw HTTP routes underneath it.
const sh = (...args) => execFileSync(BIN, [...args, '--home', HOME], { encoding: 'utf8' });
const shFail = (...args) => {
  try {
    sh(...args);
    return { failed: false };
  } catch (e) {
    return { failed: true, status: e.status, stderr: e.stderr };
  }
};

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(
  `${HOME}\\.sessionhub\\config.toml`,
  [
    `port = ${PORT}`,
    'lan_access = false',
    `token = "${TOKEN}"`,
    `projects = ["${PROJ.split('\\').join('\\\\')}"]`,
    '',
  ].join('\n'),
);
spawn(BIN, ['start', '--home', HOME], { detached: true, stdio: 'ignore' }).unref();
for (let i = 0; i < 40 && !(await status()); i++) await sleep(500);
check(!!(await status()), `test daemon up on ${PORT}`);
check((await status())?.term_env === true, "/api/status advertises term_env");

// --- spawn with --env, and a sibling with none -------------------------------
const t1 = sh('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 't1',
  '--env', 'FOO=bar', '--env', 'BAZ=qux').trim();
const t2 = sh('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 't2').trim();
check(/^\d+$/.test(t1) && /^\d+$/.test(t2), `both spawned (t1=${t1}, t2=${t2})`);

const probe = 'echo P_[$env:FOO]_[$env:BAZ]';
sh('send', 't1', probe, '--enter');
sh('send', 't2', probe, '--enter');
await sleep(1500);
const cap1 = sh('capture', 't1');
const cap2 = sh('capture', 't2');
check(cap1.includes('P_[bar]_[qux]'), `t1 sees its own env: ${cap1.match(/P_\[.*\]/)?.[0]}`);
check(cap2.includes('P_[]_[]'), `t2 (no --env) sees neither: ${cap2.match(/P_\[.*\]/)?.[0]}`);

// --- the bare NAME form pulls from this process's own environment ----------
process.env.SESSIONHUBD_TEST_SECRET = 'super-secret-oauth-value-xyz';
const t3 = sh('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 't3',
  '--env', 'SESSIONHUBD_TEST_SECRET').trim();
sh('send', 't3', 'echo S_[$env:SESSIONHUBD_TEST_SECRET]', '--enter');
await sleep(1500);
const cap3 = sh('capture', 't3');
check(cap3.includes('S_[super-secret-oauth-value-xyz]'), 'bare --env NAME reads the calling shell');

// --- refused before anything is created -------------------------------------
const before = JSON.parse(sh('ls', '--json'));
const badName = shFail('spawn', '--agent', 'terminal', '--project', PROJ, '--env', '1BAD=x');
const unset = shFail('spawn', '--agent', 'terminal', '--project', PROJ, '--env', 'SESSIONHUBD_NOT_SET_ANYWHERE');
const after = JSON.parse(sh('ls', '--json'));
check(badName.failed && unset.failed, 'both bad --env forms exit non-zero');
check(after.length === before.length, `no terminal was created by either (before=${before.length}, after=${after.length})`);

// --- the secret never reaches the log; the name does ------------------------
const log = readFileSync(LOG, 'utf8');
check(!log.includes('super-secret-oauth-value-xyz'), 'the secret value is not in the daemon log');
check(log.includes('env_names=BAZ,FOO') || log.includes('env_names=FOO,BAZ'), 'the variable NAMES are in the log');
check(log.includes('env_names=SESSIONHUBD_TEST_SECRET'), 'including the bare-form name');

// --- Remote commands off refuses spawn --env exactly like plain spawn ------
const setOff = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => { setOff.onopen = r; });
setOff.send(JSON.stringify({ t: 'set_remote_commands', enabled: false }));
await sleep(300);
const gated = shFail('spawn', '--agent', 'terminal', '--project', PROJ, '--env', 'FOO=bar');
check(gated.failed && /remote commands/i.test(gated.stderr || ''), `--env spawn is 403'd when Remote commands is off: ${gated.stderr?.trim()}`);
setOff.send(JSON.stringify({ t: 'set_remote_commands', enabled: true }));
await sleep(300);
setOff.close();

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
await sleep(1500);
process.exit(steps.every(Boolean) ? 0 : 1);
