// A link that dies without saying so.
//
// The report: the terminal freezes, typing does nothing, and only reloading the
// page brings it back. A WebSocket does not always close loudly — a tunnel that
// idles it out, a phone changing network, a laptop waking up all leave the
// socket reading `OPEN` on the browser side while nothing crosses it. `send()`
// then succeeds into a void and `onclose` never fires, so the client had no way
// to find out.
//
// Chrome's offline emulation reproduces exactly that: it stops the traffic and
// leaves the existing socket open. That property was noted the first time the
// reconnect test was written — it is why that test had to close the socket by
// hand to have anything to measure. Here it is the point.
//
// Two things are checked: that the beat is real (pings go out, pongs come back)
// and that a silent death is noticed and recovered from with no reload.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1af81868-b2d4-4560-8e29-8ce58f28d35a\\scratchpad';
const BIN = 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\beathome`;
const PROJ = `${SP}\\savedproj`;
const PORT = 7742;
const TOKEN = 'uji-heartbeat';

const steps = [];
const check = (c, m) => {
  steps.push(c);
  console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = async () => {
  try {
    return (await (await fetch(`http://127.0.0.1:${PORT}/api/status?token=${TOKEN}`)).json()).version;
  } catch {
    return null;
  }
};

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
writeFileSync(
  `${HOME}\\.sessionhub\\config.toml`,
  [
    `port = ${PORT}`,
    'lan_access = false',
    `token = "${TOKEN}"`,
    `projects = ["${PROJ.split('\\').join('\\\\')}"]`,
    '',
  ].join('\n'),
);
spawn(BIN, ['start', '--home', HOME], { detached: true, stdio: 'ignore' }).unref();
for (let i = 0; i < 40 && !(await alive()); i++) await sleep(500);
check(!!(await alive()), `test daemon up on ${PORT}`);

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => {
  cdp.onopen = r;
});
let seq = 0;
const pending = new Map();
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const cmd = (method, params = {}) => {
  const i = ++seq;
  cdp.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pending.set(i, r));
};
const ev = async (e) =>
  (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))
    .result?.result?.value;
const waitFor = async (expr, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(expr)) return true;
    await sleep(500);
  }
  return false;
};

await cmd('Page.enable');
await cmd('Network.enable');
// Count what actually crosses the wire, both directions, before the app loads.
await cmd('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    window.__wire = { sent: [], got: [], sockets: 0 };
    const Real = window.WebSocket;
    window.WebSocket = function (...a) {
      const ws = new Real(...a);
      window.__wire.sockets++;
      const send = ws.send.bind(ws);
      ws.send = (d) => { if (typeof d === 'string') window.__wire.sent.push(d.slice(0, 40)); return send(d); };
      ws.addEventListener('message', (e) => {
        if (typeof e.data === 'string') window.__wire.got.push(e.data.slice(0, 30));
      });
      return ws;
    };
    window.WebSocket.prototype = Real.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) window.WebSocket[k] = Real[k];
  })()`,
});

await cmd('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 820,
  deviceScaleFactor: 1,
  mobile: false,
});
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5500);
await ev(`document.getElementById('backdrop')?.click()`);
await sleep(400);

// A terminal to type into, so "can you type again" is a real question.
await ev(`
  (() => {
    const row = [...document.querySelectorAll('#tree .row')]
      .find(r => (r.dataset.path || '').toLowerCase().includes('savedproj'));
    row.querySelector('.add').click();
  })()
`);
await sleep(500);
await ev(`
  [...document.querySelectorAll('#menu > div')]
    .find(x => /terminal/i.test(x.textContent)).click()
`);
check(await waitFor(`!!document.querySelector('.xterm')`, 20000), 'a terminal is open');
await sleep(2500);

// --- 1. the beat is real ----------------------------------------------------
console.log('    waiting out two ping intervals…');
await sleep(34000);
const wire = await ev(`JSON.stringify({
  pings: window.__wire.sent.filter(s => s.includes('"ping"')).length,
  pongs: window.__wire.got.filter(s => s.includes('"pong"')).length,
  sockets: window.__wire.sockets,
})`);
console.log(`    wire: ${wire}`);
const w = JSON.parse(wire);
check(w.pings >= 2, `the client sends pings on a timer (${w.pings})`);
check(w.pongs >= 2, `and the daemon answers every one (${w.pongs})`);
check(w.pongs >= w.pings - 1, 'none of them go unanswered');

// --- 2. a silent death is noticed -------------------------------------------
// Offline stops the traffic but leaves the socket open — the exact shape of the
// failure being fixed.
const socketsBefore = w.sockets;
await cmd('Network.emulateNetworkConditions', {
  offline: true,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
});
await sleep(2000);
check(
  await ev(`window.__wire.sockets === ${socketsBefore}`),
  'going offline does not close the socket by itself — this is the silent case',
);

console.log('    waiting for the client to notice the silence…');
const noticed = await waitFor(`!document.getElementById('banner').hidden`, 75000);
check(noticed, 'the client works out on its own that the link is gone');
console.log(`    banner: ${await ev(`document.getElementById('banner').textContent`)}`);

// --- 3. and recovers without a reload ---------------------------------------
await cmd('Network.emulateNetworkConditions', {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
});
check(
  await waitFor(`window.__wire.sockets > ${socketsBefore}`, 40000),
  'it opens a fresh socket by itself',
);
check(
  await waitFor(`document.getElementById('banner').hidden`, 40000),
  'and says so by clearing the warning',
);
check(
  await ev(`window.__wire.sockets > ${socketsBefore} && performance.getEntriesByType('navigation').length === 1`),
  'all of that without the page being reloaded',
);

// The real question: can you type again?
await sleep(2500);
await ev(`document.querySelector('.xterm-helper-textarea')?.focus()`);
const marker = 'hidup-lagi';
for (const ch of `echo ${marker}`) {
  await cmd('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
  await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
}
await cmd('Input.dispatchKeyEvent', {
  type: 'keyDown',
  key: 'Enter',
  code: 'Enter',
  windowsVirtualKeyCode: 13,
  text: '\r',
});
await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
check(
  await waitFor(
    `document.querySelector('.xterm-screen')?.textContent?.split('${marker}').length > 2`,
    25000,
  ),
  'and the terminal takes typing again — the shell echoes it back',
);

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
await sleep(1500);
cdp.close();
process.exit(steps.every(Boolean) ? 0 : 1);
