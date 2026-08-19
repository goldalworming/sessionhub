// The files panel from the browser side: a virtual tree, icons, and a Monaco
// that is only loaded when the first file is opened.
// Needs Chrome with --remote-debugging-port=9222 and the test daemon on 7719.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const PORT = 7719;
const HOME =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome';
const CFG = join(HOME, '.sessionhub', 'config.toml');
const BOX = join(HOME, 'uibox');
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Test folder: one dense folder to prove that its virtualisation works.
rmSync(BOX, { recursive: true, force: true });
mkdirSync(join(BOX, 'src'), { recursive: true });
mkdirSync(join(BOX, 'banyak'), { recursive: true });
writeFileSync(join(BOX, 'main.rs'), 'fn main() {\n    let x = 1;\n}\n');
writeFileSync(join(BOX, 'notes.md'), '# catatan\n');
writeFileSync(join(BOX, 'data.sql'), 'select 1;\n');
writeFileSync(join(BOX, 'app.js'), 'console.log(1)\n');
writeFileSync(join(BOX, 'src', 'lib.rs'), 'pub fn y() {}\n');
// A genuinely valid 4x2 PNG, assembled here together with its CRC. Base64 that
// is typed by hand is easy to corrupt silently, and Chrome rejects it without a
// word — that would look like an app bug when it is the fixture that is wrong.
writeFileSync(join(BOX, 'logo.png'), makePng(4, 2));

function makePng(w, h) {
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  // Every row starts with one filter byte, then 3 bytes per pixel.
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) row.writeUInt8((x * 60) % 256, 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
for (let i = 0; i < 2000; i++) {
  writeFileSync(join(BOX, 'banyak', `f${String(i).padStart(4, '0')}.txt`), 'x');
}

// Register it as a project so that it shows up as a root of the tree.
{
  const ws0 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise((r) => { ws0.onopen = r; });
  ws0.send(JSON.stringify({ t: 'add_project', path: BOX }));
  await sleep(2500);
  ws0.close();
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
    await sleep(150);
  }
  return false;
};

