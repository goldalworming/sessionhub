// "New terminal": opening a plain shell in the project folder, with no agent.
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 7717);
const TOKEN = process.argv[3];
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');

// --- the list of agents the daemon announces --------------------------------
const app = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
app.binaryType = 'arraybuffer';
const msgs = [];
let screen = '';
app.onmessage = (e) => {
  if (typeof e.data === 'string') msgs.push(JSON.parse(e.data));
  else screen += strip(Buffer.from(e.data).subarray(4).toString('utf8'));
};
await new Promise((r) => { app.onopen = r; });
while (!msgs.find((m) => m.t === 'state')) await sleep(100);
const st = msgs.find((m) => m.t === 'state');
// `agents` contains objects: the name along with its fork capability.
const agentNames = st.agents.map((a) => a.name);
console.log(`  agents: ${agentNames.join(', ')}`);
check(agentNames.includes('terminal'), 'the daemon announces the `terminal` agent');
check(agentNames[agentNames.length - 1] === 'terminal', 'it comes last, after the real agents');

// --- really open a shell in that folder --------------------------------------
const proj = st.projects.find((p) => p.exists)?.path;
msgs.length = 0;
app.send(JSON.stringify({ t: 'spawn', project: proj, agent: 'terminal', resume: null, cols: 100, rows: 26 }));
const att = await (async () => { while (!msgs.find((m) => m.t === 'attached')) await sleep(100); return msgs.find((m) => m.t === 'attached'); })();
check(!!att, `a terminal is opened in ${proj}`);

// The shell may be PowerShell or Command Prompt, depending on the choice made in
// the settings; both are legitimate, so both are recognised.
const ready = () => /PS [A-Z]:/.test(screen) || /Microsoft Windows \[Version/.test(screen) || /^[A-Z]:\\.*>/m.test(screen);
const t0 = Date.now();
while (!ready() && Date.now() - t0 < 25000) await sleep(150);
check(ready(), 'a shell really is running, not an agent');
const usingCmd = /Microsoft Windows \[Version/.test(screen);
console.log(`  shell detected: ${usingCmd ? 'Command Prompt' : 'PowerShell'}`);

const send = (t) => { const b = Buffer.from(t); const f = Buffer.alloc(4 + b.length); f.writeUInt32LE(att.id, 0); b.copy(f, 4); app.send(f); };
screen = '';
// ConPTY expresses a line break as cursor movement, which gets thrown away along
// with the ANSI stripping — the effect being that the next prompt sticks to the
// end of the output. An explicit end marker takes the guesswork out of the cut.
send(usingCmd ? 'echo DIR=%CD%;END\r' : 'Write-Host ("DI"+"R=" + (Get-Location).Path + ";END")\r');
while (!/DIR=[A-Z]:[^;]*;END/.test(screen) && Date.now() - t0 < 45000) await sleep(150);
const dir = screen.match(/DIR=([A-Z]:[^;]*);END/)?.[1]?.trim();
check(dir?.toLowerCase() === proj.toLowerCase(), `the shell is opened in the project folder (${dir})`);

// There must be no stored session named "terminal" in the sidebar.
msgs.length = 0;
app.send(JSON.stringify({ t: 'list' }));
while (!msgs.find((m) => m.t === 'state')) await sleep(100);
const terminalSessions = msgs.find((m) => m.t === 'state').projects.flatMap((p) => p.sessions).filter((s) => s.agent === 'terminal');
check(terminalSessions.length === 0, 'it does not pollute the sidebar with fake sessions');

// --- its menu entry in the UI -------------------------------------------------
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

await cmd('Emulation.setDeviceMetricsOverride', { width: 1100, height: 640, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.setItem('sh.theme','light'); localStorage.setItem('sh.sidebar.hidden','0')`);
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5000);
await ev(`document.querySelector('.project .add').click()`);
await sleep(600);
const menu = await ev(`[...document.querySelectorAll('#menu div')].map(d => d.textContent)`);
console.log(`  menu: ${menu.join(' | ')}`);
check(menu.includes('New terminal'), '"New terminal" is in the + menu');

await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
const shot = await cmd('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 420, height: 220, scale: 2 } });
writeFileSync('menu-baru.png', Buffer.from(shot.result.data, 'base64'));
console.log('  menu-baru.png');

app.send(JSON.stringify({ t: 'kill', id: att.id }));
await sleep(1200);
app.close();
ws.close();
const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
