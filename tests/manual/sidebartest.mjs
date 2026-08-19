// Test: sidebar fuzzy filter, collapse/expand all, bookmarks, and narrow layout.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const CDP = 'http://127.0.0.1:9222';
// Read from the config rather than hard-coded: the daemon's token changes, and
// a stale copy here fails as "cannot connect", which says nothing about what
// this test is actually checking.
const TOKEN = /token *= *"([^"]+)"/.exec(
  readFileSync(`${homedir()}/.sessionhub/config.toml`, 'utf8'),
)[1];
const URL = `http://127.0.0.1:7717/?token=${TOKEN}`;
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`${CDP}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
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
const ev = async (e) =>
  (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))
    .result?.result?.value;
const type = async (text) =>
  ev(`(() => { const i = document.getElementById('filter'); i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new Event('input')); return true; })()`);

await cmd('Emulation.setDeviceMetricsOverride', { width: 1360, height: 820, deviceScaleFactor: 1, mobile: false });
// Load the page before clearing the stored state: `localStorage` belongs to an
// origin, and the browser may still be sitting on the page the previous test
// left behind. Written there, the reset would silently do nothing here.
await ev(`location.href = '${URL}'`);
await sleep(5000);
await ev(`localStorage.removeItem('sh.bookmarks'); localStorage.removeItem('sh.collapsed'); localStorage.setItem('sh.sidebar.hidden','0')`);
await ev(`location.reload()`);
await sleep(5000);

const projects = await ev(`document.querySelectorAll('.project').length`);
check(projects > 10, `the sidebar is filled with ${projects} projects`);

// --- collapse / expand all ---------------------------------------------------
await ev(`document.getElementById('collapse-all').click()`);
await sleep(400);
check(await ev(`document.querySelectorAll('.session').length === 0`), 'collapse all hides every session');
check(await ev(`[...document.querySelectorAll('.twist')].every(t => t.textContent === '▸')`), 'every fold marker points to closed');
check(await ev(`document.querySelectorAll('.project').length === ${projects}`), 'the projects themselves stay visible');

await ev(`document.getElementById('expand-all').click()`);
await sleep(400);
check(await ev(`document.querySelectorAll('.session').length > 10`), 'expand all shows the sessions again');

await ev(`location.reload()`);
await sleep(4000);
check(await ev(`document.querySelectorAll('.session').length > 10`), 'the fold state survives a reload');

// --- the left arrow folds, the project name moves the focus -----------------
const first = await ev(`document.querySelector('.project .pname').textContent`);
const initialSessions = await ev(`document.querySelectorAll('.project')[0].querySelectorAll('.session').length`);
check(initialSessions > 0, `the first project ("${first}") is open with ${initialSessions} sessions`);

await ev(`document.querySelector('.project .row .pname').click()`);
await sleep(400);
check(
  (await ev(`document.querySelectorAll('.project')[0].querySelectorAll('.session').length`)) === initialSessions,
  'clicking the project name does NOT fold it',
);
check(
  await ev(`document.querySelector('.project .row').classList.contains('focused')`),
  'what happens instead: that project becomes the focus of the files panel',
);

await ev(`document.querySelector('.project .row .twist').click()`);
await sleep(400);
check(
  (await ev(`document.querySelectorAll('.project')[0].querySelectorAll('.session').length`)) === 0,
  'it is the left arrow that folds it',
);
check(
  await ev(`document.querySelector('.project .row .twist').textContent === '\u25b8'`),
  'the marker flips over with it',
);
await ev(`document.querySelector('.project .row .twist').click()`);
await sleep(400);
check(
  (await ev(`document.querySelectorAll('.project')[0].querySelectorAll('.session').length`)) === initialSessions,
  'and opens it again',
);

// --- filter ------------------------------------------------------------------
await type('term');
await sleep(400);
const names = await ev(`[...document.querySelectorAll('.pname')].map(n => n.textContent)`);
console.log(`    results for "term": ${names.join(', ')}`);
check(names.length > 0 && names.length <= 6, `"term" really does filter (${names.length} of ${projects})`);
// A project may appear because its name matches OR because some session title
// matches — but it must not appear without one of the two.
const justified = await ev(`
  [...document.querySelectorAll('.project')].every(p => {
    const nama = p.querySelector('.pname').textContent;
    const cocokNama = /t.*e.*r.*m/i.test(nama);
    const punyaSesi = p.querySelectorAll('.session').length > 0;
    const lewatFolder = !!p.querySelector('.pvia');
    return cocokNama || punyaSesi || lewatFolder;
  })
