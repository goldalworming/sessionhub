// A terminal started with `sessionhubd spawn` from inside another terminal is
// that one's child: the sidebar hangs it underneath, titled by its --name, and
// the name becomes the session's own once the agent has written one. A pasted
// first message is titled by its words, not by the paste tag. A scratch
// daemon whose "claude" is a plain shell; needs headless Chrome on :9222.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP = process.env.SP || 'C:/Users/user/AppData/Local/Temp/sessionhub-spawntree';
const BIN = process.env.SH_BIN || 'C:/data/code/terminal-editor2/sessionhubd/target/debug/sessionhubd.exe';
const win = (p) => p.replaceAll('/', String.fromCharCode(92));
const PORT = 7829, TOKEN = 'uji-pohon', HOME = `${SP}/home`, PROJ = `${SP}/proj`;
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(SP, { recursive: true, force: true });
mkdirSync(`${HOME}/.sessionhub`, { recursive: true });
mkdirSync(`${HOME}/.claude/projects/proj`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(`${HOME}/.sessionhub/config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nprojects = ['${win(PROJ)}']\n\n[agents.claude]\ncommand = "cmd"\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(4000);
const { SESSIONHUB_TERMINAL: _own, ...bare } = process.env;
const cli = (args, env = bare) => spawnSync(BIN, [...args, '--home', HOME], { encoding: 'utf8', env });

const boss = cli(['spawn', '--agent', 'claude', '--project', win(PROJ), '--name', 'orkestrator']).stdout.trim();
const inside = { ...bare, SESSIONHUB_TERMINAL: boss };
const kid = cli(['spawn', '--agent', 'claude', '--project', win(PROJ), '--name', 'naskah-tidur'], inside).stdout.trim();
const grandkid = cli(['spawn', '--agent', 'terminal', '--project', win(PROJ), '--name', 'cek-fakta'], { ...bare, SESSIONHUB_TERMINAL: kid }).stdout.trim();
const list = JSON.parse(cli(['ls', '--json']).stdout);
const of = (id) => list.find((t) => String(t.id) === id);
check(of(boss).parent === undefined && of(kid).parent === Number(boss) && of(grandkid).parent === Number(kid),
  `spawn from inside a terminal records it as the parent (${of(kid).parent}, ${of(grandkid).parent})`);

// The child's agent writes its session: opened by a paste, as `send` does.
const SID = '7a1d2c3e-0000-4000-8000-00000000cafe';
writeFileSync(`${HOME}/.claude/projects/proj/${SID}.jsonl`,
  JSON.stringify({ type: 'user', cwd: win(PROJ), sessionId: SID, message: { role: 'user', content: '<pasted_content id="ea02"> Tulis 3 naskah video pendek' } }) + '\n');
let cfg = '';
for (let i = 0; i < 40 && !cfg.includes(SID); i++) { await sleep(500); cfg = readFileSync(`${HOME}/.sessionhub/config.toml`, 'utf8'); }
check(cfg.includes(SID) && /naskah-tidur|orkestrator/.test(cfg.split(SID)[1].split('\n')[0]), 'the name it was started under is saved as the session\'s name');

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}` });
let rows = [];
for (let i = 0; i < 30 && rows.length < 3; i++) {
  await sleep(500);
  rows = await ev(`[...document.querySelectorAll('.zrow[data-tid]')].map(r => ({ tid: r.dataset.tid, title: r.querySelector('.stitle').textContent, depth: r.style.getPropertyValue('--depth') || '0', pad: getComputedStyle(r).paddingLeft }))`) || [];
}
check(rows.map((r) => r.tid).join() === [boss, kid, grandkid].join(), `the rows run parent, child, grandchild (${rows.map((r) => r.tid).join()})`);
check(rows.map((r) => r.depth).join() === '0,1,2' && rows.map((r) => r.pad).join() === '8px,24px,40px', `each a step further in (${rows.map((r) => r.pad).join()})`);
check(rows.map((r) => r.title).join() === 'orkestrator,naskah-tidur,cek-fakta', `and titled by their names (${rows.map((r) => r.title).join()})`);

// The session's own title, with no name over it, drops the paste tag.
const state = await ev(`fetch('/api/term/ls?token=${TOKEN}').then(r => r.json())`);
const titles = await ev(`(async () => { const ws = new WebSocket('ws://127.0.0.1:${PORT}/ws?token=${TOKEN}&page=uji'); return await new Promise(res => { ws.onmessage = e => { const m = JSON.parse(e.data); if (m.projects) { ws.close(); res(m.projects.flatMap(p => p.sessions.map(s => s.title))); } }; }); })()`);
check(Array.isArray(state) && JSON.stringify(titles) === '["Tulis 3 naskah video pendek"]', `a pasted first message is titled by its words (${JSON.stringify(titles)})`);

cli(['stop']);
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