await cmd('Network.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 840, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.setItem('sh.theme','light'); localStorage.setItem('sh.sidebar.hidden','0');
          localStorage.removeItem('sh.files.open')`);
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(3000);
if (!(await waitFor(`document.querySelectorAll('#tree .row').length > 0`))) {
  console.log('  [ABORT] the page is not connected');
  process.exit(2);
}

// --- 1. Monaco is not downloaded before a file is opened --------------------
const monacoLoaded = () =>
  ev(`performance.getEntriesByType('resource').filter(r => r.name.includes('/vendor/monaco/')).length`);
check((await monacoLoaded()) === 0, 'before any file is opened, not one byte of Monaco is downloaded');
check(await ev(`typeof window.monaco === 'undefined'`), 'and the editor really is not on the page yet');

// --- 2. open the panel -------------------------------------------------------
check(await ev(`!!document.getElementById('files-btn')`), 'the Files button is in the top bar');
await ev(`document.getElementById('files-btn').click()`);
check(await waitFor(`document.getElementById('side').hidden === false`), 'the panel opens on the right-hand side');
check(
  await ev(`document.getElementById('side').getBoundingClientRect().left > document.getElementById('stage').getBoundingClientRect().left`),
  'it really sits to the right of the terminal, not on top of it',
);
check(await waitFor(`document.querySelectorAll('#files .frow').length > 0`), 'the root of the tree is filled from the project list');

// --- 2b. only ONE project is shown ------------------------------------------
const all = await ev(`document.querySelectorAll('#tree .project:not(.gone)').length`);
const roots = await ev(`[...document.querySelectorAll('#files .frow.root')].map(r => r.querySelector('.fname').textContent)`);
check(all > 1, `the sidebar really does have several projects that still exist (${all})`);
check(roots.length === 1, `the explorer shows only one root: ${roots.join(', ')}`);
check(await ev(`document.querySelector('#files .ftitle').textContent === 'Explorer'`), 'its title is EXPLORER');
check(await ev(`!!document.querySelector('#files .fpick')`), 'there is a project picker in its title');

// Switch project through the picker.
await ev(`document.querySelector('#files .fpick').click()`);
await sleep(300);
const menu = await ev(`[...document.querySelectorAll('#files .fmitem')].map(m => m.textContent)`);
check(
  menu.length === all,
  `the picker lists the projects whose directory still exists (${menu.length} of ${all})`,
);
check(menu.includes('uibox'), 'including the test project');
await ev(`[...document.querySelectorAll('#files .fmitem')].find(m => m.textContent === 'uibox').click()`);
await sleep(600);
check(
  await waitFor(`document.querySelector('#files .frow.root .fname')?.textContent === 'uibox'`),
  'picking a project swaps what the explorer shows',
);
check(await ev(`document.querySelector('#files .fmenu').hidden === true`), 'the menu closes itself once a choice is made');

// --- 2c. clicking a project name in the sidebar moves the Explorer ----------
const clickProject = (name) => `
  (() => {
    const r = [...document.querySelectorAll('#tree .project .row')]
      .find(x => x.querySelector('.pname')?.textContent === ${JSON.stringify(name)});
    if (r) r.click();
    return !!r;
  })()`;
const other = await ev(`
  [...document.querySelectorAll('#tree .project:not(.gone) .pname')]
    .map(x => x.textContent).find(n => n !== 'uibox')
`);
check(await ev(clickProject(other)), `clicking another project name in the sidebar ("${other}")`);
check(
  await waitFor(`document.querySelector('#files .frow.root .fname')?.textContent === ${JSON.stringify(other)}`),
  'the Explorer moves along to that project',
);
check(
  await ev(`
    [...document.querySelectorAll('#tree .project .row')]
      .find(x => x.querySelector('.pname')?.textContent === ${JSON.stringify(other)})
      ?.classList.contains('focused')
  `),
  'its row is marked as the one that has focus',
);
check(await ev(clickProject('uibox')), 'back to the test project');
check(
  await waitFor(`document.querySelector('#files .frow.root .fname')?.textContent === 'uibox'`),
  'the Explorer comes back too',
);

// --- 3. open the test folder -------------------------------------------------
// The tree is virtual: rows outside the viewport really are not in the DOM, so
// finding one means scrolling first — exactly like a user does.
const clickRow = (name) => `
  (() => {
    const wanted = ${JSON.stringify(name)};
    const s = document.querySelector('#files .fscroll');
    const hit = () => [...document.querySelectorAll('#files .frow')]
      .find(x => x.querySelector('.fname')?.textContent === wanted);
    for (let top = 0; ; top += s.clientHeight / 2) {
      const r = hit();
      if (r) { r.click(); return true; }
      if (top > s.scrollHeight) return false;
      s.scrollTop = top;
      s.dispatchEvent(new Event('scroll'));
    }
  })()`;
check(
  await waitFor(`document.querySelectorAll('#files .frow').length > 3`),
  'the project contents load straight away — the root opens itself, with no wasted click',
);

const entries = await ev(`
  [...document.querySelectorAll('#files .frow')].map(r => ({
    nama: r.querySelector('.fname').textContent,
    ikon: r.querySelector('use')?.getAttribute('href') || '',
    twist: r.querySelector('.ftwist').textContent,
  }))
`);
const names = entries.map((e) => e.nama);
check(
  names.indexOf('banyak') < names.indexOf('app.js'),
  `folders above files: ${names.slice(0, 8).join(', ')}`,
);
check(entries.find((e) => e.nama === 'app.js')?.ikon === '#shi-js', 'the .js icon is recognised');
check(entries.find((e) => e.nama === 'data.sql')?.ikon === '#shi-sql', 'the .sql icon is recognised');
check(entries.find((e) => e.nama === 'notes.md')?.ikon === '#shi-md', 'the .md icon is recognised');
check(entries.find((e) => e.nama === 'main.rs')?.ikon === '#shi-rs', 'the .rs icon is recognised');
check(entries.find((e) => e.nama === 'src')?.ikon === '#shi-folder', 'a closed folder has an icon of its own');
check(entries.find((e) => e.nama === 'uibox')?.twist === '▾', 'the open/close marker changes along with it');
check(
  !names.some((n) => ['notex', 'terminal-editor2', 'app-absensi-sv5'].includes(n)),
  'other projects do not show up in the tree as well',
);
check(
  await ev(`document.querySelectorAll('#sh-file-icons symbol').length > 10`),
  'the icons are one sprite injected once, not an SVG per row',
);

// --- 4. lazy: a subfolder is only requested once it is opened ---------------
check(!names.includes('lib.rs'), 'the subfolder contents are not loaded along with it — only what is opened');
await ev(clickRow('src'));
check(await waitFor(`[...document.querySelectorAll('#files .fname')].some(n => n.textContent === 'lib.rs')`),
  'opening a subfolder loads its contents right then and there');

// --- 5. virtualisation: 2000 entries do not become 2000 elements ------------
await ev(clickRow('banyak'));
check(await waitFor(`[...document.querySelectorAll('#files .fname')].some(n => n.textContent === 'f0000.txt')`),
  'the folder holding 2000 files loads');
const dom = await ev(`document.querySelectorAll('#files .frow').length`);
check(dom < 100, `only ${dom} rows become DOM elements, not 2000`);

const scrolled = await ev(`
  (() => {
    const s = document.querySelector('#files .fscroll');
    s.scrollTop = 12000;
    return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r({
      rows: document.querySelectorAll('#files .frow').length,
      first: document.querySelector('#files .frow .fname')?.textContent || '',
    }))));
  })()
