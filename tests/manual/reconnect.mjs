// Acceptance #8 from the UI side: the network is cut, the UI reconnects by
// itself and the terminal screen comes back intact without a manual refresh.

import { readFileSync } from 'node:fs';

const CDP = 'http://127.0.0.1:9222';
const PORT = 7719;
// Read from the config rather than hard-coded: the daemon's token changes, and
// a stale copy here fails as "cannot connect", which says nothing about what
// this test is actually checking.
const CFG = 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome\\.sessionhub\\config.toml';
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`${CDP}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => { ws.onopen = res; });

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cmd = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, res));
};
async function evaluate(expression) {
  const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
}
const screenText = () =>
  evaluate(`Array.from(document.querySelectorAll('.xterm-rows > div')).map(r=>r.textContent).join('').replace(/\\s+/g,' ').trim()`);

// Keep a handle on every socket the page opens, from before the first line of
// app code runs. Nothing exposes the connection on `window`, and this test has
// to be able to break it.
await cmd('Page.enable');
await cmd('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__sockets = [];
    const Asli = window.WebSocket;
    window.WebSocket = function (...args) {
      const s = new Asli(...args);
      window.__sockets.push(s);
      return s;
    };
    window.WebSocket.prototype = Asli.prototype;
    Object.assign(window.WebSocket, { OPEN: Asli.OPEN, CLOSED: Asli.CLOSED, CONNECTING: Asli.CONNECTING, CLOSING: Asli.CLOSING });
  `,
});

// Open a terminal of our own first. This test is about a screen surviving a
// broken connection, so there has to be a screen with something on it; relying
// on one another test happened to leave behind makes the result depend on the
// order the suite runs in.
const spawn = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((res) => { spawn.onopen = res; });
const seen = [];
spawn.onmessage = (e) => { if (typeof e.data === 'string') seen.push(JSON.parse(e.data)); };
await (async () => { while (!seen.find((m) => m.t === 'state')) await sleep(100); })();
const proj = seen.find((m) => m.t === 'state').projects.find((p) => p.exists)?.path;
spawn.send(JSON.stringify({ t: 'spawn', project: proj, agent: 'terminal', resume: null, cols: 100, rows: 26 }));
await (async () => { while (!seen.find((m) => m.t === 'attached')) await sleep(100); })();
// Put something on the screen: an empty prompt is not proof that a replay
// worked. Typing is a binary frame — the terminal id, then the bytes — and not
// a JSON message; sent as JSON it is silently ignored.
{
  const body = Buffer.from('echo sessionhub-reconnect-marker\r', 'utf8');
  const f = Buffer.alloc(4 + body.length);
  f.writeUInt32LE(seen.find((m) => m.t === 'attached').id, 0);
  body.copy(f, 4);
  spawn.send(f);
}
await sleep(2500);
spawn.close();

await evaluate(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(4000);
await evaluate(`document.querySelector('.tab')?.click()`);
await sleep(3000);

const before = await screenText();
check(before.length > 40, `terminal is populated before the disruption (${before.length} characters)`);
check(await evaluate(`document.getElementById('banner').hidden === true`), 'no warning banner while the connection is healthy');

// --- pull the connection out -------------------------------------------------
// Closing the socket, not going offline. `Network.emulateNetworkConditions`
// leaves an already-open WebSocket alone, and the client has no heartbeat: it
// learns of a broken link from `onclose` and nowhere else, so an "offline"
// browser produced no banner and the reconnect below finished in 0.0 s without
// anything ever having been disconnected. Closing the transport is what a
// dropped connection does to the page, and it reaches the same `onclose`.
const closed = await evaluate(`
  (() => {
    const live = (window.__sockets || []).filter(s => s.readyState === WebSocket.OPEN);
    live.forEach(s => s.close());
    return live.length;
  })()
`);
check(closed > 0, `the app's connection is closed under it (${closed} socket)`);
// Catch it while it is up. The backoff starts at half a second, so on a healthy
// machine the banner can come and go inside a single fixed sleep — waiting a
// second and then looking once reports "no banner" for a banner that worked.
let bannerShown = false;
let bannerText = '';
for (let i = 0; i < 40; i++) {
  bannerShown = await evaluate(`!document.getElementById('banner').hidden`);
  if (bannerShown) { bannerText = await evaluate(`document.getElementById('banner').textContent`); break; }
  await sleep(50);
}
check(bannerShown, `the banner appears when the connection drops: "${bannerText}"`);
check(/reconnecting/i.test(bannerText || ''), 'the banner explains what is going on');

let ok = false;
const t0 = Date.now();
while (Date.now() - t0 < 25000) {
  if (await evaluate(`document.getElementById('banner').hidden === true`)) { ok = true; break; }
  await sleep(500);
}
check(ok, `reconnects by itself without a refresh (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

await sleep(2500);
const after = await screenText();
check(after.length > 40, `the terminal screen is populated again (${after.length} characters)`);
check(!/Welcome back.*Welcome back/s.test(after), 'the contents are not drawn twice after the replay');

// The terminal is still genuinely alive, not just a leftover image.
await evaluate(`
  (() => {
    const t = document.querySelector('.xterm-helper-textarea');
    if (t) { t.focus(); }
  })()
`);
console.log(`  screen excerpt: ${after.slice(0, 90)}`);

ws.close();
const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
