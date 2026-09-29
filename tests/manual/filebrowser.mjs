// The file-finder modal (`filebrowser.js`): breadcrumb navigation, Places/
// Storage shortcuts, a sortable table with real image thumbnails, opened
// from the Explorer's tree header without disturbing the tree underneath.
// See FILE-EXPLORER-PLAN.md.

import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
// `SH_BIN` for a build elsewhere — the usual one is locked while dev.bat runs.
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\browsehome`;
const PROJ = `${SP}\\browseproj`;
const PORT = 7755;
const TOKEN = 'uji-browse';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/api/status?token=${TOKEN}`)).json();
  } catch {
    return null;
  }
};

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
// `browse::places()` checks for these under the daemon's own `--home`, not
// the real OS profile — a real Desktop must exist here for its coloured
// Places icon to actually be reachable in this sandboxed test.
mkdirSync(`${HOME}\\Desktop`, { recursive: true });
// Downloads, grouped by date: one file from just now, one from years back.
mkdirSync(`${HOME}\\Downloads`, { recursive: true });
writeFileSync(`${HOME}\\Downloads\\fresh.txt`, 'new\n');
writeFileSync(`${HOME}\\Downloads\\ancient.txt`, 'old\n');
utimesSync(`${HOME}\\Downloads\\ancient.txt`, new Date(2020, 0, 1), new Date(2020, 0, 1));
mkdirSync(`${PROJ}\\sub`, { recursive: true });
writeFileSync(`${PROJ}\\readme.txt`, 'hello world\n');
writeFileSync(`${PROJ}\\sub\\a.js`, 'console.log(1)\n');
// A real, minimal 1x1 PNG — enough for the browser to actually decode and
// draw as a thumbnail, not just a file with a `.png` name.
writeFileSync(
  `${PROJ}\\pic.png`,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);
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
for (let i = 0; i < 40 && !(await status()); i++) await sleep(500);
check(!!(await status()), `test daemon up on ${PORT}`);

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { cdp.onopen = r; });
let seq = 0;
const pending = new Map();
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cmd = (method, params = {}) => {
  const i = ++seq;
  cdp.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pending.set(i, r));
};
const ev = async (e) => {
  const r = await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception));
  return r.result?.result?.value;
};
const waitFor = async (expr, ms = 10000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(expr)) return true;
    await sleep(200);
  }
  return false;
};

await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5500);
await ev(`document.getElementById('backdrop')?.click()`);
await sleep(300);

// --- make browseproj the active project (open a terminal in it) -----------
// Without this the Explorer falls back to "the first project that exists",
// which on a real machine is whatever project was last worked in, not
// necessarily this scratch folder.
check(
  await waitFor(
    `[...document.querySelectorAll('#tree .row')].some(r => (r.dataset.path || '').toLowerCase().includes('browseproj'))`,
    10000,
  ),
  'the scratch project shows up in the sidebar',
);
await ev(`
  (() => {
    const row = [...document.querySelectorAll('#tree .row')]
      .find(r => (r.dataset.path || '').toLowerCase().includes('browseproj'));
    row.querySelector('.add').click();
  })()
`);
await sleep(500);
await ev(`
  [...document.querySelectorAll('#menu > div')]
    .find(x => /terminal/i.test(x.textContent)).click()
`);
await sleep(2500);
check(
  await waitFor(`document.querySelector('.frow.root .fname')?.textContent === 'browseproj'`, 8000),
  'the tree settles on browseproj as the active project before opening the finder',
);

// --- open the file-finder dialog ---------------------------------------------
check(await waitFor(`!!document.querySelector('.fbrowse')`, 8000), 'the tree header has the file-finder button');
await ev(`document.querySelector('.fbrowse').click()`);
check(await waitFor(`!document.getElementById('browser').hidden`, 5000), 'the dialog opens');
// The whole point: this is a separate overlay, not a mode the tree swaps
// into — the project the tree was showing must still be right there,
// untouched, the instant the dialog opens.
check(
  await ev(`!document.getElementById('files').hidden && document.querySelector('.frow.root .fname')?.textContent === 'browseproj'`),
  'the tree stays visible underneath, still showing browseproj',
);