`);
check(scrolled.rows < 100, `even after scrolling far it stays at ${scrolled.rows} elements`);
check(/^f0\d\d\d\.txt$/.test(scrolled.first), `the rows really do change while scrolling (starting from ${scrolled.first})`);
await ev(`document.querySelector('#files .fscroll').scrollTop = 0`);
await ev(clickRow('banyak')); // close it again
await sleep(300);

// --- 6. open a file: only now is Monaco downloaded --------------------------
check((await monacoLoaded()) === 0, 'up to this point Monaco has still not been downloaded at all');
const t0 = Date.now();
check(await ev(clickRow('main.rs')), 'the file row is clicked');
check(await waitFor(`!!document.querySelector('#editor .monaco-editor')`, 30000),
  `the editor is drawn (${((Date.now() - t0) / 1000).toFixed(1)}s since the click)`);
check((await monacoLoaded()) > 0, 'and only then is Monaco downloaded — not when the page is opened');

const editorFile = await ev(`
  (() => {
    const m = window.monaco.editor.getModels().find(x => x.getValue().includes('fn main'));
    return { teks: m?.getValue() || '', bahasa: m?.getLanguageId() || '' };
  })()
`);
check(editorFile.teks.startsWith('fn main()'), 'the file contents are correct');
check(editorFile.bahasa === 'rust', `the language is guessed from the extension: ${editorFile.bahasa}`);
check(
  await ev(`[...document.querySelectorAll('.ptab')].map(t => t.querySelector('.ptname').textContent).join('|')`)
    === 'main.rs',
  'the tab bar holds only the files that are open — the Explorer is not a tab',
);
check(await ev(`document.querySelector('.ptab.on .ptname').textContent === 'main.rs'`), 'the file tab is active straight away');
check(
  await ev(`document.querySelector('#editor .ecrumb').textContent === 'main.rs'`),
  'the breadcrumb is shown relative to the project, not as a full path',
);
check(await ev(`document.getElementById('files').hidden === false`), 'the Explorer stays visible beside the editor');
check(
  await ev(`
    document.querySelector('#editor').getBoundingClientRect().left >
    document.getElementById('files').getBoundingClientRect().right - 2
  `),
  'the editor sits to the right of the Explorer, not below it',
);
check(
  await ev(`document.querySelector('#editor .ebody').getBoundingClientRect().height > 300`),
  'the editor gets the full height of its column',
);

// The heavy language services really are not shipped along.
const heavy = await ev(`
  performance.getEntriesByType('resource')
    .filter(r => r.name.includes('/vendor/monaco/vs/language/')).length
