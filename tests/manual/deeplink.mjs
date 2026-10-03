// Deep links end to end: `?t=` opens a terminal, picking another changes the
// URL, a refresh keeps it; a bad name says so; `sessionhubd url` prints the
// link; `&embed=1` in an iframe from another local port shows only the
// terminal and takes typing. Needs headless Chrome on :9222.

import http from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\deephome`;
const PROJ = `${SP}\\deepproj`;
const PORT = 7767;
const HOST = 7768; // stands in for abwork
const TOKEN = 'uji-deep';

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

const a = cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'deep-a').stdout.trim();
const b = cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'deep-b').stdout.trim();
check(/^\d+$/.test(a) && /^\d+$/.test(b), `two named terminals (${a}, ${b})`);

// --- sessionhubd url ------------------------------------------------------------
const u = cli('url', 'deep-a').stdout.trim();
check(u === `http://127.0.0.1:${PORT}/?t=deep-a`, `url prints the link (${u})`);
const ue = cli('url', 'deep-a', '--embed').stdout.trim();
check(ue === `http://127.0.0.1:${PORT}/?t=deep-a&embed=1`, `with --embed (${ue})`);
const bad = cli('url', 'nope');
check(bad.status !== 0 && /no live terminal named/.test(bad.stderr), `an unknown name is refused (${bad.stderr.trim()})`);
check(!u.includes(TOKEN), 'no token in it');

// --- headers ----------------------------------------------------------------------
const head = await fetch(`http://127.0.0.1:${PORT}/?token=${TOKEN}`);
const csp = head.headers.get('content-security-policy') || '';
check(/frame-ancestors 'self' http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*/.test(csp), `framing limited to local origins (${csp})`);
const noauth = await fetch(`http://127.0.0.1:${PORT}/?t=deep-a`, { headers: { accept: 'text/html' } });
check(noauth.status === 401, `?t= without a token is still 401 (${noauth.status})`);

// --- the page -------------------------------------------------------------------
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0; const pending = new Map();
cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (e, contextId) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, contextId })).result?.result?.value;
const waitFor = async (expr, ms, contextId) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await ev(expr, contextId)) return true; await sleep(200); }
  return false;
};
const go = async (url) => { await cmd('Page.navigate', { url: 'about:blank' }); await sleep(200); await cmd('Page.navigate', { url }); };
await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });

// Signed in once, the usual way; the deep links after that carry no token.
await go(`http://127.0.0.1:${PORT}/?token=${TOKEN}`);
await sleep(3000);

await go(u);
check(await waitFor(`document.querySelector('.tab.active')?.dataset.id === '${a}'`, 10000), '?t=deep-a opens deep-a');
check(await ev(`location.search`) === '?t=deep-a', 'and the URL still names it');
await ev(`document.querySelector('.tab[data-id="${b}"]').click()`);
await sleep(800);
check(await ev(`location.search`) === '?t=deep-b', `picking another changes the URL (${await ev('location.search')})`);
await cmd('Page.reload');
check(await waitFor(`document.querySelector('.tab.active')?.dataset.id === '${b}'`, 10000), 'a refresh keeps deep-b');
await go(`http://127.0.0.1:${PORT}/?t=${a}`);
check(await waitFor(`document.querySelector('.tab.active')?.dataset.id === '${a}'`, 10000), 'an id works too');

await go(`http://127.0.0.1:${PORT}/?t=no-such-terminal`);
check(await waitFor(`!document.getElementById('empty').hidden && /no live terminal named/.test(document.getElementById('empty').textContent)`, 10000),
  'a name that is not there says so, where the terminal would be');

// --- embed, inside another local port's iframe ----------------------------------
const host = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><body style="margin:0"><iframe id="f" src="${ue}" style="width:900px;height:500px;border:0"></iframe></body>`);
});
await new Promise((r) => host.listen(HOST, '127.0.0.1', r));
await cmd('Page.enable');
await go(`http://127.0.0.1:${HOST}/`);
await sleep(5000);
const tree = await cmd('Page.getFrameTree');
const child = tree.result.frameTree.childFrames?.[0]?.frame;
check(!!child && child.url.startsWith(`http://127.0.0.1:${PORT}/`), `the iframe loaded (${child?.url})`);
const world = await cmd('Page.createIsolatedWorld', { frameId: child.id, worldName: 'probe' });
const ctx = world.result.executionContextId;
check(await waitFor(`document.documentElement.classList.contains('embed')`, 5000, ctx), 'embed mode is on');
check(await ev(`getComputedStyle(document.getElementById('sidebar')).display === 'none' && getComputedStyle(document.getElementById('tabs')).display === 'none'`, ctx),
  'no sidebar, no tab strip');
check(await waitFor(`[...document.querySelectorAll('.xterm')].some(x => x.offsetParent && x.getBoundingClientRect().width > 600)`, 10000, ctx),
  'the terminal fills the iframe');
await ev(`[...document.querySelectorAll('.xterm-helper-textarea')].find(t => t.closest('.xterm').offsetParent).focus()`, ctx);
for (const ch of 'echo EMBED-MARK-51') {
  await cmd('Input.dispatchKeyEvent', { type: 'char', text: ch });
}
await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
await sleep(2000);
check(/EMBED-MARK-51/.test(cli('capture', 'deep-a').stdout), 'typing in the iframe reaches the terminal');

cli('stop');
daemon.kill();
host.close();
cdp.close();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
