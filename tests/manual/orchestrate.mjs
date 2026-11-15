// The skill button writes all three skills for Claude Code and, when pi is
// set up, for pi; and the round the terminals skill teaches — spawn, send,
// wait, capture — does what it says. A scratch daemon; no browser needed.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP = process.env.SP || 'C:/Users/user/AppData/Local/Temp/sessionhub-orchestrate';
const BIN = process.env.SH_BIN || 'C:/data/code/terminal-editor2/sessionhubd/target/debug/sessionhubd.exe';
const win = (p) => p.replaceAll('/', String.fromCharCode(92));
const PORT = 7827, TOKEN = 'uji-orkestra', HOME = `${SP}/home`, PROJ = `${SP}/proj`, OTHER = `${SP}/lain`;
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(SP, { recursive: true, force: true });
mkdirSync(`${HOME}/.sessionhub`, { recursive: true });
mkdirSync(`${HOME}/.pi/agent`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
mkdirSync(OTHER, { recursive: true });
writeFileSync(`${HOME}/.sessionhub/config.toml`, `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nprojects = ['${win(PROJ)}']\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3500);
const { SESSIONHUB_TERMINAL: _own, ...bare } = process.env;
const cli = (args) => spawnSync(BIN, [...args, '--home', HOME], { encoding: 'utf8', env: bare });

// ---- the button
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}&page=uji`);
await new Promise((r) => { ws.onopen = r; });
ws.send(JSON.stringify({ t: 'install_skill' }));
await sleep(1500);
ws.close();
const names = ['sessionhub-machines', 'sessionhub-show', 'sessionhub-terminals'];
for (const root of ['.claude/skills', '.pi/agent/skills']) {
  check(names.every((n) => existsSync(`${HOME}/${root}/${n}/SKILL.md`)), `all three skills are written under ${root}`);
}
check(readFileSync(`${HOME}/.pi/agent/skills/sessionhub-terminals/SKILL.md`, 'utf8').includes('sessionhubd spawn --agent'), 'and the terminals skill teaches spawn');

// ---- the round it teaches, in a folder that is not a project
const id = cli(['spawn', '--agent', 'terminal', '--project', win(OTHER), '--name', 'pekerja']).stdout.trim();
check(/^[0-9]+$/.test(id), `spawn prints the new terminal's id (${id})`);
check(cli(['wait', id, '--idle', '2', '--timeout', '30']).stdout.trim() === 'idle', 'wait returns idle once the shell has settled');
check(cli(['send', 'pekerja', 'echo halo-$((40+2))', '--enter']).status === 0, 'send by name types and submits');
cli(['wait', id, '--idle', '2', '--timeout', '30']);
check(cli(['capture', id, '--lines', '30']).stdout.includes('halo-42'), 'capture shows what the command printed');
const ls = cli(['ls']).stdout;
check(ls.includes('pekerja') && ls.includes('lain'), 'ls lists it with its name and folder');

cli(['stop']);
daemon.kill();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