`);
check(heavy === 0, 'no file from vs/language/ is requested — the TypeScript worker really is not shipped');

// --- 7. edit and then save ---------------------------------------------------
await ev(`
  (() => {
    const m = window.monaco.editor.getModels().find(x => x.getValue().includes('fn main'));
    m.setValue('fn main() { /* dari ui */ }\\n');
  })()
`);
await sleep(300);
check(await ev(`document.querySelector('.ptab.on .ptname').classList.contains('dirty')`),
  'an unsaved change is marked on its tab');
check(await ev(`document.querySelector('#editor .enote').textContent.includes('unsaved')`),
  'and mentioned in the editor bar as well');
await ev(`document.querySelector('#editor .esave').click()`);
await sleep(1500);
check(
  readFileSync(join(BOX, 'main.rs'), 'utf8').includes('dari ui'),
  'Save writes to the real disk',
);
check(!(await ev(`document.querySelector('.ptab.on .ptname').classList.contains('dirty')`)),
  'the unsaved marker disappears once it succeeds');

// --- 8. a second tab, switching, and closing --------------------------------
check(await ev(clickRow('notes.md')), 'open a second file');
check(await waitFor(`[...document.querySelectorAll('.ptab .ptname')].length === 2`), 'a tab is added rather than replaced');
check(
  await ev(`[...document.querySelectorAll('.ptab .ptname')].map(t => t.textContent).join('|')`)
    === 'main.rs|notes.md',
  'the tab order follows the order they were opened in',
);
check(
  await ev(`window.monaco.editor.getModels().length >= 2`),
  'the model of each file is kept, so switching tabs does not reload',
);

// Going back to the first tab must restore its contents, not the last file opened.
await ev(`[...document.querySelectorAll('.ptab')].find(t => t.querySelector('.ptname').textContent === 'main.rs').click()`);
await sleep(500);
check(
  await ev(`window.monaco.editor.getEditors()[0].getModel().getValue().includes('dari ui')`),
  'switching tabs shows the right file contents',
);

await ev(`[...document.querySelectorAll('.ptab')].find(t => t.querySelector('.ptname').textContent === 'notes.md').querySelector('.ptx').click()`);
await sleep(400);
check(
  await ev(`[...document.querySelectorAll('.ptab .ptname')].map(t => t.textContent).join('|')`) === 'main.rs',
  'the ✕ button closes just that one tab',
);

// The breadcrumb for a file that sits deeper.
check(await ev(clickRow('lib.rs')), 'open a file inside a subfolder');
check(
  await waitFor(`document.querySelector('#editor .ecrumb')?.textContent === 'src › lib.rs'`),
  `the breadcrumb names its folder: "${await ev(`document.querySelector('#editor .ecrumb')?.textContent`)}"`,
);
await ev(`[...document.querySelectorAll('.ptab')].find(t => t.querySelector('.ptname').textContent === 'lib.rs')?.querySelector('.ptx').click()`);
await sleep(400);

// --- 9. the editor theme is separate from the app theme ---------------------
const theme2 = await ev(`
  (() => {
    const b = document.querySelector('#editor .etheme');
    return { teks: b.textContent, gelap: document.getElementById('editor').classList.contains('dark') };
  })()
