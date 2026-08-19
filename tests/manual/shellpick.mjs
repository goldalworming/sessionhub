// The shell choice for the terminal agent: Command Prompt vs PowerShell, and
// really running the one that was picked.
import { writeFileSync, readFileSync } from 'node:fs';

const PORT = 7719;
const CFG = 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome\\.sessionhub\\config.toml';
// Read from the config rather than hard-coded: the daemon's token changes, and
// a stale copy here fails as "cannot connect", which says nothing about what
// this test is actually checking.
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitRows = async () => { const u = Date.now() + 15000; while (Date.now() < u) { if (await ev(`document.querySelectorAll('.agent').length`)) return; await sleep(200); } };

await cmd('Emulation.setDeviceMetricsOverride', { width: 1180, height: 760, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.setItem('sh.theme','light'); localStorage.setItem('sh.sidebar.hidden','0')`);
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5000);
await ev(`document.getElementById('settings-btn').click()`);
await sleep(400);
// The panel opens on its first section, which is not Agents — the shell picker
// lives there, so ask for it rather than waiting for rows that never come.
await ev(`document.querySelector('#settings .sitem[data-section="agents"]')?.click()`);
await sleep(400);
await waitRows();

// Safety catch: this test writes to a real config through the panel. If the page
// turns out to point at a different daemon, stop before touching anything.
const path2 = await ev(`document.querySelector('.shead .path').textContent`);
if (!path2.includes('fakehome')) {
  console.log(`  [ABORT] the panel points at a real config: ${path2}`);
  process.exit(2);
}

// --- the list of choices -----------------------------------------------------
// Agent rows are folded shut; the shell picker is in the body, so open the row
// before looking for it.
await ev(`
  [...document.querySelectorAll('.agent')]
    .find(a => a.querySelector('.aname')?.textContent === 'terminal')
    ?.querySelector('.atwist')?.click()
`);
await sleep(400);
const options = await ev(`
  (() => {
    const row = [...document.querySelectorAll('.agent')].find(a => a.querySelector('.aname').textContent === 'terminal');
    const sel = row.querySelector('select');
    return sel ? [...sel.options].map(o => o.textContent) : null;
  })()
`);
console.log(`  choices: ${(options || []).join(' | ')}`);
check(!!options, 'the terminal agent has a list of shell choices');
check(options.some((o) => o.startsWith('Command Prompt')), 'Command Prompt is offered');
check(options.some((o) => o.startsWith('Windows PowerShell')), 'Windows PowerShell is offered');
check(!options.some((o) => o.startsWith('PowerShell 7')), 'PowerShell 7 is not offered because it is not installed on this machine');

// What decides this is not the name but whether there are resume arguments: an
// agent with no session to continue is in fact a shell.
// The rows are an accordion: only one is open at a time, and both the picker
// and the resume field live in the body. So ask them one at a time — opening
// them all at once just leaves the last one open and the rest looking empty.
const names = await ev(`[...document.querySelectorAll('.agent .aname')].map(n => n.textContent)`);
const kinds = [];
for (const nama of names) {
  await ev(`
    [...document.querySelectorAll('.agent')]
      .find(a => a.querySelector('.aname')?.textContent === ${JSON.stringify(nama)})
      ?.querySelector('.atwist')?.click()
  `);
  await sleep(300);
  kinds.push(await ev(`
    (() => {
      const a = [...document.querySelectorAll('.agent')].find(x => x.querySelector('.aname')?.textContent === ${JSON.stringify(nama)});
      return {
        nama: ${JSON.stringify(nama)},
        pilihan: !!a.querySelector('select'),
        punyaResume: [...a.querySelectorAll('label')].some(l => l.textContent.trim().startsWith('Resume args')),
      };
    })()
  `));
}
// Leave the terminal row open: the steps below drive its picker. Only click it
// shut-to-open, never the other way — the loop above may already have left it
// open, and a second click would close it again.
await ev(`
  (() => {
    const t = [...document.querySelectorAll('.agent')]
      .find(a => a.querySelector('.aname')?.textContent === 'terminal')
      ?.querySelector('.atwist');
    if (t && t.textContent === '\\u25b8') t.click();
  })()
`);
await sleep(400);
for (const t of kinds) console.log(`    ${t.nama.padEnd(10)} choice=${t.pilihan}  resume=${t.punyaResume}`);
check(
  kinds.every((t) => t.pilihan === !t.punyaResume),
  'the shell choice appears on exactly those agents that have no resume arguments'
);
check(kinds.find((t) => t.nama === 'claude')?.pilihan === false, 'a real agent is not given a shell choice');

// --- pick Command Prompt -----------------------------------------------------
await ev(`
  (() => {
    const row = [...document.querySelectorAll('.agent')].find(a => a.querySelector('.aname').textContent === 'terminal');
    const sel = row.querySelector('select');
    sel.value = 'cmd.exe';
    sel.dispatchEvent(new Event('change'));
  })()
`);
await sleep(2500);
const cfg = readFileSync(CFG, 'utf8');
const block = cfg.split('[agents.').find((b) => b.startsWith('terminal]'));
check(/command\s*=\s*"cmd\.exe"/.test(block || ''), 'the choice is persisted to config.toml');
check(
  await ev(`
    [...document.querySelectorAll('.agent')].find(a => a.querySelector('.aname').textContent === 'terminal')
      .querySelector('input[type=text]').value === 'cmd.exe'
  `),
  'the command field follows along'
);

await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
const shot = await cmd('Page.captureScreenshot', { format: 'png', clip: { x: 210, y: 380, width: 760, height: 240, scale: 2 } });
writeFileSync('shellpick.png', Buffer.from(shot.result.data, 'base64'));
console.log('  shellpick.png');

// --- really run cmd ----------------------------------------------------------
await ev(`document.querySelector('#settings .close').click()`);
const app = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
app.binaryType = 'arraybuffer';
const msgs = [];
let screen = '';
app.onmessage = (e) => {
  if (typeof e.data === 'string') msgs.push(JSON.parse(e.data));
  else screen += Buffer.from(e.data).subarray(4).toString('utf8');
};
await new Promise((r) => { app.onopen = r; });
while (!msgs.find((m) => m.t === 'state')) await sleep(100);
app.send(JSON.stringify({ t: 'spawn', project: 'C:\\data\\code\\terminal-editor2', agent: 'terminal', resume: null, cols: 90, rows: 24 }));
while (!msgs.find((m) => m.t === 'attached')) await sleep(100);
const id = msgs.find((m) => m.t === 'attached').id;
const t0 = Date.now();
while (!/Microsoft Windows \[Version/.test(screen) && Date.now() - t0 < 20000) await sleep(200);
check(/Microsoft Windows \[Version/.test(screen), 'a new terminal really does run Command Prompt');
check(!/Windows PowerShell\r?\nCopyright/.test(screen), 'no longer PowerShell');

// --- put it back to PowerShell -----------------------------------------------
app.send(JSON.stringify({ t: 'kill', id }));
await sleep(1200);
app.send(JSON.stringify({
  t: 'set_agent', name: 'terminal', command: 'powershell.exe', resume_args: [], enabled: true,
}));
await sleep(1500);
const cfg2 = readFileSync(CFG, 'utf8');
const block2 = cfg2.split('[agents.').find((b) => b.startsWith('terminal]'));
check(/command\s*=\s*"powershell\.exe"/.test(block2 || ''), 'it can be switched back to PowerShell');

app.close();
ws.close();
const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
