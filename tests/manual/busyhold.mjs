// Two things that wait instead of working at a bad moment. The registry does
// not scan session files while the processor is busy, and scans what it was
// asked once it calms down. A phone with the page hidden does not reconnect
// until the page is looked at again. A scratch daemon; needs headless Chrome
// on :9222. Burns every core for about half a minute.

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';

const SP = process.env.SP || 'C:/Users/user/AppData/Local/Temp/sessionhub-busyhold';
const BIN = process.env.SH_BIN || 'C:/data/code/terminal-editor2/sessionhubd/target/debug/sessionhubd.exe';
const win = (p) => p.replaceAll('/', String.fromCharCode(92));
const PORT = 7826, TOKEN = 'uji-busyhold', HOME = `${SP}/home`, PROJ = `${SP}/proj`;
const SID = '7a1d2c3e-0000-4000-8000-00000000beef';
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
rmSync(PROJ, { recursive: true, force: true });
mkdirSync(`${HOME}/.sessionhub`, { recursive: true });
mkdirSync(`${HOME}/.claude/projects/proj`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
const session = `${HOME}/.claude/projects/proj/${SID}.jsonl`;
const line = (text) => JSON.stringify({ type: 'user', cwd: win(PROJ), sessionId: SID, message: { role: 'user', content: text } }) + '\n';
writeFileSync(session, line('judul pertama'));
writeFileSync(`${HOME}/.sessionhub/config.toml`, `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nprojects = ['${win(PROJ)}']\n`);
const start = () => spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
let daemon = start();
await sleep(4000);
const { SESSIONHUB_TERMINAL: _own, ...bare } = process.env;
const cli = (args) => spawnSync(BIN, [...args, '--home', HOME], { encoding: 'utf8', env: bare }).stdout.trim();
const events = (name) => {
  try {
    return readFileSync(`${HOME}/.sessionhub/telemetry.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.e === name);
  } catch { return []; }
};
const log = () => readFileSync(`${HOME}/.sessionhub/sessionhubd.log`, 'utf8');
const changes = () => (log().match(/registry changed/g) || []).length;

// ---- the registry waits out a busy processor
for (let i = 0; i < 40 && changes() === 0; i++) await sleep(500); // the first scan, which is never held
const before = changes();
const burners = cpus().map(() => new Worker('for(;;){}', { eval: true }));
await sleep(6000); // two readings of the processor, at least
writeFileSync(session, line('judul kedua, ditulis saat sibuk'));
await sleep(8000);
check(changes() === before, `while every core is taken, the changed session file is not scanned (${changes() - before} scans)`);
await Promise.all(burners.map((w) => w.terminate()));
let scanned = false;
for (let i = 0; i < 40 && !scanned; i++) { await sleep(500); scanned = changes() > before; }
check(scanned, 'once it calms down, the scan that was waiting runs');
const held = Number(log().match(/scan waited out a busy processor ms=([0-9]+)/)?.[1]);
check(held >= 2000, `and the log says how long it waited (${held} ms)`);

// ---- a hidden phone waits to be looked at
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const cdp = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const opens = () => (log().match(/client connected/g) || []).length;
const waitFor = async (fn, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (await fn()) return true; await sleep(300); } return false; };

// The page is told it is a phone before any of its own code runs.
await cmd('Page.enable');
await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__hidden = false;
  Object.defineProperty(document, 'hidden', { get: () => window.__hidden });
  Object.defineProperty(document, 'visibilityState', { get: () => (window.__hidden ? 'hidden' : 'visible') });
  const mm = window.matchMedia.bind(window);
  // Headless Chrome has no pointer at all, so both answers are given here.
  window.matchMedia = (q) => (q.includes('any-pointer: fine') ? { matches: !window.__phone, addEventListener() {}, removeEventListener() {} } : mm(q));
  window.__phone = true;
` });
const reconnectsWhileHidden = async (phone) => {
  await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}` });
  await sleep(2500);
  await ev(`window.__phone = ${phone}; window.__hidden = true; document.dispatchEvent(new Event('visibilitychange'))`);
  cli(['stop']);
  daemon.kill();
  await sleep(1500);
  // Counted from before the daemon is back: a desktop tab is in within 2 s.
  const at = opens();
  daemon = start();
  await sleep(14000); // the backoff tops out at 8 s
  return [at, opens()];
};
let [at, after] = await reconnectsWhileHidden(true);
check(after === at, `a hidden phone makes no connection while out of sight (${after - at})`);
await ev(`window.__hidden = false; document.dispatchEvent(new Event('visibilitychange'))`);
check(await waitFor(async () => { await sleep(1200); return opens() > at; }, 8000), 'and connects the moment the page is looked at');
[at, after] = await reconnectsWhileHidden(false);
check(after > at, `a hidden desktop tab still reconnects on its own (${after - at})`);

cli(['stop']);
daemon.kill();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
