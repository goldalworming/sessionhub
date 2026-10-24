// The Explorer's cache belongs to one machine. Switching to another and
// refreshing must not ask it for the first machine's folders — that came back
// "not found" in bursts and folded them away — and coming back finds them as
// they were. Two scratch daemons, one paired to the other. Needs headless
// Chrome on :9222.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:/Users/user/AppData/Local/Temp/claude/C--data-code-terminal-editor2-sessionhubd/' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912/scratchpad';
const BIN = process.env.SH_BIN || 'C:/data/code/terminal-editor2/sessionhubd/target/debug/sessionhubd.exe';
const win = (p) => p.replaceAll('/', '\\');
const NEAR = { port: 7798, token: 'uji-near', home: `${SP}/nearhome`, proj: `${SP}/nearproj` };
const FAR = { port: 7799, token: 'uji-far', home: `${SP}/farhome`, proj: `${SP}/farproj` };

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const d of [NEAR.home, NEAR.proj, FAR.home, FAR.proj]) rmSync(d, { recursive: true, force: true });
mkdirSync(`${NEAR.proj}/sub`, { recursive: true });
writeFileSync(`${NEAR.proj}/sub/near-only.txt`, 'near\n');
mkdirSync(`${FAR.proj}/deep`, { recursive: true });
writeFileSync(`${FAR.proj}/deep/far-only.txt`, 'far\n');
const cfg = (m, extra = '') =>
  `port = ${m.port}\nlan_access = false\ntoken = "${m.token}"\nprojects = ['${win(m.proj)}']\n${extra}`;
mkdirSync(`${FAR.home}/.sessionhub`, { recursive: true });
writeFileSync(`${FAR.home}/.sessionhub/config.toml`, cfg(FAR));
mkdirSync(`${NEAR.home}/.sessionhub`, { recursive: true });
writeFileSync(`${NEAR.home}/.sessionhub/config.toml`,
  cfg(NEAR, `\n[[remotes]]\nname = "far"\naddr = "127.0.0.1:${FAR.port}"\ntoken = "${FAR.token}"\n`));

const daemons = [FAR, NEAR].map((m) =>
  spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', m.home], { stdio: 'ignore' }));
await sleep(3500);
// Never the one of whatever terminal runs this test: `show` would aim at it.
const { SESSIONHUB_TERMINAL: _own, ...bare } = process.env;
const cli = (m, args, env = {}) =>
  spawnSync(BIN, [...args, '--home', m.home], { encoding: 'utf8', env: { ...bare, ...env } });
const tNear = cli(NEAR, ['spawn', '--agent', 'terminal', '--project', win(NEAR.proj)]).stdout.trim();
const tFar = cli(FAR, ['spawn', '--agent', 'terminal', '--project', win(FAR.proj)]).stdout.trim();
check(/^\d+$/.test(tNear) && /^\d+$/.test(tFar), `a terminal on each machine (${tNear}, ${tFar})`);

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
// Every frame the page sends, with the socket it went down. Both daemons share
// this disk, so a folder asked of the wrong one would still open — what gives
// the mistake away is which socket the question travelled on.
const sockets = new Map();
const sent = [];
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.webSocketCreated') sockets.set(m.params.requestId, m.params.url);
  if (m.method === 'Network.webSocketFrameSent') sent.push({ url: sockets.get(m.params.requestId) || '', data: m.params.response.payloadData });
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr)) return true; await sleep(250); } return false; };

await cmd('Network.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `http://127.0.0.1:${NEAR.port}/?token=${NEAR.token}&t=${tNear}` });
await sleep(4000);
const rows = `[...document.querySelectorAll('#files .frow')].map(r => r.textContent.trim())`;
const tab = (name) => `[...document.querySelectorAll('.mtab')].find(t => t.textContent.includes('${name}'))?.click()`;

cli(NEAR, ['show', `${NEAR.proj}/sub/near-only.txt`], { SESSIONHUB_TERMINAL: tNear });
check(await waitFor(`(${rows}).some(t => t.includes('near-only.txt'))`, 8000), 'on this machine, a folder is unfolded down to a file');

// A search belongs to the machine it was typed on.
await ev(`(() => { const f = document.getElementById('filter'); f.value = 'nearproj'; f.dispatchEvent(new Event('input')); })()`);
await ev(tab('far'));
check(await waitFor(`!!document.querySelector('.mtab.on') && document.querySelector('.mtab.on').textContent.includes('far')`, 8000), 'switched to the far machine');
check(await waitFor(`document.getElementById('filter').value === '' && document.getElementById('filter-clear')?.hidden !== false`, 3000),
  `its search box is empty, not this machine's search (${JSON.stringify(await ev(`document.getElementById('filter').value`))})`);
await ev(`document.querySelector('[data-id="${tFar}"]')?.click()`);
check(await waitFor(`(${rows}).some(t => t.includes('farproj'))`, 10000), `its Explorer shows its own project (${JSON.stringify(await ev(rows))})`);
await ev(`document.querySelector('#files .frefresh').click()`);
await sleep(3000);
const wrong = sent.filter((f) => /via=far/.test(f.url) && /"t":"tree"/.test(f.data) && /nearproj/.test(f.data));
check(wrong.length === 0, `the far machine is never asked for this machine's folders (${wrong.length} asked)`);

await ev(tab('This machine'));
check(await waitFor(`(${rows}).some(t => t.includes('near-only.txt'))`, 8000),
  `back here, the folder is still unfolded (${JSON.stringify(await ev(rows))})`);
check(await waitFor(`document.getElementById('filter').value === 'nearproj'`, 3000), 'and the search typed here is back');

// What the page logged: no folder asked of the wrong machine.
await cmd('Page.navigate', { url: 'about:blank' });
await sleep(2000);
const log = (() => { try { return readFileSync(`${NEAR.home}/.sessionhub/telemetry.jsonl`, 'utf8'); } catch { return ''; } })()
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const failed = log.filter((e) => e.e === 'error' && e.code === 'tree_failed');
check(failed.length === 0, `no folder failed to open (${JSON.stringify(failed)})`);

for (const m of [NEAR, FAR]) cli(m, ['stop']);
for (const d of daemons) d.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