// --- breadcrumb + entries for the project root ------------------------------
check(
  await waitFor(`document.querySelectorAll('.bseg').length > 0`, 5000),
  'breadcrumb has at least one segment',
);
check(
  await ev(`document.querySelector('.bseg.on')?.textContent === 'browseproj'`),
  'the dialog opens on the project folder by default',
);
// `.brow` (a real entry) not `.bshort` (a Places/Storage shortcut) — both
// carry `.fname`, this is what actually tells them apart.
const rootNames = await ev(`[...document.querySelectorAll('#browser .brow .fname')].map(e => e.textContent)`);
check(
  rootNames.includes('sub') && rootNames.includes('readme.txt') && rootNames.includes('pic.png'),
  `root lists all three entries (${rootNames})`,
);

// --- List is the default, and never fetches a single image -----------------
check(
  await ev(`document.querySelector('.bview[data-mode="list"]').classList.contains('on')`),
  'List is the active view mode by default',
);
check(
  await ev(`
    !([...document.querySelectorAll('#browser .brow')]
      .find(r => r.querySelector('.fname').textContent === 'pic.png')
      ?.querySelector('img.bthumb'))
  `),
  'in List mode the PNG gets a generic icon, no <img> is even created',
);

// --- Thumbnail mode: now a real thumbnail, in an icon grid ------------------
await ev(`document.querySelector('.bview[data-mode="thumbnail"]').click()`);
check(
  await ev(`document.querySelector('.bmain .frows').classList.contains('bgrid-thumbnail')`),
  'switching to Thumbnail swaps the table for an icon grid',
);
check(
  await waitFor(`
    !!([...document.querySelectorAll('#browser .btile')]
      .find(r => r.querySelector('.fname').textContent === 'pic.png')
      ?.querySelector('img.bthumb'))
  `, 5000),
  'the PNG gets a real <img> thumbnail instead of a generic icon',
);
const imgOk = `
  (() => {
    const img = [...document.querySelectorAll('#browser .btile')]
      .find(r => r.querySelector('.fname').textContent === 'pic.png')
      .querySelector('img.bthumb');
    return img.complete && img.naturalWidth > 0;
  })()
`;
check(await waitFor(imgOk, 3000), 'and that thumbnail actually decodes (not a broken image)');
// Back to List for the rest of this script, which relies on `.brow`/`.bcols`.
await ev(`document.querySelector('.bview[data-mode="list"]').click()`);
check(
  await ev(`document.querySelector('.bmain .frows').classList.contains('bgrid')`) === false,
  'switching back to List restores the detail table',
);

// --- Places/Storage sidebar sections ----------------------------------------
check(
  await ev(`[...document.querySelectorAll('.bsectitle')].some(e => e.textContent === 'Places')`),
  'the Places section appears',
);
check(
  await ev(`[...document.querySelectorAll('.bsectitle')].some(e => e.textContent === 'Storage')`),
  'the Storage section appears',
);
const homeShortcut = await ev(`
  [...document.querySelectorAll('.bshort .fname')].some(e => e.textContent === 'Home')
`);
check(homeShortcut, 'Home is offered as a Places shortcut');
// Desktop gets its own coloured folder icon, not the plain grey one Home uses.
const desktopIcon = await ev(`
  (() => {
    const row = [...document.querySelectorAll('.bshort')].find(r => r.querySelector('.fname')?.textContent === 'Desktop');
    return row?.querySelector('use')?.getAttribute('href');
  })()
`);
check(desktopIcon === '#shi-w-p-desktop', `Desktop uses its coloured icon (got ${desktopIcon})`);
const driveIcon = await ev(`
  [...document.querySelectorAll('.bsectitle')].find(t => t.textContent === 'Storage')
    ?.nextElementSibling?.querySelector('use')?.getAttribute('href')
`);
check(driveIcon === '#shi-w-drive', `a Storage entry uses the drive icon (got ${driveIcon})`);

// --- Downloads is grouped by date; other folders are not -------------------
check(await ev(`!document.querySelector('#browser .bgroup')`), 'an ordinary folder has no date groups');
await ev(`[...document.querySelectorAll('.bshort')].find(r => r.querySelector('.fname')?.textContent === 'Downloads').click()`);
const brNames = `[...document.querySelectorAll('#browser .brow .fname')].map(e => e.textContent)`;
check(await waitFor(`${brNames}.includes('fresh.txt')`, 5000), 'Downloads opens');
const groups = await ev(`[...document.querySelectorAll('#browser .bgroup')].map(g => g.dataset.group + (g.classList.contains('shut') ? ':shut' : ''))`);
check(groups?.join('|') === 'Today|A long time ago:shut', `grouped Today / A long time ago, the old one folded (${groups})`);
check(!(await ev(brNames)).includes('ancient.txt'), 'a folded group hides its files');
await ev(`document.querySelector('#browser .bgroup[data-group="A long time ago"]').click()`);
check((await ev(brNames)).includes('ancient.txt'), 'clicking its header unfolds it');
await ev(`document.querySelector('.bcol-name').click()`);
check(
  await ev(`!document.querySelector('#browser .bgroup') && ${brNames}.join() === 'ancient.txt,fresh.txt'`),
  'sorting by a column turns the grouping off',
);
await ev(`document.querySelector('.bback').click()`);
check(await waitFor(`${brNames}.includes('readme.txt')`, 5000), 'Back returns to the project');
// Put Name/ascending back as the rest of this script expects it.
await ev(`(() => { const a = document.querySelector('.bcol-name .bsortdir'); if (a?.textContent === '▼') document.querySelector('.bcol-name').click(); })()`);

