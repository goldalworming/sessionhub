// Acceptance #6: a session in directory A, started through the daemon -> `pwd`
// INSIDE the agent shows A, not the directory the daemon runs in.
//
// What is checked is the working directory of the child process, asked of the
// process itself. A path that happens to show up in the session transcript
// proves nothing about the cwd.

const PORT = 7719;
const TOKEN = process.argv[2];
const DAEMON_CWD = 'C:\\data\\code\\terminal-editor2';
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) =>
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
ws.binaryType = 'arraybuffer';
const msgs = [];
let screen = '';
ws.onmessage = (e) => {
  if (typeof e.data === 'string') msgs.push(JSON.parse(e.data));
  else screen += strip(Buffer.from(e.data).subarray(4).toString('utf8'));
};
await new Promise((r) => { ws.onopen = r; });
const find = (t) => msgs.find((m) => m.t === t);
const lastState = () => msgs.filter((m) => m.t === 'state').pop();
async function waitFor(pred, what, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(120); }
  throw new Error(`timeout waiting for ${what}`);
}
const input = (id, text) => {
  const body = Buffer.from(text, 'utf8');
  const f = Buffer.alloc(4 + body.length);
  f.writeUInt32LE(id, 0); body.copy(f, 4); ws.send(f);
};

await waitFor(() => { const s = lastState(); return s && !s.scanning && s.projects.length; }, 'the registry to fill up');

// A DIFFERENT project on purpose, so the right cwd cannot come about by coincidence.
const st = lastState();
const p = st.projects.find(
  (x) => x.exists && x.path.toLowerCase() !== DAEMON_CWD.toLowerCase() && x.sessions.length
);
if (!p) { console.log('  [FAIL] there is no project to compare against'); process.exit(1); }
console.log(`  the daemon runs in : ${DAEMON_CWD}`);
console.log(`  target project     : ${p.path}`);

msgs.length = 0;
ws.send(JSON.stringify({ t: 'spawn', project: p.path, agent: 'shell', resume: null, cols: 110, rows: 30 }));
const att = (await waitFor(() => find('attached'), 'attached')) && find('attached');
await waitFor(() => /PS [A-Z]:/.test(screen), 'the prompt');

// Ask the process itself. The marker is split up so the echo of the typing does
// not match as well.
screen = '';
input(att.id, 'Write-Host ("CW"+"D=" + (Get-Location).Path)\r');
await waitFor(() => /CWD=/.test(screen), 'the pwd answer');
await sleep(500);

const reported = screen.match(/CWD=([^\r\n]+)/)?.[1]?.trim();
console.log(`  pwd inside the agent : ${reported}`);
check(reported?.toLowerCase() === p.path.toLowerCase(), `pwd is the same as the project directory`);
check(reported?.toLowerCase() !== DAEMON_CWD.toLowerCase(), 'pwd is not the directory the daemon runs in');

ws.send(JSON.stringify({ t: 'kill', id: att.id }));
await waitFor(() => find('exit'), 'exit');

// The resume path with a real agent. What this can show is that resuming works
// at all — the agent starts, attaches, and produces output under the session it
// was asked to continue.
//
// It deliberately does NOT claim to check the cwd. A resumed agent replays its
// conversation and never prints its working directory, so scraping the screen
// for the project path was reading the old transcript, not the cwd. This test
// used to assert exactly that and passed only while the agent still printed a
// startup banner. The cwd on the resume path is the same code as above, which
// the two checks before this one measure by asking the process itself.
const target = p.sessions.find((s) => s.agent === 'claude' && !s.live_terminal_id);
if (target) {
  msgs.length = 0;
  screen = '';
  ws.send(JSON.stringify({
    t: 'spawn', project: p.path, agent: 'claude', resume: target.session_id, cols: 120, rows: 34,
  }));
  const a2 = (await waitFor(() => find('attached'), 'attached on resume')) && find('attached');
  await sleep(16000);
  const back = lastState()?.terminals?.find((t) => t.id === a2.id);
  check(
    !!a2 && screen.trim().length > 0,
    `the resumed agent starts and writes to the screen (${screen.trim().length} characters)`,
  );
  check(
    back?.session_id === target.session_id && back?.project === p.path,
    `the daemon holds it under the session it was asked to continue (${back?.session_id})`,
  );
  ws.send(JSON.stringify({ t: 'kill', id: a2.id }));
  await sleep(2000);
}

ws.close();
const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
