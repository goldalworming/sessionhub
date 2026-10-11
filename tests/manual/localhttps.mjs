// Settings → Machines offers to open this machine's tunnel hostname locally,
// naming it. The prompt itself is not pressed here: it changes the real hosts
// file and the trusted certificates — that step is tried by hand. Needs
// headless Chrome on :9222.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\lhhome`;
const PROJ = `${SP}\\lhproj`;
const PORT = 7794;
const TOKEN = 'uji-lh';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(`${HOME}\\.sessionhub\\config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nremote_commands = true\nprojects = ['${PROJ}']\n` +
  `[cloudflare]\napi_token = "x"\nzone_id = "z"\nzone_name = "example.com"\naccount_id = "a"\ntunnel_id = "t"\ntunnel_name = "dev"\n`);
// The hostname as Cloudflare would have answered it, fresh, so nothing is asked.
writeFileSync(`${HOME}\\.sessionhub\\public-host`, `${PORT} sbox.example.com\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3000);
const cli = (...a) => spawnSync(BIN, [...a, '--home', HOME], { encoding: 'utf8' });

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map(); const sent = [];
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Network.webSocketFrameSent' && /"t":"local_https"/.test(m.params.response.payloadData)) sent.push(m.params.response.payloadData);
};
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr)) return true; await sleep(250); } return false; };

await cmd('Network.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 860, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}` });
await sleep(3000);
await ev(`document.getElementById('settings-btn').click()`);
await sleep(1500);
await ev(`document.querySelector('[data-section="machines"]').click()`);
const pane = `document.querySelector('#settings .spane')?.textContent || ''`;
check(await waitFor(`(${pane}).includes('Open https://sbox.example.com on this computer')`, 8000), 'Machines names the hostname to open locally');
const btn = `[...document.querySelectorAll('#settings .secbtn')].find(b => /Open locally/.test(b.textContent))`;
check(await ev(`!!(${btn}) && !(${btn}).disabled`), 'with a button to do it');
check(await ev(`/one administrator prompt, on this computer/.test(${pane})`), 'that says what it will ask for');
check(sent.length === 0, 'nothing is sent until it is pressed');

cli('stop');
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
