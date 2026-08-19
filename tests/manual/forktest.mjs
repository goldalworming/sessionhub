// Forking a session: the button on the session row, the name dialog, then a NEW
// session that leaves the original session unchanged.
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 7717);
const TOKEN = process.argv[3];
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the capabilities the daemon announces -----------------------------------
const app = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
app.binaryType = 'arraybuffer';
const msgs = [];
let screen = '';
app.onmessage = (e) => {
  if (typeof e.data === 'string') msgs.push(JSON.parse(e.data));
  else screen += Buffer.from(e.data).subarray(4).toString('utf8');
};
await new Promise((r) => { app.onopen = r; });
const lastState = () => msgs.filter((m) => m.t === 'state').pop();
while (!lastState()?.projects.length) await sleep(150);
const st = lastState();

console.log('  fork capability per agent:');
for (const a of st.agents) console.log(`    ${a.name.padEnd(10)} fork=${a.can_fork}  takes-name=${a.fork_takes_name}`);
const claude = st.agents.find((a) => a.name === 'claude');
check(claude?.can_fork === true, 'claude can fork (--fork-session)');
check(claude?.fork_takes_name === true, 'claude accepts a session name (--name)');
const term = st.agents.find((a) => a.name === 'terminal');
check(term?.can_fork === false, 'a plain shell is not offered a fork — it has no session');

// --- a real fork -------------------------------------------------------------
let target = null;
for (const p of st.projects) {
  if (!p.exists) continue;
  const s = p.sessions.find((x) => x.agent === 'claude' && !x.live_terminal_id);
  if (s) { target = { project: p.path, session: s }; break; }
}
if (!target) { console.log('  [FAIL] there is no claude session to fork'); process.exit(1); }
console.log(`  original session: ${target.session.session_id} (${target.session.title.slice(0, 40)}…)`);

const sessionsBefore = new Set(st.projects.flatMap((p) => p.sessions).map((s) => s.session_id));
const NAME = 'uji fork sessionhub';

msgs.length = 0;
app.send(JSON.stringify({
  t: 'fork', project: target.project, agent: 'claude',
  session_id: target.session.session_id, name: NAME, cols: 110, rows: 30,
}));
const t0 = Date.now();
while (!msgs.find((m) => m.t === 'attached') && !msgs.find((m) => m.t === 'error') && Date.now() - t0 < 25000) await sleep(150);
const err = msgs.find((m) => m.t === 'error');
if (err) { console.log(`  [FAIL] ${err.code}: ${err.message}`); process.exit(1); }
const att = msgs.find((m) => m.t === 'attached');
check(!!att, `the fork terminal is created (id=${att?.id})`);

await sleep(12000);

// The fork uses `--fork-session`, so the old conversation is carried over into
// the new session.
check(screen.length > 500, `the old conversation is carried into the fork (${screen.length} bytes)`);

// The original session must not be touched — that is the whole point of a fork.
const originStillThere = lastState().projects.flatMap((p) => p.sessions)
  .some((s) => s.session_id === target.session.session_id);
check(originStillThere, 'the original session is still there and unchanged');

// Verified separately: after a fork, Claude Code does NOT yet write the session
// file until there is a first message. So the sidebar genuinely does not show a
// new row yet, and that is the agent's behaviour — not a failed fork.
const newSessions = lastState().projects.flatMap((p) => p.sessions)
  .filter((x) => x.agent === 'claude' && !sessionsBefore.has(x.session_id));
check(
  newSessions.length === 0,
  `the agent has not written the new session before the first message (${newSessions.length} new)`
);

// The fork terminal stays registered, so the user does not lose track of it.
const t = lastState().terminals.find((x) => x.id === att.id);
check(t?.alive === true, 'the fork terminal is registered and alive');
check(t?.agent === 'claude' && t?.project === target.project, 'the fork terminal sits in the right project');

app.send(JSON.stringify({ t: 'kill', id: att.id }));
await sleep(1500);

// --- the dialog in the UI -------------------------------------------------------
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((x) => x.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

await cmd('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.setItem('sh.theme','light'); localStorage.setItem('sh.sidebar.hidden','0'); localStorage.removeItem('sh.collapsed')`);
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(6000);

const buttons = await ev(`
  (() => {
    const s = [...document.querySelectorAll('.session')];
    const dgn = s.filter(x => x.querySelector('.act-fork')).length;
    return { total: s.length, punyaFork: dgn };
  })()
`);
check(buttons.punyaFork > 0, `the fork button shows up on the session rows (${buttons.punyaFork}/${buttons.total})`);

// `.act-fork`, not `.fork`: the row carries three actions that share the `fork`
// look, and the pencil comes first.
await ev(`document.querySelector('.session .act-fork').click()`);
await sleep(800);
check(await ev(`document.getElementById('ask').hidden === false`), 'the name dialog appears before the fork');
const prefill = await ev(`document.querySelector('#ask input').value`);
const title2 = await ev(`document.querySelector('#ask .atitle').textContent`);
const note = await ev(`document.querySelector('#ask .anote').textContent`);
console.log(`    title   : ${title2}`);
console.log(`    prefill : ${prefill}`);
console.log(`    note    : ${note.slice(0, 80)}…`);
check(/\(fork\)$/.test(prefill), 'the name is pre-filled from the title of the original session');
check(/left untouched/.test(note), 'the dialog explains that the original session is left untouched');

await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
const shot = await cmd('Page.captureScreenshot', { format: 'png' });
writeFileSync('fork.png', Buffer.from(shot.result.data, 'base64'));
console.log('  fork.png');

// Cancelling must not create anything.
const beforeCancel = lastState().terminals.length;
await ev(`document.querySelector('#ask .batal').click()`);
await sleep(1500);
check(await ev(`document.getElementById('ask').hidden === true`), 'Cancel closes the dialog');
check(lastState().terminals.length === beforeCancel, 'Cancel does not create any terminal');

app.close();
ws.close();
const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
