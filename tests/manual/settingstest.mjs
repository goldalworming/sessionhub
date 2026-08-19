// The settings panel: showing agent status, switching off the ones not yet
// installed, and editing their commands — all of it writes to a real config.toml.
import { writeFileSync, readFileSync } from 'node:fs';

const PORT = 7719;
const CFG = 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome\\.sessionhub\\config.toml';
// Read from the config rather than hard-coded: the daemon's token changes, and
// a stale copy here fails as "cannot connect", which says nothing about what
// this test is actually checking.
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

await cmd('Emulation.setDeviceMetricsOverride', { width: 1180, height: 780, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.setItem('sh.theme','light'); localStorage.setItem('sh.sidebar.hidden','0')`);
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5000);

// --- the button at the bottom left -------------------------------------------
/// Agents now sit behind the rail, and every row of them stays closed until it
/// is clicked. These two steps are used over and over, so they are written once.
const openAgents = () =>
  ev(`document.querySelector('#settings .sitem[data-section="agents"]')?.click()`);
const expandAgent = (name) =>
  ev(`
    (() => {
      const r = [...document.querySelectorAll('#settings .agent')]
        .find(a => a.querySelector('.aname')?.textContent === ${JSON.stringify(name)});
      if (r && !r.classList.contains('open')) r.querySelector('.ahead').click();
      return !!r;
    })()
  `);

check(await ev(`!!document.getElementById('settings-btn')`), 'the settings button is at the bottom left of the sidebar');
const position = await ev(`
  (() => {
    const b = document.getElementById('settings-btn').getBoundingClientRect();
    const s = document.getElementById('sidebar').getBoundingClientRect();
    return { diBawah: b.bottom > s.bottom - 40, diKiri: b.left < 20 };
  })()
`);
check(position.diBawah && position.diKiri, 'it really does sit at the bottom left');

// Looking up each command on PATH takes time; wait for the contents, do not guess.
/// Wait until the agent list really is there. The section that opens first is
/// Network, so the rail gets clicked first — otherwise this just waits for
/// something that has not been drawn at all.
const waitRows = async (ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await openAgents();
    const n = await ev(`document.querySelectorAll('#settings .agent').length`);
    if (n > 0) return n;
    await sleep(200);
  }
  return 0;
};

await ev(`document.getElementById('settings-btn').click()`);
await sleep(400);
check(await ev(`document.getElementById('settings').hidden === false`), 'the panel opens when clicked');
await waitRows();

// A safeguard: this test writes a real config, so make sure the thing being
// edited really is the test config. Without this, one wrong port could change
// settings that belong to the user.
const path2 = await ev(`document.querySelector('.shead .path').textContent`);
if (!path2.includes('fakehome')) {
  console.log(`  [ABORT] the panel points at the real config: ${path2}`);
  process.exit(2);
}

// --- the panel names whose machine is being edited ---------------------------
const badge = await ev(`
  JSON.stringify({
    teks: document.querySelector('#settings .smachine')?.innerText.trim(),
    jauh: document.querySelector('#settings .smachine')?.classList.contains('remote'),
    rail: [...document.querySelectorAll('#settings .sitem')].map(x => x.dataset.section),
  })
`).then(JSON.parse);
check(badge.teks === 'This machine', `the panel names its machine: "${badge.teks}"`);
check(badge.jauh === false, 'and it is not marked as a remote machine');
check(badge.rail.includes('machines'), 'the Machines section is present on this machine itself');

// The config path must not be twisted around by truncation from the left.
const fullPath = await ev(`document.querySelector('#settings .path').innerText`);
const SEP = String.fromCharCode(92); // backslash, written this way so that
                                     // no layered escape can go wrong
check(
  fullPath.startsWith('/') || /^[A-Za-z]:/.test(fullPath),
  `the path is intact, its beginning is not lost: ${fullPath}`,
);
check(
  !fullPath.endsWith('/') && !fullPath.endsWith(SEP),
  'and its separator does not move to the end — proof its contents are isolated from direction reversal',
);

// A structural check, not one of content: every element truncated from the
// left must wrap its contents in <bdi>. Without that, neutral characters at the
// end (`/`, `\`) travel along — and that only shows on unix paths, which never
// turn up if this test runs on Windows alone.
const isolated = await ev(`
  (() => {
    const el = [...document.querySelectorAll('#settings .path, #settings .awhere')];
    const tanpa = el.filter(x => !x.querySelector('bdi')).map(x => x.className);
    return JSON.stringify({ total: el.length, tanpa });
  })()
`).then(JSON.parse);
check(
  isolated.total > 0 && isolated.tanpa.length === 0,
  `every text truncated from the left has its direction isolated (${isolated.total} elements)`
    + (isolated.tanpa.length ? ` — missed: ${isolated.tanpa.join(', ')}` : ''),
);

const rows = await ev(`[...document.querySelectorAll('.agent .aname')].map(n => n.textContent)`);
console.log(`  agents in the panel: ${rows.join(', ')}`);
check(rows.length >= 4, `every agent is listed (${rows.length})`);
check(await ev(`document.querySelector('.shead .path').textContent.endsWith('config.toml')`), 'it shows the file that is being edited');

// --- installed / not installed status ----------------------------------------
// The row need not be opened: the state of each agent already reads off the
// status dot and the summary on the closed row — that is exactly what the
// design is for.
const status = await ev(`
  [...document.querySelectorAll('#settings .agent')].map(a => ({
    nama: a.querySelector('.aname').textContent,
    buruk: a.querySelector('.adot')?.classList.contains('bad') || false,
    teks: (a.querySelector('.awhere')?.textContent || '').slice(0, 60),
  }))
`);
for (const s of status) console.log(`    ${s.nama.padEnd(10)} ${s.buruk ? 'MISSING' : 'ok'}  ${s.teks}`);
const pi = status.find((s) => s.nama === 'pi');
check(pi?.buruk === true, 'pi is marked as not installed, rather than silently failing when clicked');
check(/not found on PATH/.test(pi?.teks || ''), 'the summary on its row names the problem');
await expandAgent('pi');
await sleep(400);
check(
  await ev(`/not found on PATH — enter its full path/.test(
    document.querySelector('#settings .agent.open .sstat.bad')?.textContent || '')`),
  'once opened, the message names what is wrong AND what can be done about it',
);

// --- switch pi off -----------------------------------------------------------
const before = readFileSync(CFG, 'utf8');
check(!/enabled\s*=\s*false/.test(before), 'no agent is switched off in the config yet');

await ev(`
  (() => {
    const row = [...document.querySelectorAll('#settings .agent')].find(a => a.querySelector('.aname').textContent === 'pi');
    const cb = row.querySelector('.ahead input[type=checkbox]');
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
  })()
`);
await sleep(2500);

const after = readFileSync(CFG, 'utf8');
check(/enabled\s*=\s*false/.test(after), 'the real config.toml changes along with it');
const piBlock = after.split('[agents.').find((b) => b.startsWith('pi]'));
check(/enabled\s*=\s*false/.test(piBlock || ''), 'the one switched off really is pi, not some other agent');

// --- the effect on the + menu ------------------------------------------------
await ev(`document.querySelector('#settings .close').click()`);
await sleep(1200);
await ev(`document.querySelector('.project .add').click()`);
await sleep(800);
const menu = await ev(`[...document.querySelectorAll('#menu div')].map(d => d.textContent)`);
console.log(`  menu +: ${menu.join(' | ')}`);
check(!menu.includes('New pi'), 'a switched-off agent disappears from the new terminal menu');
check(menu.includes('New claude') && menu.includes('New terminal'), 'the others are still there');
await ev(`document.body.click()`);

// --- edit the terminal command: powershell -> cmd ----------------------------
await ev(`document.getElementById('settings-btn').click()`);
await sleep(400);
await waitRows();
await expandAgent('terminal');
await sleep(400);
await ev(`
  (() => {
    const row = [...document.querySelectorAll('#settings .agent')].find(a => a.querySelector('.aname').textContent === 'terminal');
    const inp = row.querySelector('.abody input[type=text]');
    inp.value = 'cmd.exe';
    inp.dispatchEvent(new Event('change'));
  })()
`);
await sleep(2500);
const cfg2 = readFileSync(CFG, 'utf8');
const termBlock = cfg2.split('[agents.').find((b) => b.startsWith('terminal]'));
check(/command\s*=\s*"cmd\.exe"/.test(termBlock || ''), 'the terminal command is stored as cmd.exe');
check(
  await ev(`
    (() => {
      const t = [...document.querySelectorAll('#settings .agent')]
        .find(a => a.querySelector('.aname').textContent === 'terminal');
      return t.querySelector('.adot').classList.contains('ok')
        && /cmd\.exe/i.test(t.querySelector('.awhere').textContent);
    })()
  `),
  'the panel confirms straight away that cmd.exe really is found, and says where'
);

// An ordinary shell is given no field for a resume argument.
const terminalFields = await ev(`
  [...document.querySelectorAll('#settings .agent')].find(a => a.querySelector('.aname').textContent === 'terminal')
    .querySelectorAll('.abody input[type=text]').length
`);
check(terminalFields === 1, 'terminal is offered no resume argument (there is no session to continue)');

await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
const shot = await cmd('Page.captureScreenshot', { format: 'png' });
writeFileSync('setting.png', Buffer.from(shot.result.data, 'base64'));
console.log('  setting.png');

// --- put everything back as it was ------------------------------------------
await ev(`
  (() => {
    const t = [...document.querySelectorAll('.agent')].find(a => a.querySelector('.aname').textContent === 'terminal');
    const inp = t.querySelector('input[type=text]');
    inp.value = 'powershell.exe';
    inp.dispatchEvent(new Event('change'));
  })()
`);
await sleep(2000);
await ev(`
  (() => {
    const row = [...document.querySelectorAll('.agent')].find(a => a.querySelector('.aname').textContent === 'pi');
    const cb = row.querySelector('input[type=checkbox]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
  })()
`);
await sleep(2000);

// --- "Refresh app": the way out of a stale cache on a phone ------------------
// Last on purpose: the button reloads the page, and everything above still
// needs the page it was talking to. It must be in the Network pane even with
// LAN off — a phone reaching this daemon through a tunnel never used that
// switch — and clicking it must come back as a working app, not a blank page.
await ev(`document.querySelector('#settings .sitem[data-section="network"]')?.click()`);
await sleep(600);
check(await ev(`!!document.getElementById('refresh-app')`), 'the Refresh app button is in the Network pane');
// On a phone as well — and VISIBLY so. This button existed, passed its checks,
// and sat at x≈1067 in a 420 px viewport: the Settings grid let one unbreakable
// line (the config path) raise the column floor past the screen, and a DOM
// `click()` works fine on a button nobody can see. The assertion is therefore
// about geometry, not existence.
await cmd('Emulation.setDeviceMetricsOverride', { width: 420, height: 780, deviceScaleFactor: 2, mobile: true });
await sleep(800);
{
  const r = await ev(`
    (() => { const b = document.getElementById('refresh-app'); if (!b) return null;
             const x = b.getBoundingClientRect(); return { right: Math.round(x.right), w: Math.round(x.width) }; })()
  `);
  check(
    r && r.w > 0 && r.right <= 420,
    `at phone width the button is actually on screen (right edge ${r?.right} of 420)`,
  );
}
await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(800);
await ev(`window.__preRefresh = true`);
await ev(`document.getElementById('refresh-app').click()`);
await sleep(6000);
check(await ev(`window.__preRefresh === undefined`), 'clicking it really does reload the page');
check(await ev(`!!document.getElementById('sidebar')`), 'and the app comes back up afterwards');

ws.close();
const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
