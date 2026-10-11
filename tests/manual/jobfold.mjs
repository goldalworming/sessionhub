// Many background jobs under one terminal fold into one line in Live & Today,
// and open again on a click. The jobs are added to the daemon's state messages
// in the page. Needs headless Chrome on :9222.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\jbhome`;
const PROJ = `${SP}\\jbproj`;
const PORT = 7793;
const TOKEN = 'uji-jobs';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(`${HOME}\\.sessionhub\\config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nremote_commands = true\nprojects = ['${PROJ}']\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3000);
const cli = (...a) => spawnSync(BIN, [...a, '--home', HOME], { encoding: 'utf8' });
const id = cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'jb-alpha').stdout.trim();

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
const waitFor = async (expr, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (await ev(expr)) return true; await sleep(250); } return false; };

await cmd('Page.enable');
await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `
  const W = window.WebSocket;
  window.WebSocket = class extends W {
    set onmessage(f) {
      super.onmessage = (e) => {
        if (typeof e.data === 'string' && e.data.includes('"terminals"')) {
          const m = JSON.parse(e.data);
          for (const t of m.terminals || []) {
            t.working = true;
            t.jobs = [1, 2, 3, 4, 5, 6].map((i) => ({ kind: 'command', label: 'job number ' + i, since_ms: Date.now() - i * 60000 }));
          }
          return f(new MessageEvent('message', { data: JSON.stringify(m) }));
        }
        return f(e);
      };
    }
  };
` });
await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 860, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}` });
const shown = `[...document.querySelectorAll('.zjob:not(.zjmore)')].filter(e => e.offsetParent).length`;
const more = `document.querySelector('.zjmore')`;
check(await waitFor(`!!${more}`, 10000), 'six jobs fold into one line');
check(await ev(`${more}.textContent.includes('6 background jobs')`), 'which says how many');
check(await ev(shown) === 0, 'none of them listed while folded');
await ev(`${more}.click()`);
check(await waitFor(`${shown} === 6`, 3000), 'a click lists all six');
await sleep(2500);
check(await ev(shown) === 6, 'and they stay listed across redraws');
await ev(`${more}.click()`);
check(await waitFor(`${shown} === 0`, 3000), 'a second click folds them again');

cli('stop');
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
