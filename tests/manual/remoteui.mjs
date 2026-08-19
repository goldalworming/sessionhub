// The machine bar from the browser side: pairing through a link, switching
// machines, and proving the contents of each tab really belong to its own
// machine.
//
// Needs Chrome --remote-debugging-port=9222 and two test daemons (7719, 7721).

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const NEAR = 7719;
const FAR = 7721;
const SEP = String.fromCharCode(92);
const SCRATCH = [
  'C:', 'Users', 'user', 'AppData', 'Local', 'Temp', 'claude',
  'C--data-code-terminal-editor2', '1c72f2cc-7025-4869-a627-df2b835ecce0', 'scratchpad',
].join(SEP);
const NEAR_CFG = join(SCRATCH, 'fakehome', '.sessionhub', 'config.toml');
const FAR_CFG = join(SCRATCH, 'farhome', '.sessionhub', 'config.toml');
const FAR_BOX = join(SCRATCH, 'farhome', 'faronly');

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!NEAR_CFG.includes('fakehome')) { console.error('ABORT: not the test config.'); process.exit(1); }
const NEAR_TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(NEAR_CFG, 'utf8'))[1];
const FAR_TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(FAR_CFG, 'utf8'))[1];

/// Every terminal still alive on the far machine, all killed off.
///
/// This must happen **before** its folder is removed: on Windows a process
/// holds on to the folder that is its working directory, and leftovers from an
/// earlier test run make `rm` fail with EPERM.
async function clearFar(alsoRemoveProject) {
  const ws = new WebSocket(`ws://127.0.0.1:${FAR}/ws?token=${FAR_TOKEN}`);
  await new Promise((r) => { ws.onopen = r; });
  const ids = await new Promise((res) => {
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data);
      if (m.t === 'state') res(m.terminals.filter((t) => t.alive).map((t) => t.id));
    };
  });
  for (const id of ids) ws.send(JSON.stringify({ t: 'kill', id }));
  if (alsoRemoveProject) ws.send(JSON.stringify({ t: 'remove_project', path: FAR_BOX }));
  await sleep(ids.length || alsoRemoveProject ? 1800 : 200);
  ws.close();
}

// A project that exists ONLY on the far machine — the clearest fingerprint.
await clearFar(false);
rmSync(FAR_BOX, { recursive: true, force: true });
mkdirSync(FAR_BOX, { recursive: true });
writeFileSync(join(FAR_BOX, 'far-marker.txt'), 'only on the far machine\n');
{
  const ws = new WebSocket(`ws://127.0.0.1:${FAR}/ws?token=${FAR_TOKEN}`);
  await new Promise((r) => { ws.onopen = r; });
  ws.send(JSON.stringify({ t: 'add_project', path: FAR_BOX }));
  await sleep(2500);
  ws.close();
}
// Clear out the pairings left over from an earlier test run.
{
  const ws = new WebSocket(`ws://127.0.0.1:${NEAR}/ws?token=${NEAR_TOKEN}`);
  await new Promise((r) => { ws.onopen = r; });
  const names = await new Promise((res) => {
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data);
      if (m.t === 'remotes') res(m.remotes.map((r) => r.name));
    };
    ws.send(JSON.stringify({ t: 'remotes' }));
  });
  // Only the names THIS suite creates. A blanket forget-everything once ran
  // against the wrong daemon and unpaired the user's real machine.
  const ours = names.filter((n) => n === '127-0-0-1' || n === 'jauh' || n === 'balik');
  for (const n of ours) ws.send(JSON.stringify({ t: 'forget', name: n }));
  await sleep(800);
  ws.close();
}

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cmd = (method, params = {}) => {
  const i = ++seq;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pending.set(i, r));
};
const ev = async (e) =>
  (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))
    .result?.result?.value;
const waitFor = async (expr, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(expr)) return true;
    await sleep(200);
  }
  return false;
};
const typeLink = (text) => `
  (() => {
    const i = document.querySelector('#pairdlg .pdlink');
    i.value = ${JSON.stringify(text)};
    i.oninput();
    return true;
  })()`;

