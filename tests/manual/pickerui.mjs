// The "New project" flow from the browser side: open the picker, browse, make
// a new folder, then turn it into a project and make sure it really does turn
// up in the sidebar.
// Needs Chrome with --remote-debugging-port=9222 and the test daemon on 7719.

import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 7719;
const HOME =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome';
const CFG = join(HOME, '.sessionhub', 'config.toml');
const SANDBOX = join(HOME, 'pickbox');
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cfgText = () => readFileSync(CFG, 'utf8');

rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(join(SANDBOX, 'zebra'), { recursive: true });
mkdirSync(join(SANDBOX, 'Apple', '.git'), { recursive: true });

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
const waitFor = async (expr, ms = 10000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(expr)) return true;
    await sleep(200);
  }
  return false;
};

await cmd('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.setItem('sh.theme','light'); localStorage.setItem('sh.sidebar.hidden','0')`);
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5000);

// The last folder from an earlier test must not get in the way of the first step.
await ev(`localStorage.removeItem('sh.picker.path')`);
await ev(`location.reload()`);
await sleep(4000);

// --- 1. the button is in the sidebar toolbar --------------------------------
check(await ev(`!!document.getElementById('new-project')`), 'the New project button is in the sidebar toolbar');
check(
  await ev(`document.getElementById('new-project').title.includes('folder')`),
  'its tooltip explains that this is about choosing a folder',
);

await ev(`document.getElementById('new-project').click()`);
check(await waitFor(`document.getElementById('picker')?.hidden === false`), 'the picker opens when clicked');
check(await waitFor(`document.querySelectorAll('#picker .pentry').length > 0`), 'its contents load');

// A safeguard: this test writes the config and creates real folders.
const start = await ev(`document.querySelector('#picker .ppath').value`);
if (!start.includes('fakehome')) { console.log(`  [ABORT] pointing at the real home: ${start}`); process.exit(2); }
check(start.toLowerCase() === HOME.toLowerCase(), `it starts from home: ${start}`);

const roots = await ev(`[...document.querySelectorAll('#picker .root')].map(b => b.textContent)`);
check(roots.includes('Home'), `shortcuts to starting points are available: ${roots.join(', ')}`);
check(roots.some((r) => /^[A-Z]:$/.test(r)), 'the drives are offered as well');

// --- 2. browse by typing a path ---------------------------------------------
await ev(`
  (() => {
    const i = document.querySelector('#picker .ppath');
    i.value = ${JSON.stringify(SANDBOX)};
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()
`);
check(await waitFor(`document.querySelectorAll('#picker .pentry').length === 2`), 'Enter in the path box moves folder straight away');

const entries = await ev(`
  [...document.querySelectorAll('#picker .pentry')].map(r => ({
    nama: r.querySelector('.pname').textContent,
    ikon: r.querySelector('.pico').textContent,
    repo: r.querySelector('.pico').title,
  }))
`);
check(entries.map((e) => e.nama).join(',') === 'Apple,zebra', `alphabetical order regardless of capitals: ${entries.map((e) => e.nama).join(', ')}`);
check(entries.find((e) => e.nama === 'Apple')?.repo === 'Git repository', 'a git repo is marked and explained through a tooltip');
check(entries.find((e) => e.nama === 'zebra')?.repo === '', 'what is not a repo is given no mark');

// --- 3. click to go in, the up button to come back --------------------------
await ev(`[...document.querySelectorAll('#picker .pentry')].find(r => r.querySelector('.pname').textContent === 'zebra').click()`);
check(await waitFor(`document.querySelector('#picker .ppath').value.endsWith('zebra')`), 'clicking a folder goes into it');
check(await ev(`document.querySelector('#picker .pempty') !== null`), 'an empty folder says that it is empty rather than staying silent');

await ev(`document.querySelector('#picker .up').click()`);
check(await waitFor(`document.querySelector('#picker .ppath').value.endsWith('pickbox')`), 'the up button goes back to its parent');

// --- 4. create a new folder and go straight into it -------------------------
check(await ev(`document.querySelector('#picker .mkname').hidden === true`), 'the folder name field stays hidden until it is needed');
await ev(`document.querySelector('#picker .mk').click()`);
check(await ev(`document.querySelector('#picker .mkname').hidden === false`), 'clicking New folder brings up its name field');

await ev(`
  (() => {
    const i = document.querySelector('#picker .mkname');
    i.value = 'proyek-dari-ui';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()
`);
check(await waitFor(`document.querySelector('#picker .ppath').value.endsWith('proyek-dari-ui')`), 'the folder is created and then entered right away, in one step');
check(existsSync(join(SANDBOX, 'proyek-dari-ui')), 'the folder really is there on disk');

