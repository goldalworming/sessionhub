// Terminal activity marks and the finished-chime.
//
// A tab is amber while its program streams output, green once a real run ended
// while nobody was looking, and a chime fires for that — but only then. Runs
// too short or too small to be a job (a typed echo, a prompt redraw) must stay
// silent, the attach replay must not read as work, and the active, watched
// terminal never dings: the whole point is telling you about what you are NOT
// watching.

import { readFileSync } from 'node:fs';

const PORT = 7719;
const CFG = 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome\\.sessionhub\\config.toml';
// Read from the config rather than hard-coded: the daemon's token changes, and
// a stale copy here fails as "cannot connect", which says nothing about what
// this test is actually checking.
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- two shells, through the daemon ------------------------------------------
const app = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
app.binaryType = 'arraybuffer';
const msgs = [];
app.onmessage = (e) => { if (typeof e.data === 'string') msgs.push(JSON.parse(e.data)); };
await new Promise((r) => { app.onopen = r; });
const lastState = () => msgs.filter((m) => m.t === 'state').pop();
const waitFor = async (pred, what, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await pred()) return true; await sleep(150); }
  throw new Error(`timed out waiting for ${what}`);
};
await waitFor(() => lastState()?.projects.some((p) => p.exists), 'the registry scan');
const project = lastState().projects.find((p) => p.exists).path;

const spawned = [];
const spawnShell = () => {
  const before = msgs.filter((m) => m.t === 'attached').length;
  app.send(JSON.stringify({ t: 'spawn', project, agent: 'shell', resume: null, cols: 90, rows: 24 }));
  return waitFor(() => msgs.filter((m) => m.t === 'attached').length > before, 'attached').then(() => {
    const id = msgs.filter((m) => m.t === 'attached').pop().id;
    spawned.push(id);
    return id;
  });
};
const A = await spawnShell();
const B = await spawnShell();
const input = (id, text) => {
  const body = Buffer.from(text, 'utf8');
  const f = Buffer.alloc(4 + body.length);
  f.writeUInt32LE(id, 0);
  body.copy(f, 4);
  app.send(f);
};
// Let both prompts settle before the browser ever sees them.
await sleep(3500);

// --- the browser -------------------------------------------------------------
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0;
const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
// "Looked at" includes document.hasFocus(), and a headless page does not get
// real OS focus — emulate it, or the active terminal would count as unwatched.
await cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
await ev(`localStorage.removeItem('sh.sound'); localStorage.setItem('sh.sidebar.hidden','0')`);
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5000);

// Attach both, end on A active. Count the dings from the very start.
await ev(`window.__dings = 0; document.addEventListener('sh:ding', () => window.__dings++)`);
await ev(`document.querySelector('.tab[data-id="${B}"]')?.click()`);
await sleep(1500);
await ev(`document.querySelector('.tab[data-id="${A}"]')?.click()`);
await sleep(2500);

const tdot = (id) => `document.querySelector('.tab[data-id="${id}"] .tdot')`;
check(await ev(`!!${tdot(A)} && !!${tdot(B)}`), 'each tab carries an activity mark');
check(await ev(`!!document.getElementById('sound-btn')`), 'the sound toggle is in the toolbar');
check(await ev(`document.getElementById('sound-btn').classList.contains('on')`), 'and it starts switched on');
check(await ev(`!!document.querySelector('#sound-btn svg')`), 'its bell is drawn, not an emoji');
check(await ev(`!document.querySelector('#sound-btn svg line')`), 'and carries no slash while sound is on');