await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.setItem('sh.theme','light'); localStorage.setItem('sh.files.open','0');
          localStorage.setItem('sh.layout','tabs'); localStorage.setItem('sh.sidebar.hidden','0')`);
await ev(`location.href = 'http://127.0.0.1:${NEAR}/?token=${NEAR_TOKEN}'`);
await sleep(4000);
check(await waitFor(`document.querySelectorAll('#tree .row').length > 0`), 'the page is connected to the near machine');

// --- 1. the machine bar --------------------------------------------------
check(await ev(`!!document.getElementById('mbar')`), 'the machine bar is there');
const tabs0 = await ev(`[...document.querySelectorAll('.mtab .mname')].map(n => n.textContent)`);
check(tabs0.length === 1 && tabs0[0] === 'This machine', `it starts out with one tab: ${tabs0.join(', ')}`);
check(
  await waitFor(`document.querySelector('.mtab .mdot')?.classList.contains('ok')`),
  'its status dot is green — connected',
);
check(!(await ev(`!!document.querySelector('.mtab .mx')`)), 'no tab carries a detach button — a mis-tap once unpaired a real machine');

// --- 2. the pairing dialog -----------------------------------------------
await ev(`document.querySelector('#mbar .madd').click()`);
await sleep(400);
check(await ev(`document.getElementById('pairdlg').hidden === false`), 'the pairing dialog opens');
check(
  !(await ev(`[...document.querySelectorAll('#pairdlg button')].some(b => /connect/i.test(b.textContent))`)),
  'there is no Connect button — a complete link already means "ask"',
);
check(
  await ev(`document.querySelector('#pairdlg .pdwarn').textContent.includes('full shell')`),
  'the warning names what is at stake',
);

// Half a link: nothing is sent, you are merely asked to keep typing.
await ev(typeLink(`sessionhub://127.0.0.1:${FAR}/pair`));
await sleep(600);
check(
  /not complete/.test(await ev(`document.querySelector('#pairdlg .pdnote').textContent`)),
  'half a link: "keep typing", not a request that gets sent',
);

// A wrong token: the message from the far machine, exactly as it comes.
await ev(typeLink(`sessionhub://127.0.0.1:${FAR}/pair#token=salah-sekali`));
check(
  await waitFor(`/refused the token/.test(document.querySelector('#pairdlg .pdnote').textContent)`),
  `a wrong token is refused with the message from over there: "${await ev(`document.querySelector('#pairdlg .pdnote').textContent`)}"`,
);

// The right one.
await ev(typeLink(`sessionhub://127.0.0.1:${FAR}/pair#token=${FAR_TOKEN}`));
check(await waitFor(`document.querySelectorAll('.mtab').length === 2`, 25000), 'the far machine turns up as a second tab');
check(await waitFor(`document.getElementById('pairdlg').hidden === true`), 'the dialog closes itself once it succeeds');

const tabs1 = await ev(`[...document.querySelectorAll('.mtab .mname')].map(n => n.textContent)`);
check(tabs1[0] === 'This machine', 'this machine stays on the left');
check(tabs1.length === 2 && tabs1[1].length > 0, `the second tab is named ${tabs1[1]}`);
check(
  await waitFor(`document.querySelectorAll('.mtab')[1].classList.contains('on')`),
  'it switches straight over to the machine just paired',
);

// --- 3. the contents really do belong to the far machine ------------------
check(
  await waitFor(`[...document.querySelectorAll('#tree .pname')].some(n => n.textContent === 'faronly')`, 25000),
  'the sidebar shows the project that exists only on the far machine',
);
const far = await ev(`[...document.querySelectorAll('#tree .pname')].map(n => n.textContent)`);
check(!far.includes('notex'), `the near machine projects are NOT mixed in (${far.join(', ')})`);

// A terminal on the far machine.
await ev(`
  (() => {
    const r = [...document.querySelectorAll('#tree .project .row')]
      .find(x => x.querySelector('.pname')?.textContent === 'faronly');
    r.querySelector('.add').click();
  })()
`);
await sleep(600);
const menu = await ev(`[...document.querySelectorAll('#menu div')].map(d => d.textContent)`);
check(
  menu.some((x) => /cmd/i.test(x)),
  `the + menu offers the agents BELONGING TO the far machine: ${menu.join(', ')}`,
);
await ev(`[...document.querySelectorAll('#menu div')].find(d => /cmd/i.test(d.textContent))?.click()`);
check(
  await waitFor(`document.querySelectorAll('#terms .mhost:not([hidden]) .host').length === 1`, 20000),
  'the terminal on the far machine opens in the container for that machine',
);
check(
  await waitFor(`document.querySelector('#terms .mhost:not([hidden]) .xterm-rows')?.textContent.length > 10`, 30000),
  'its contents are drawn — the PTY really is running over there',
);
check(
  await ev(`document.querySelectorAll('#terms .mhost')[0].querySelectorAll('.host').length === 0`),
  'and it does not stray into the container of the near machine',
);