// --- 5. a bad name is refused without closing the picker --------------------
await ev(`document.querySelector('#picker .mk').click()`);
await ev(`
  (() => {
    const i = document.querySelector('#picker .mkname');
    i.value = '..\\\\keluar';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()
`);
await sleep(1200);
const error2 = await ev(`document.querySelector('#picker .pnote').textContent`);
check(/cannot contain/.test(error2), `an invalid name is refused with a reason: "${error2}"`);
check(await ev(`document.getElementById('picker').hidden === false`), 'the picker stays open, no work is lost');
check(!existsSync(join(HOME, 'keluar')), 'no folder is created outside the target');

// --- 6. turn it into a project (the quiet, add-only path) --------------------
check(await ev(`document.querySelector('#picker .addonly').hidden === false`), 'Add to sidebar only is offered for a folder that is not a project yet');
await ev(`document.querySelector('#picker .addonly').click()`);
check(await waitFor(`document.getElementById('picker').hidden === true`, 15000), 'the picker closes itself once the project has been added');
check(/pickbox/.test(cfgText()), 'it is written into config.toml');

const inSidebar = await waitFor(
  `[...document.querySelectorAll('#tree .row')].some(r => r.dataset.path && r.dataset.path.endsWith('proyek-dari-ui'))`,
  15000,
);
check(inSidebar, 'the new project turns up in the sidebar without a reload');
const news = await ev(`document.getElementById('banner').hidden ? '' : document.getElementById('banner').textContent`);
check(/proyek-dari-ui/.test(news) && /\+/.test(news), `you are told the next step: "${news}"`);

// --- 7. a project folder is no dead end anymore ------------------------------
// "Already a project" used to disable the primary button — the exact place a
// user came to do something told them only what they could not do, and finding
// the project in the sidebar from there was their problem.
await ev(`document.getElementById('new-project').click()`);
check(await waitFor(`document.querySelector('#picker .ppath')?.value.endsWith('proyek-dari-ui')`), 'opening it again comes back to the last folder');
const again = await ev(`
  (() => {
    const b = document.querySelector('#picker .use');
    return { mati: b.disabled, teks: b.textContent,
             addHidden: document.querySelector('#picker .addonly').hidden,
             catatan: document.querySelector('#picker .pnote').textContent };
  })()
`);
check(again.mati === false, 'Open here… stays alive on a folder that is already a project');
check(again.teks === 'Open here…', `and keeps its name: "${again.teks}"`);
check(again.addHidden === true, 'only the add-only button goes away — there is nothing left to add');
check(/Open here/.test(again.catatan), `the note points at the action instead of replacing it: "${again.catatan}"`);

await ev(`document.querySelector('#picker .up').click()`);
await waitFor(`document.querySelectorAll('#picker .pentry').length > 0`);
const marked = await ev(`
  [...document.querySelectorAll('#picker .pentry')].map(r => ({
    nama: r.querySelector('.pname').textContent,
    tag: r.querySelector('.ptag')?.textContent || '',
  }))
`);
check(
  marked.find((e) => e.nama === 'proyek-dari-ui')?.tag === 'project',
  'in the folder list too it is marked as already being a project',
);

// --- 8. drop it again through the button available right there --------------
await ev(`[...document.querySelectorAll('#picker .pentry')].find(r => r.querySelector('.pname').textContent === 'proyek-dari-ui').click()`);
await waitFor(`document.querySelector('#picker .ppath').value.endsWith('proyek-dari-ui')`);
check(await ev(`document.querySelector('#picker .drop').hidden === false`), 'the drop button appears for one that is already a project');
await ev(`document.querySelector('#picker .drop').click()`);
await sleep(2500);
check(!/pickbox/.test(cfgText()), 'out of config.toml again');
check(
  await waitFor(
    `![...document.querySelectorAll('#tree .row')].some(r => r.dataset.path && r.dataset.path.endsWith('proyek-dari-ui'))`,
  ),
  'and gone from the sidebar',
);
check(await ev(`document.querySelector('#picker .addonly').hidden === false`), 'Add to sidebar only is offered again, so it can be added back');