// --- column header + sorting -------------------------------------------------
const headers = await ev(`[...document.querySelectorAll('.bcols .bcol')].map(e => e.textContent.replace(/[▲▼]/, ''))`);
check(
  headers.join(',') === 'Name,Type,Date Modified,Size',
  `all four sortable columns are present in order (${headers})`,
);
// Sort by Type: the file's extension groups it away from the alphabetical-by-
// name order, but folders must still sort above files either way.
await ev(`document.querySelector('.bcol-type').click()`);
const byType = await ev(`[...document.querySelectorAll('#browser .brow .fname')].map(e => e.textContent)`);
check(byType[0] === 'sub', `folders stay first even sorted by type (${byType})`);
// Clicking the same column again reverses direction.
await ev(`document.querySelector('.bcol-type').click()`);
check(await ev(`document.querySelector('.bcol-type .bsortdir').textContent === '▼'`), 'clicking the same column again reverses the sort arrow');
await ev(`document.querySelector('.bcol-name').click()`); // back to the default the rest of this test expects

// --- navigate into the subfolder ---------------------------------------------
await ev(`
  [...document.querySelectorAll('#browser .brow')].find(r => r.querySelector('.fname').textContent === 'sub').click()
`);
check(
  await waitFor(`document.querySelector('.bseg.on')?.textContent === 'sub'`, 5000),
  'breadcrumb updates to the subfolder after navigating in',
);
const subNames = await ev(`[...document.querySelectorAll('#browser .brow .fname')].map(e => e.textContent)`);
check(subNames.includes('a.js'), `subfolder lists its file (${subNames})`);
check(await ev(`!document.querySelector('.bup').disabled`), 'the Up button is enabled inside a subfolder');
const jsType = await ev(`
  [...document.querySelectorAll('#browser .brow')].find(r => r.querySelector('.fname').textContent === 'a.js')
    .querySelector('.bcol-type').textContent
`);
check(jsType === '.js', `the Type column shows the file's extension (${jsType})`);

// --- back navigation ----------------------------------------------------------
await ev(`document.querySelector('.bback').click()`);
check(
  await waitFor(`document.querySelector('.bseg.on')?.textContent === 'browseproj'`, 5000),
  'Back returns to the project root',
);
check(await ev(`document.querySelector('.bback').disabled`), 'Back is now disabled — nowhere further back');
check(!(await ev(`document.querySelector('.bfwd').disabled`)), 'Forward is enabled after going back');

// --- forward navigation --------------------------------------------------------
await ev(`document.querySelector('.bfwd').click()`);
check(
  await waitFor(`document.querySelector('.bseg.on')?.textContent === 'sub'`, 5000),
  'Forward replays the step back to the subfolder',
);

// --- breadcrumb click jumps straight back to root, not just one level up ------
await ev(`
  [...document.querySelectorAll('.bseg')].find(s => s.textContent === 'browseproj').click()
`);
check(
  await waitFor(`document.querySelector('.bseg.on')?.textContent === 'browseproj'`, 5000),
  'clicking an ancestor crumb jumps straight there',
);

// --- clicking a shortcut navigates there, same as a folder entry -----------
// The breadcrumb shows the real folder name once there (say "user"), not the
// sidebar's "Home" label — that label is only ever a shortcut's own name.
await ev(`[...document.querySelectorAll('.bshort .fname')].find(e => e.textContent === 'Home').click()`);
check(
  await waitFor(`document.querySelector('.bseg.on')?.textContent !== 'browseproj'`, 5000),
  'clicking the Home shortcut navigates away from browseproj',
);
check(
  await ev(`document.querySelector('.frow.root .fname')?.textContent === 'browseproj'`),
  'and the tree underneath still has not moved',
);

