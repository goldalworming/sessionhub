// The Explorer shows a file an agent wrote without a click on ⟳ — and asks the
// daemon nothing while everything is quiet. Needs headless Chrome on :9222.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\treehome`;
const PROJ = `${SP}\\treeproj`;
const PORT = 7763;
const TOKEN = 'uji-tree';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
rmSync(PROJ, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(`${PROJ}\\existing.txt`, 'x');
writeFileSync(`${HOME}\\.sessionhub\\config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nremote_commands = true\nprojects = ['${PROJ}']\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3000);
const cli = (...a) => spawnSync(BIN, [...a, '--home', HOME], { encoding: 'utf8' });

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
let treeAsks = 0;
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Network.webSocketFrameSent' && /"t":"tree"/.test(m.params.response.payloadData)) treeAsks++;
};
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await ev(expr)) return true; await sleep(200); }
  return false;
};
const explorerOpen = `(() => { const f = document.getElementById('files'); return !f.hidden && f.offsetParent !== null; })()`;
// Opens or closes it, whatever state the profile left it in.
const setExplorer = async (want) => {
  if ((await ev(explorerOpen)) !== want) {
    await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Files')?.click()`);
  }
};
const names = `[...document.querySelectorAll('#files .frow .fname')].map(n => n.textContent)`;

await cmd('Network.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(4000);

const id = cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'tree-t').stdout.trim();
check(await waitFor(`!!document.querySelector('.tab[data-id="${id}"]')`, 10000), `terminal ${id} has a tab`);
await ev(`document.querySelector('.tab[data-id="${id}"]').click()`);
await sleep(1500);
await setExplorer(true);
check(await waitFor(`${explorerOpen} && ${names}.includes('existing.txt')`, 8000), 'the Explorer is open on the project');

// Quiet: nothing should be asked. (The shell's own start-up output is a run
// too, and its end is one look — waited out first.)
await sleep(8000);
treeAsks = 0;
await sleep(12000);
check(treeAsks === 0, `nothing is asked while everything is quiet (${treeAsks} requests in 12 s)`);

// An "agent" at work: output for a few seconds, a file written partway through.
cli('send', id,
  '1..12 | ForEach-Object { "working $_"; Start-Sleep -Milliseconds 300; if ($_ -eq 4) { Set-Content -Path written-by-agent.txt -Value hi } }',
  '--enter');
check(await waitFor(`${names}.includes('written-by-agent.txt')`, 20000), 'the new file appears without a click on refresh');
const during = treeAsks;
await sleep(12000);
check(treeAsks - during <= 2, `and asking stops once it is quiet again (${treeAsks - during} more in 12 s)`);
check(await ev(`!${names}.includes('Loading…')`), 'the tree never showed "Loading…" for it');

// With the Explorer closed, an agent at work asks for nothing.
await setExplorer(false);
await sleep(1000);
check(!(await ev(explorerOpen)), 'the Explorer is closed');
treeAsks = 0;
cli('send', id, '1..12 | ForEach-Object { "working $_"; Start-Sleep -Milliseconds 300 }', '--enter');
await sleep(12000);
check(treeAsks === 0, `nothing is asked while it is closed (${treeAsks} requests)`);

cli('stop');
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