// --- 8b. Open here…: pick a folder, pick an agent, get a terminal ------------
// The flow the dialog exists for. Choosing an agent on a NON-project folder
// must do the whole job at once: add the project, start the agent there, close
// the picker — not leave the user to hunt the sidebar for what they just made.
const agentNames = await ev(`
  (() => {
    const b = document.querySelector('#picker .use');
    b.click();
    const m = document.getElementById('menu');
    return m.hidden ? null : [...m.querySelectorAll('div')].map(d => d.textContent);
  })()
`);
check(Array.isArray(agentNames) && agentNames.length > 0, `Open here… opens the agent menu (${(agentNames || []).join(', ')})`);
check(
  agentNames.every((n) => n.startsWith('New ')),
  'the entries read like the sidebar ＋ menu: New <agent>',
);
check(
  await ev(`
    (() => {
      const m = document.getElementById('menu').getBoundingClientRect();
      // Above the picker's scrim, not underneath it: z-index is easy to break
      // silently, so it is asserted where a click actually lands.
      const hit = document.elementFromPoint(m.x + m.width / 2, m.y + 8);
      return !!hit && document.getElementById('menu').contains(hit);
    })()
  `),
  'the menu sits above the picker, where it can be clicked',
);
const tabsBefore = await ev(`document.querySelectorAll('.tab').length`);
await ev(`[...document.querySelectorAll('#menu div')].find(d => /New (terminal|shell)/.test(d.textContent))?.click()`);
check(await waitFor(`document.getElementById('picker').hidden === true`, 15000), 'choosing an agent closes the picker');
check(await waitFor(`document.querySelectorAll('.tab').length === ${tabsBefore} + 1`, 20000), 'and a terminal in that folder is attached');
// The config check runs on THIS side — cfgText() reads the daemon's real file.
{
  let inCfg = false;
  for (let i = 0; i < 50 && !inCfg; i++) {
    inCfg = /proyek-dari-ui/.test(cfgText());
    if (!inCfg) await sleep(200);
  }
  check(inCfg, 'the folder went into config.toml on the way');
}
check(
  await waitFor(
    `[...document.querySelectorAll('#tree [data-path]')].some(r => r.dataset.path.endsWith('proyek-dari-ui'))`,
    15000,
  ),
  'and the project is in the sidebar without any hunting',
);

// The SAME action on a folder that is already a project: works identically,
// without writing a duplicate into the config.
await ev(`document.getElementById('new-project').click()`);
await waitFor(`document.querySelector('#picker .ppath')?.value.endsWith('proyek-dari-ui')`);
const tabsBefore2 = await ev(`document.querySelectorAll('.tab').length`);
await ev(`document.querySelector('#picker .use').click()`);
await waitFor(`!document.getElementById('menu').hidden`, 5000);
await ev(`[...document.querySelectorAll('#menu div')].find(d => /New (terminal|shell)/.test(d.textContent))?.click()`);
check(await waitFor(`document.querySelectorAll('.tab').length === ${tabsBefore2} + 1`, 20000), 'on an existing project it opens a terminal just the same');
check(
  (cfgText().match(/proyek-dari-ui/g) || []).length === 1,
  'without writing the project into config.toml twice',
);

// Clean up what 8b started, through the protocol: the two terminals, then the
// project entry, so section 9 finds the config the way earlier runs left it.
{
  const dws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise((r) => { dws.onopen = r; });
  const got = [];
  dws.onmessage = (e) => { if (typeof e.data === 'string') got.push(JSON.parse(e.data)); };
  for (let i = 0; i < 50 && !got.find((m) => m.t === 'state'); i++) await sleep(100);
  const st = got.find((m) => m.t === 'state');
  for (const t of st.terminals.filter((x) => x.alive && /proyek-dari-ui$/i.test(x.project))) {
    dws.send(JSON.stringify({ t: 'kill', id: t.id }));
  }
  await sleep(1500);
  dws.close();
}
await ev(`document.getElementById('new-project').click()`);
await waitFor(`document.querySelector('#picker .ppath')?.value.endsWith('proyek-dari-ui')`);
await ev(`document.querySelector('#picker .drop').click()`);
{
  let gone = false;
  for (let i = 0; i < 50 && !gone; i++) {
    gone = !/proyek-dari-ui/.test(cfgText());
    if (!gone) await sleep(200);
  }
  check(gone, 'cleanup: the 8b project entry is out of config.toml again');
}

// --- 9. the last folder survives into the next session ----------------------
await ev(`document.querySelector('#picker .close').click()`);
const remembered = await ev(`localStorage.getItem('sh.picker.path')`);
check(remembered?.endsWith('proyek-dari-ui'), `the last folder is stored: ${remembered}`);

await ev(`location.reload()`);
await sleep(4500);
await ev(`document.getElementById('new-project').click()`);
check(
  await waitFor(`document.querySelector('#picker .ppath')?.value.endsWith('proyek-dari-ui')`),
  'after a reload the picker opens the last folder — rather than going back home',
);

// --- 10. Escape menutup --------------------------------------------------------
await ev(`document.getElementById('picker').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(300);
check(await ev(`document.getElementById('picker').hidden === true`), 'Escape closes the picker');

// --- done: clean up ------------------------------------------------------------
rmSync(SANDBOX, { recursive: true, force: true });
console.log('  (test folder removed)');

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