// --- Escape closes the dialog, tree untouched ------------------------------
// Dispatched at the dialog element itself, the way a real keypress while it
// has focus actually arrives — a listener on `document` would not be what
// this is testing.
await ev(`document.getElementById('browser').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
check(await waitFor(`document.getElementById('browser').hidden`, 3000), 'Escape closes the dialog');
check(
  await ev(`!document.getElementById('files').hidden && document.querySelector('.frow.root .fname')?.textContent === 'browseproj'`),
  'the tree was never touched by any of this',
);

// --- one click previews a file, beside the list, dialog stays open ----------
await ev(`document.querySelector('.fbrowse').click()`);
await sleep(500);
const rowOf = (name) =>
  `[...document.querySelectorAll('#browser .brow')].find(r => r.querySelector('.fname').textContent === '${name}')`;
await ev(`${rowOf('readme.txt')}.click()`);
check(
  await waitFor(`document.querySelector('#browser .bptext')?.textContent === 'hello world\\n'`, 5000),
  'one click on a text file shows its contents in the preview pane',
);
check(await ev(`!document.getElementById('browser').hidden`), 'and the dialog stays open');
check(await ev(`${rowOf('readme.txt')}.classList.contains('sel')`), 'the previewed row is highlighted');
check(
  await ev(`document.querySelector('#browser .bpname').textContent === 'readme.txt'`),
  'the pane names the file',
);
await ev(`${rowOf('pic.png')}.click()`);
check(
  await waitFor(`(() => { const i = document.querySelector('#browser .bpimg'); return i && i.complete && i.naturalWidth > 0; })()`, 5000),
  'an image previews as the picture itself',
);
check(await ev(`!${rowOf('readme.txt')}.classList.contains('sel')`), 'and the highlight moves with it');

// --- two clicks (or the pane's button) open it in the editor ----------------
await ev(`${rowOf('readme.txt')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
check(
  await waitFor(`document.querySelector('.ptabstrip')?.textContent.includes('readme.txt')`, 8000),
  'a double click opens the file in the editor tab strip',
);
check(await ev(`document.getElementById('browser').hidden`), 'and closes the dialog on the way, since that usually means "found it"');

// --- clicking the backdrop closes it, same as every other dialog here ------
await ev(`document.querySelector('.fbrowse').click()`);
await sleep(500);
// A plain `.click()` only fires `click`, not `mousedown` — the event this
// dialog (like every other one here) actually listens for, the same way a
// real mouse press on the backdrop would.
await ev(`document.getElementById('browser').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
check(await waitFor(`document.getElementById('browser').hidden`, 3000), 'clicking the backdrop closes the dialog');

// --- a folder can be opened as a project, handing over to New project -------
await ev(`document.querySelector('.fbrowse').click()`);
await waitFor(`[...document.querySelectorAll('#browser .brow .fname')].some(e => e.textContent === 'sub')`, 5000);
await ev(`
  (() => {
    const row = [...document.querySelectorAll('#browser .brow')].find(r => r.querySelector('.fname').textContent === 'sub');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 }));
  })()
`);
await sleep(300);
const menuLabels = await ev(`[...document.querySelectorAll('#menu > div')].map(x => x.textContent)`);
check(
  menuLabels?.includes('Copy path') && menuLabels?.includes('Open as project…'),
  `a folder's right-click menu offers Copy path and Open as project (${menuLabels})`,
);
await ev(`[...document.querySelectorAll('#menu > div')].find(x => x.textContent === 'Open as project…').click()`);
check(await waitFor(`document.getElementById('browser').hidden`, 3000), 'Open as project closes the file finder');
check(
  await waitFor(`!document.getElementById('picker').hidden && /[\\\\/]sub$/.test(document.querySelector('#picker .ppath').value)`, 5000),
  'and opens New project already on that folder',
);
await ev(`document.querySelector('#picker .close').click()`);

// The folder on screen itself, from the header button.
await ev(`document.querySelector('.fbrowse').click()`);
await waitFor(`!document.querySelector('#browser .bproj').disabled`, 5000);
const here = await ev(`document.querySelector('#browser .bseg.on')?.textContent`);
await ev(`document.querySelector('#browser .bproj').click()`);
check(
  await waitFor(`!document.getElementById('picker').hidden && document.querySelector('#picker .ppath').value.endsWith('${here}')`, 5000),
  `the header's Open here… does the same for the folder on screen (${here})`,
);
await ev(`document.querySelector('#picker .close').click()`);

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
await sleep(1500);
cdp.close();
process.exit(steps.every(Boolean) ? 0 : 1);