// --- a real run in the UNWATCHED terminal ------------------------------------
// 12 lines of ~220 bytes, 600 ms apart: long enough (>5 s) and big enough
// (>2 KB) to be a job by the thresholds in app.js.
const JOB = `1..12 | ForEach-Object { ('kerja {0} ' -f $_) + ('x' * 200); Start-Sleep -Milliseconds 600 }\r`;
input(B, JOB);
check(
  await waitFor(async () => await ev(`${tdot(B)}.classList.contains('busy')`), 'B busy', 10000),
  'the unwatched terminal turns amber while its job streams',
);
check(!(await ev(`${tdot(A)}.classList.contains('busy')`)), 'the idle one does not');
check(
  await ev(`!!document.querySelector('#tree [data-tid="${B}"].tbusy')`),
  'its sidebar row turns amber with it',
);

check(
  await waitFor(async () => await ev(`${tdot(B)}.classList.contains('done')`), 'B done', 30000),
  'when the job goes quiet, the mark turns green',
);
check((await ev(`window.__dings`)) === 1, 'and exactly one chime fired');
check(
  await ev(`!!document.querySelector('#tree [data-tid="${B}"].tdone')`),
  'the sidebar row turns green too',
);

// Seeing it is acknowledging it.
await ev(`document.querySelector('.tab[data-id="${B}"]').click()`);
await sleep(800);
check(!(await ev(`${tdot(B)}.classList.contains('done')`)), 'opening the tab clears the mark');

// --- the same job in the WATCHED terminal ------------------------------------
input(B, JOB);
await waitFor(async () => await ev(`${tdot(B)}.classList.contains('busy')`), 'B busy again', 10000);
await waitFor(async () => !(await ev(`${tdot(B)}.classList.contains('busy')`)), 'B quiet again', 30000);
await sleep(1200);
check(!(await ev(`${tdot(B)}.classList.contains('done')`)), 'a job you watched finish leaves no mark');
check((await ev(`window.__dings`)) === 1, 'and no chime — you saw it yourself');

// --- mute --------------------------------------------------------------------
await ev(`document.getElementById('sound-btn').click()`);
check(!(await ev(`document.getElementById('sound-btn').classList.contains('on')`)), 'one click mutes the bell');
check(await ev(`!!document.querySelector('#sound-btn svg line')`), 'and the drawn bell gains its slash');
await ev(`document.querySelector('.tab[data-id="${A}"]').click()`);
await sleep(800);
input(B, JOB);
await waitFor(async () => await ev(`${tdot(B)}.classList.contains('done')`), 'B done while muted', 40000);
check((await ev(`window.__dings`)) === 1, 'muted: the mark still appears, the chime does not');
await ev(`document.getElementById('sound-btn').click()`);
const afterUnmute = await ev(`window.__dings`);
check(afterUnmute === 2, 'switching sound back on proves itself with a chime');
await ev(`document.querySelector('.tab[data-id="${B}"]').click()`);
await sleep(600);

// --- the attach replay is not a job ------------------------------------------
// B's ring buffer now holds kilobytes; a reload replays all of it in one burst.
await ev(`location.reload()`);
await sleep(5000);
await ev(`window.__dings = 0; document.addEventListener('sh:ding', () => window.__dings++)`);
await ev(`document.querySelector('.tab[data-id="${B}"]')?.click()`);
await sleep(5500);
check(
  !(await ev(`${tdot(B)}?.classList.contains('done')`)) && (await ev(`window.__dings`)) === 0,
  'replaying the ring buffer neither marks nor chimes — old output is not work',
);

// --- a typed echo is not a job either ----------------------------------------
await ev(`document.querySelector('.tab[data-id="${A}"]')?.click()`);
await sleep(800);
input(B, 'echo pendek\r');
await sleep(5500);
check(
  !(await ev(`${tdot(B)}.classList.contains('done')`)) && (await ev(`window.__dings`)) === 0,
  'a short echo in a background tab stays unannounced',
);

// --- clean up ----------------------------------------------------------------
for (const id of spawned) app.send(JSON.stringify({ t: 'kill', id }));
await sleep(1500);
await ev(`localStorage.removeItem('sh.sound')`);
await cmd('Emulation.setFocusEmulationEnabled', { enabled: false });
await cmd('Emulation.clearDeviceMetricsOverride');
app.close();

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
