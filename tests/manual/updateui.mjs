// The Update section: ask GitHub what the newest release is, and offer to
// install it — but only when installing it would actually work.
//
// The check is real: it goes to the live releases API for this repo. What it
// must NOT do is offer an Update button while the daemon is already newest,
// because pressing it kills every live terminal for nothing.
//
// Installing is not exercised here, and could not honestly be: it replaces the
// binary and restarts the daemon out from under the test. Its parts are covered
// where they can be — version comparison and asset picking are unit-tested in
// src/update.rs, and the swap itself is a shell script that only runs once this
// process is gone.

import { readFileSync } from 'node:fs';

const PORT = 7719;
const CFG = 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome\\.sessionhub\\config.toml';
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0;
const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const waitFor = async (expr, ms = 25000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await ev(expr)) return true; await sleep(250); }
  return false;
};

await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5000);
await ev(`document.getElementById('backdrop')?.click()`);
await sleep(400);
await ev(`document.getElementById('settings-btn')?.click() || document.querySelector('#sfoot button')?.click()`);
await sleep(700);

check(
  await ev(`[...document.querySelectorAll('#settings .sitem')].some(x => x.dataset.section === 'update')`),
  'Settings has an Update section',
);
await ev(`document.querySelector('#settings .sitem[data-section="update"]').click()`);
await sleep(500);
check(await ev(`!!document.getElementById('update-check')`), 'it offers a Check for updates button');
check(
  !(await ev(`!!document.getElementById('update-apply')`)),
  'and no install button before anything has been checked',
);

// The real request, to the real repo.
await ev(`document.getElementById('update-check').click()`);
const answered = await waitFor(`
  (() => {
    const t = document.querySelector('#settings .sec.update')?.textContent || '';
    return /Running \\d|newest release|is available|no build for/.test(t);
  })()
`, 30000);
check(answered, 'the check comes back with an answer from GitHub');

const shown = await ev(`document.querySelector('#settings .sec.update').textContent`);
console.log(`    panel says: ${shown.replace(/\s+/g, ' ').slice(0, 150)}`);

// The daemon under test was built from this working tree, so it is at least as
// new as the newest release. The button that kills terminals must stay away.
check(
  /newest release/.test(shown),
  'a daemon that is already current says so',
);
check(
  !(await ev(`!!document.getElementById('update-apply')`)),
  'and offers no Update button — pressing one would kill live terminals for nothing',
);

// The version is the daemon's own, not something the page made up.
const daemonVersion = await (async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/status?token=${TOKEN}`);
  return (await r.json()).version;
})();
check(
  shown.includes(daemonVersion),
  `the version shown is the one the daemon reports (${daemonVersion})`,
);

await ev(`document.querySelector('#settings .close').click()`);
await cmd('Emulation.clearDeviceMetricsOverride');

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