// --- 4. switching back: the contents of the two machines do not mix ------
await ev(`document.querySelectorAll('.mtab')[0].click()`);
await sleep(1200);
const near = await ev(`[...document.querySelectorAll('#tree .pname')].map(n => n.textContent)`);
check(near.includes('notex'), 'going back to the near machine shows its projects again');
check(!near.includes('faronly'), 'and the projects of the far machine are not carried along');
check(
  await ev(`document.querySelectorAll('#terms .mhost').length === 2`),
  'the terminal containers of both machines are both still there',
);
check(
  await ev(`[...document.querySelectorAll('#terms .mhost')].filter(h => !h.hidden).length === 1`),
  'but only one of them is visible',
);

// Back to the far machine: its terminal is still alive, not re-attached.
await ev(`document.querySelectorAll('.mtab')[1].click()`);
await sleep(1200);
check(
  await ev(`document.querySelector('#terms .mhost:not([hidden]) .xterm-rows')?.textContent.length > 10`),
  'the far machine terminal is still intact after going back and forth',
);

// --- 5. the token never reaches the browser ------------------------------
const leak = await ev(`
  (() => {
    const all = Object.keys(localStorage).map(k => k + '=' + localStorage.getItem(k)).join('|');
    return { punyaFar: all.includes(${JSON.stringify(FAR_TOKEN)}), isi: Object.keys(localStorage).join(',') };
  })()
`);
check(!leak.punyaFar, `the far machine token is nowhere in the browser (${leak.isi})`);
check(
  !(await ev(`document.body.innerHTML.includes(${JSON.stringify(FAR_TOKEN)})`)),
  'and it turns up on no page at all',
);

// --- 6. detaching ---------------------------------------------------------
// Through Settings → Machines, deliberately: the ✕ that used to sit on the tab
// fired on a single tap, and a real machine was unpaired by a mis-tap on a
// phone. Forgetting now takes two clicks in a place nobody lands by accident.
check(!(await ev(`!!document.querySelectorAll('.mtab')[1]?.querySelector('.mx')`)), 'the remote tab has no one-tap detach either');
// Forget lives on the LOCAL machine's settings; make sure we are on its tab.
await ev(`document.querySelectorAll('.mtab')[0].click()`);
await sleep(600);
await ev(`document.getElementById('settings-btn')?.click() || document.querySelector('#sfoot button')?.click()`);
await sleep(600);
await ev(`document.querySelector('#settings .sitem[data-section="machines"]')?.click()`);
await sleep(600);
const forgetBtn = `[...document.querySelectorAll('#settings .agent')].find(a => a.querySelector('.aname')?.textContent === '127-0-0-1')?.querySelector('.del')`;
check(await ev(`!!${forgetBtn}`), 'the machine row in Settings offers Forget');
await ev(`${forgetBtn}.click()`);
await sleep(300);
check(await ev(`${forgetBtn}.textContent === 'Click again to forget'`), 'the first click only arms it');
check(await ev(`document.querySelectorAll('.mtab').length === 2`), 'and nothing is forgotten yet');
await ev(`${forgetBtn}.click()`);
check(await waitFor(`document.querySelectorAll('.mtab').length === 1`, 15000), 'the second click really forgets it');
await ev(`document.querySelector('#settings .close')?.click() || document.querySelector('#settings .shead .close')?.click()`);
await sleep(400);
check(
  await ev(`document.querySelector('.mtab').classList.contains('on')`),
  'and the view goes back to this machine',
);
check(
  await ev(`document.querySelectorAll('#terms .mhost').length === 1`),
  'its terminal container is cleaned up along with it',
);

await clearFar(true);
try {
  rmSync(FAR_BOX, { recursive: true, force: true });
} catch {
  console.log('    (the test folder is still in use by another process; left alone)');
}

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