`);
check(justified, 'every project that appears has a reason: its name, its sessions, or its parent folder');
check(/^terminal-editor2$/.test(names[0]), `the best match comes first ("${names[0]}")`);

const target = await ev(`document.querySelectorAll('.pname')[2]?.textContent || document.querySelectorAll('.pname')[0].textContent`);
await type('');
await sleep(300);
const target2 = await ev(`document.querySelectorAll('.pname')[2].textContent`);
await type(target2.slice(0, 5));
await sleep(400);
const narrowed = await ev(`document.querySelectorAll('.project').length`);
check(narrowed > 0 && narrowed < projects, `typing filters the projects (${projects} -> ${narrowed})`);
check(await ev(`document.querySelectorAll('.pname b').length > 0`), 'the matching letters are set in bold');
check(
  await ev(`[...document.querySelectorAll('.pname')].some(n => n.textContent === ${JSON.stringify(target2)})`),
  `the project being looked for is among the results ("${target2}")`
);

// A query that only matches a session title must open that project by itself.
const someTitle = await ev(`document.querySelectorAll('.stitle')[0]?.textContent || ''`);
await type('zzqqxx');
await sleep(400);
check(await ev(`document.querySelector('.empty-hint')?.textContent === 'No matches.'`), 'a query with no results says so plainly');

await type(someTitle.slice(0, 12).replace('…', ''));
await sleep(400);
check(await ev(`document.querySelectorAll('.session').length > 0`), 'a session-title query brings up that session');
check(await ev(`document.querySelectorAll('.stitle b').length > 0`), 'the letters in the session title are marked as well');

await ev(`
  (() => { const i = document.getElementById('filter'); i.focus();
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()
`);
await sleep(400);
check(await ev(`document.getElementById('filter').value === ''`), 'Escape empties the search box');
check(await ev(`document.querySelectorAll('.project').length === ${projects}`), 'the full list comes back once the box is emptied');

// --- search by parent folder, even though the path is never displayed -------
await type('');
await sleep(400);

// Take a project whose parent folder is distinctive — not a folder that almost
// every project uses, because such a one really does not filter anything.
const wanted = await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.project > .row')];
    const paths = rows.map(r => r.dataset.path);
    const segs = (x) => x.split(/[\\\\/]/).filter(Boolean);
    const hitung = new Map();
    for (const x of paths) for (const g of new Set(segs(x).slice(0, -1).map(v => v.toLowerCase()))) {
      hitung.set(g, (hitung.get(g) || 0) + 1);
    }
    for (const x of paths) {
      const bagian = segs(x);
      const induk = bagian[bagian.length - 2];
      const nama = bagian[bagian.length - 1];
      if (!induk || induk.length < 4) continue;
      // It must be distinctive: used by only one or two projects, and not part of
      // the project name itself (if it were, name matching would win).
      if (hitung.get(induk.toLowerCase()) > 2) continue;
      if (nama.toLowerCase().includes(induk.toLowerCase())) continue;
      return { induk, nama, path: x };
    }
    return null;
  })()
`);

if (!wanted) {
  console.log('    (no parent folder on this machine is distinctive enough; step skipped)');
} else {
  console.log(`    searching for parent folder "${wanted.induk}" (project "${wanted.nama}")`);
  await type(wanted.induk);
  await sleep(500);
  const results = await ev(`
    [...document.querySelectorAll('.project')].map(p => ({
      nama: p.querySelector('.pname').textContent,
      via: p.querySelector('.pvia')?.textContent || null,
    }))
  `);
  const found = results.find((h) => h.nama === wanted.nama);
  check(!!found, `typing the parent folder name brings up the project inside it ("${wanted.nama}")`);
  check(
    found?.via?.toLowerCase() === wanted.induk.toLowerCase(),
    `the row names the folder that made it appear ("${found?.via}")`,
  );
  check(
    results.length < projects,
    `and it still filters rather than bringing up everything (${results.length} of ${projects})`,
  );

  // A query that is in no name and no path stays empty.
  await type('zzqqxxfolder');
  await sleep(400);
  check(
    await ev(`document.querySelector('.empty-hint')?.textContent === 'No matches.'`),
    'a query matching neither name nor path still yields nothing',
  );
}
await type('');
await sleep(400);

// --- bookmark ----------------------------------------------------------------
const nameToMark = await ev(`document.querySelectorAll('.pname')[3].textContent`);
check(
  await ev(`[...document.querySelectorAll('.zlabel')].filter(g => g.firstChild.textContent === 'focused').length === 0`),
  'without a bookmark there is no focused group',
);
await ev(`document.querySelectorAll('.project')[3].querySelector('.star').click()`);
await sleep(500);

const labels = await ev(`[...document.querySelectorAll('.zlabel')].map(g => g.firstChild.textContent)`);
check(
  JSON.stringify(labels.filter((l) => l === 'focused' || l === 'all projects'))
    === '["focused","all projects"]',
  `two groups appear: ${JSON.stringify(labels)}`,
);
check(
  await ev(`document.querySelectorAll('.pname')[0].textContent === ${JSON.stringify(nameToMark)}`),
  `the bookmarked project rises to the top ("${nameToMark}")`
);
check(await ev(`document.querySelectorAll('.star.on').length === 1`), 'the marker lights up and stays visible');

const shape = await ev(`
  (() => {
    const on = document.querySelector('.star.on svg path');
    const off = [...document.querySelectorAll('.star:not(.on) svg path')][0];
    return {
      adaSvg: !!on && !!off,
      // A bookmarked one is filled in; one that is not is only an outline.
      onFill: on?.getAttribute('fill'),
      offFill: off?.getAttribute('fill'),
      // The peak of the ribbon is at the bottom centre — that is what tells a
      // bookmark apart from a star or a flag.
      pita: /11\\.1/.test(on?.getAttribute('d') || ''),
    };
  })()
`);
check(shape.adaSvg, 'the marker is drawn as an SVG, not a text glyph that changes between fonts');
check(shape.pita, 'its shape is a bookmark ribbon (notched underneath), not a star');
check(shape.onFill === null && shape.offFill === 'none', 'a bookmarked one is filled, one that is not is only an outline');

await ev(`location.reload()`);
await sleep(4000);
check(
  await ev(`document.querySelectorAll('.pname')[0].textContent === ${JSON.stringify(nameToMark)}`),
  'the bookmark survives a reload'
);

// A second bookmark so that the group really is a group.
await ev(`[...document.querySelectorAll('.project')].find(p => !p.querySelector('.star.on')).querySelector('.star').click()`);
await sleep(400);
check(await ev(`document.querySelectorAll('.star.on').length === 2`), 'more than one project can be bookmarked');

await ev(`document.querySelectorAll('.star.on')[0].click()`);
await ev(`document.querySelectorAll('.star.on')[0].click()`);
await sleep(400);
check(
  await ev(`[...document.querySelectorAll('.zlabel')].every(g => g.firstChild.textContent !== 'focused')`),
  'removing every bookmark brings the flat list back',
);

// --- narrow screen ------------------------------------------------------------
await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await ev(`localStorage.removeItem('sh.sidebar.hidden')`);
await ev(`location.reload()`);
await sleep(4500);

check(await ev(`getComputedStyle(document.getElementById('menu-btn')).display !== 'none'`), 'the ☰ button appears on a narrow screen');
// Landing with no session attached, the drawer opens ITSELF — that is the
// asked-for behaviour (an empty stage with the session list shut was a dead
// end on a phone). "The terminal shows first" only holds once something is
// attached, which this reload starts without.
check(await ev(`document.getElementById('sidebar').hidden === false`), 'with nothing attached, the drawer opens by itself');
check(await ev(`getComputedStyle(document.getElementById('splitter')).display === 'none'`), 'the drag splitter is hidden on touch');
check(await ev(`getComputedStyle(document.getElementById('sidebar')).position === 'fixed'`), 'the drawer lies over the screen rather than splitting its width');
check(await ev(`document.getElementById('backdrop').hidden === false`), 'the dimming backdrop comes with it');
// Close it, then prove ☰ is the way back in.
await ev(`document.getElementById('backdrop').click()`);
await sleep(500);
check(await ev(`document.getElementById('sidebar').hidden === true`), 'touching the backdrop closes it — the stage is the terminal again');
await ev(`document.getElementById('menu-btn').click()`);
await sleep(600);
check(await ev(`document.getElementById('sidebar').hidden === false`), '☰ opens the project drawer');
const w = await ev(`document.getElementById('sidebar').getBoundingClientRect().width`);
check(w <= 390 * 0.86 + 1, `the drawer width follows the screen (${Math.round(w)}px of 390px)`);
check(
  (await ev(`getComputedStyle(document.getElementById('filter')).fontSize`)) === '16px',
  'the search box is 16px so that iOS does not zoom the page'
);

await ev(`document.getElementById('backdrop').click()`);
await sleep(500);
check(await ev(`document.getElementById('sidebar').hidden === true`), 'touching the backdrop closes the drawer');

await ev(`document.getElementById('menu-btn').click()`);
await sleep(500);
await ev(`document.querySelector('.session')?.click()`);
await sleep(2500);
check(await ev(`document.getElementById('sidebar').hidden === true`), 'picking a session closes the drawer so that the terminal is visible');

const overflow = await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
check(overflow, 'there is no sideways scrolling at phone width');

// This test ends in a phone viewport with the drawer closed. Both are global:
// left that way, the next test measures a layout that is not its own.
await cmd('Emulation.clearDeviceMetricsOverride');
await ev(`localStorage.setItem('sh.sidebar.hidden','0')`);
await ev(`
  (() => {
    const s = document.getElementById('sidebar');
    if (s && s.hidden) document.getElementById('menu-btn')?.click();
  })()
`);
await sleep(500);

ws.close();
const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