`);
check(theme2.teks === 'dark', `the default is dark even though the app is light ("${theme2.teks}")`);
check(theme2.gelap, 'and the editor really is drawn dark');
check(
  await ev(`document.querySelector('.monaco-editor').classList.contains('vs-dark')`),
  'Monaco itself uses the vs-dark theme',
);

await ev(`document.querySelector('#editor .etheme').click()`);
await sleep(300);
check(await ev(`document.querySelector('#editor .etheme').textContent === 'light'`), 'one click makes it light');
check(await ev(`document.querySelector('.monaco-editor').classList.contains('vs-dark') === false`), 'the theme really does change');
await ev(`document.querySelector('#editor .etheme').click()`);
await sleep(300);
check(await ev(`document.querySelector('#editor .etheme').textContent === 'auto'`), 'another click makes it auto (following the app)');
check(await ev(`localStorage.getItem('sh.editor.theme') === 'auto'`), 'the choice is stored');
await ev(`document.querySelector('#editor .etheme').click()`);
await sleep(300);
check(await ev(`document.querySelector('#editor .etheme').textContent === 'dark'`), 'it cycles back round to dark');

// --- 9b. an image is shown, not called a "binary file" -----------------------
check(await ev(clickRow('logo.png')), 'open an image file');
const visible = await waitFor(`document.querySelector('#editor .eimg')?.hidden === false`);
if (!visible) {
  console.log('    diagnosis:', await ev(`
    JSON.stringify({
      eplace: document.querySelector('#editor .eplace')?.textContent,
      hidden: document.querySelector('#editor .eimg')?.hidden,
      src: document.querySelector('#editor .eimg img')?.getAttribute('src'),
      tab: document.querySelector('.ptab.on .ptname')?.textContent,
    })
  `));
}
check(visible, 'the image is displayed');
check(await ev(`document.querySelector('#editor .ebody').hidden === true`), 'the code editor is hidden for an image');
check(
  !(await ev(`document.querySelector('#editor .eplace').textContent.includes('binary')`)),
  'it no longer just says "is a binary file"',
);

const img = await ev(`
  (() => {
    const i = document.querySelector('#editor .eimg img');
    return new Promise(r => {
      const done = () => r({
        src: i.getAttribute('src'),
        w: i.naturalWidth, h: i.naturalHeight,
        lebar: i.getBoundingClientRect().width,
      });
      // Do not hang if the image fails to load: just report what there is.
      setTimeout(done, 5000);
      if (i.complete) done();
      else {
        i.addEventListener('load', done, { once: true });
        i.addEventListener('error', done, { once: true });
      }
    });
  })()
`);
check(img.w === 4 && img.h === 2, `the image really is drawn (${img.w}x${img.h} pixels)`);
check(img.src.startsWith('/api/file?path='), `fetched over an HTTP route: ${img.src.slice(0, 24)}`);
check(!img.src.includes('base64'), 'not base64 pasted into the JSON');
check(img.lebar <= 4, 'a tiny image is not stretched to the full width of the panel');
await waitFor(`document.querySelector('#editor .enote').textContent.includes('4')`);
const note = await ev(`document.querySelector('#editor .enote').textContent`);
check(note.includes('4') && note.includes('2'), `its pixel size is mentioned: "${note}"`);
check(await ev(`document.querySelector('#editor .esave').disabled === true`), 'Save is disabled for an image');
check(
  await ev(`document.querySelector('.ptab.on use').getAttribute('href') === '#shi-img'`),
  'the tab uses the image icon',
);

// --- 9c. closing the last tab, and the remembered column width --------------
const initialWidth = await ev(`document.getElementById('files').getBoundingClientRect().width`);
check(initialWidth > 100, `the Explorer has a width of its own (${Math.round(initialWidth)}px)`);
check(await ev(`!!document.querySelector('#side .psplit')`), 'there is a drag divider between the Explorer and the editor');

await ev(`
  [...document.querySelectorAll('.ptab .ptx')].forEach(x => x.click());
`);
await sleep(500);
check(await ev(`document.querySelectorAll('.ptab').length === 0`), 'every tab can be closed');
check(await ev(`document.querySelector('#side .pnone').hidden === false`), 'the editor is empty but with guidance, not a blank screen');
check(await ev(`document.getElementById('files').hidden === false`), 'and the Explorer is still there — it is not a tab');

// --- 10. the panel is remembered ---------------------------------------------
check(await ev(`localStorage.getItem('sh.files.open') === '1'`), 'the open panel is stored');
await ev(`location.reload()`);
await sleep(4000);
check(await waitFor(`document.getElementById('side').hidden === false`), 'after a reload the panel is open again');
check((await monacoLoaded()) === 0, 'and Monaco is still not downloaded along when the page is opened');

await ev(`document.getElementById('files-btn').click()`);
await sleep(300);
check(await ev(`document.getElementById('side').hidden === true`), 'the same button closes it again');

// --- done ---------------------------------------------------------------------
{
  const ws1 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise((r) => { ws1.onopen = r; });
  ws1.send(JSON.stringify({ t: 'remove_project', path: BOX }));
  await sleep(1200);
  ws1.close();
}
rmSync(BOX, { recursive: true, force: true });

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
