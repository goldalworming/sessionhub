// A sidebar laid out by time — run against the real daemon on 7717, because
// what is under test is precisely its shape on real data: dozens of sessions
// with the same title inside one project.
//
// Needs Chrome with --remote-debugging-port=9222.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PORT = 7717;
const TOKEN = /token *= *"([^"]+)"/.exec(
  readFileSync(join(homedir(), '.sessionhub', 'config.toml'), 'utf8'),
)[1];

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// One live terminal, set up by ourselves.
///
/// The top zone is precisely about what is alive right now, so leaning on a
/// terminal that happens to be left over from everyday use makes the test pass
/// or fail according to something entirely unrelated.
async function spawnOne() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise((r) => { ws.onopen = r; });
  const first = await new Promise((res) => {
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data);
      if (m.t === 'state') res(m);
    };
  });
  const alive = first.terminals.filter((t) => t.alive);
  if (alive.length) { ws.close(); return null; }

  const project = first.projects.find((p) => p.exists)?.path;
  if (!project) { ws.close(); return null; }
  const id = await new Promise((res) => {
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data);
      if (m.t === 'attached') res(m.id);
    };
    ws.send(JSON.stringify({
      t: 'spawn', project, agent: 'terminal', resume: null, cols: 80, rows: 24,
    }));
  });
  await sleep(1200);
  ws.close();
  return id;
}

const spawned = await spawnOne();

const tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = tabs.find((x) => x.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const pend = new Map();
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description || 'exception');
  }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const cmd = (m, p = {}) => {
  const i = ++seq;
  ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((r) => pend.set(i, r));
};
// An evaluate that triggers navigation is sometimes never answered — the
// context is thrown away before the reply can be sent. Without a timeout, one
// lost reply leaves the whole test hanging without a single line printed.
const cmdT = (m, p = {}, ms = 15000) =>
  Promise.race([cmd(m, p), new Promise((r) => setTimeout(() => r(null), ms))]);
const ev = async (e) =>
  (await cmdT('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))
    ?.result?.result?.value;

/// Move pages through Page.navigate rather than by setting `location.href`
/// from inside the page: this one has its own reply that really is sent.
const goto = (path) =>
  cmdT('Page.navigate', { url: `http://127.0.0.1:${PORT}${path}` });
const waitFor = async (expr, ms = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev(expr)) return true;
    await sleep(250);
  }
  return false;
};

await cmd('Runtime.enable');
await cmd('Page.enable');
await cmd('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 860, deviceScaleFactor: 1, mobile: false,
});

// --- 1. the page stands on its own ------------------------------------------
// Folds and aliases are cleared by way of about:blank and then loaded again:
// the sidebar module reads localStorage once as it loads and writes it back, so
// clearing it from a page that has the module loaded can undo itself.
await goto(`/?token=${TOKEN}`);
await waitFor(`!!document.getElementById('tree')`, 20000);
await ev(`localStorage.setItem('sh.theme','dark');
          localStorage.removeItem('sh.buckets');
          localStorage.removeItem('sh.alias')`);
await cmdT('Page.navigate', { url: 'about:blank' });
await sleep(500);
await goto('/');
check(await waitFor(`!!document.querySelector('#tree .zlabel')`, 20000), 'the sidebar is drawn');
check(errors.length === 0, `no exception while loading${errors.length ? ': ' + errors[0].slice(0, 90) : ''}`);

// --- 2. the top zone ---------------------------------------------------------
const zone = await ev(`
  (() => {
    const labels = [...document.querySelectorAll('#tree .zlabel')].map(l => l.firstChild.textContent);
    const rows = document.querySelectorAll('#tree .zrow').length;
    return JSON.stringify({ labels, rows });
  })()
`).then(JSON.parse);
check(zone.labels[0] === 'live & today', `the first zone is time: ${zone.labels[0]}`);
check(zone.labels.includes('projects'), 'the second zone is the project list');
check(zone.rows > 0 && zone.rows <= 8, `the top zone is bounded, it does not turn into a second list (${zone.rows} rows)`);
check(
  await ev(`!!document.querySelector('#tree .zrow .dot.live')`),
  'a live terminal appears in the top zone',
);
check(
  await ev(`(document.querySelector('#tree .zrow .zmeta')?.textContent || '').includes('·')`),
  'every zone row names its project and its agent',
);

// --- 3. absolute dates, not a countdown --------------------------------------
const dates = await ev(`
  JSON.stringify([...document.querySelectorAll('#tree .when')].slice(0, 40).map(n => n.textContent))
`).then(JSON.parse);
check(dates.length > 0, `the time column is filled (${dates.length} rows)`);
// Single backslashes: these are Node-side regex literals, and `\\d` in one
// matches a literal backslash, never a digit. Both checks carried that flaw —
// the first passed vacuously, the second stayed green only while a `new` or
// `yesterday` row happened to be present to satisfy the string branches, and
// failed the first day the sidebar held nothing but clock times.
check(
  !dates.some((d) => /\d+[dhm] ago|just now/.test(d)),
  `no more "24d ago": ${dates.slice(0, 4).join(' | ')}`,
);
check(
  dates.some((d) => /^\d{2}:\d{2}$/.test(d) || d === 'new' || d === 'yesterday' ||
                    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d/.test(d)),
  'the format is clock time / yesterday / day name',
);
// The column is aligned — this is what makes it scannable.
check(
  await ev(`
    (() => {
      const xs = [...document.querySelectorAll('#tree .session .when')]
        .slice(0, 12).map(n => Math.round(n.getBoundingClientRect().left));
      return xs.length > 1 && new Set(xs).size === 1;
    })()
  `),
  'the date column is left-aligned at one and the same position',
);

// --- 4. history folded up per day -------------------------------------------
const big = await ev(`
  (() => {
    const rows = [...document.querySelectorAll('#tree .project')];
    let best = null, n = -1;
    for (const r of rows) {
      // .pmeta reads "31 · 06:30" — the number comes first.
      const c = r.querySelector('.pmeta');
      const v = c ? parseInt(c.textContent) : 0;
      if (v > n) { n = v; best = r.querySelector('.pname')?.textContent; }
    }
    return JSON.stringify({ name: best, n });
  })()
`).then(JSON.parse);
check(big.n > 0, `the project row names its session count (${big.name}: ${big.n})`);

await ev(`
  (() => {
    const rows = [...document.querySelectorAll('#tree .project')];
    const t = rows.find(r => r.querySelector('.pname')?.textContent === ${JSON.stringify(big.name)});
    if (t && t.querySelector('.twist')?.textContent === '\\u25b8') t.querySelector('.twist').click();
  })()
`);
await sleep(700);
const buckets = await ev(`
  (() => {
    const rows = [...document.querySelectorAll('#tree .project')];
    const t = rows.find(r => r.querySelector('.pname')?.textContent === ${JSON.stringify(big.name)});
    return JSON.stringify({
      heads: [...(t?.querySelectorAll('.bhead') || [])].map(h => h.querySelector('.blabel').textContent),
      open: [...(t?.querySelectorAll('.bhead') || [])].map(h => h.querySelector('.barw').textContent),
      shown: t ? t.querySelectorAll('.session').length : 0,
    });
  })()
`).then(JSON.parse);
check(buckets.heads.length > 0, `history is grouped per day: ${buckets.heads.join(' / ')}`);
check(
  buckets.shown < big.n,
  `fewer are laid out than the whole history (${buckets.shown} of ${big.n})`,
);
check(
  buckets.open.filter((a) => a === '\u25be').length <= 1,
  'only the most recent group is open from the start',
);

// Opening a group lays out its contents, and the choice survives a reload.
await ev(`
  (() => {
    const h = [...document.querySelectorAll('#tree .bhead')].find(x => x.querySelector('.barw').textContent === '\\u25b8');
    if (h) h.click();
  })()
`);
await sleep(600);
const after = await ev(`document.querySelectorAll('#tree .session').length`);
check(after > buckets.shown, `opening a group adds rows (${buckets.shown} → ${after})`);
check(
  await ev(`JSON.parse(localStorage.getItem('sh.buckets') || '[]').length > 0`),
  'the choice is stored',
);

// --- 5. the filter reaches past the folds -----------------------------------
await ev(`
  (() => {
    const f = document.getElementById('filter');
    f.value = 'a';
    f.dispatchEvent(new Event('input', { bubbles: true }));
  })()
`);
await sleep(800);
const filtered = await ev(`
  JSON.stringify({
    zone: document.querySelectorAll('#tree .zrow').length,
    heads: document.querySelectorAll('#tree .bhead').length,
    label: document.querySelector('#tree .zlabel')?.firstChild.textContent,
  })
`).then(JSON.parse);
check(filtered.zone === 0, 'the top zone steps aside while filtering');
check(filtered.heads === 0, 'search results are laid out flat — nothing hides behind a fold');
check(filtered.label === 'results', `its label changes to "${filtered.label}"`);

await ev(`
  (() => {
    const f = document.getElementById('filter');
    f.value = '';
    f.dispatchEvent(new Event('input', { bubbles: true }));
  })()
`);
await sleep(700);
check(await ev(`document.querySelectorAll('#tree .zrow').length > 0`), 'the top zone comes back once the filter is emptied');

// --- 6. custom names ---------------------------------------------------------
// Redrawing after the filter is emptied does not always finish in a single
// breath; it is waited for, not guessed at with a sleep.
check(
  await waitFor(`!!document.querySelector('#tree .session:not(.loose)')`, 10000),
  'there is a history row that can be named',
);
const renamed = await ev(`
  (() => {
    // A loose terminal has no stored session, so there is nothing that can be
    // given a name — that row is skipped on purpose.
    const s = document.querySelector('#tree .session:not(.loose)');
    if (!s) return 'tidak ada baris sesi';
    const pencil = [...s.querySelectorAll('.fork')].find(x => x.textContent === '\\u270e');
    if (!pencil) return 'tidak ada tombol ganti nama';
    pencil.click();
    const inp = document.querySelector('#tree .srename');
    if (!inp) return 'kotak isian tidak muncul';
    inp.value = 'UJI ALIAS';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'ok';
  })()
`);
check(renamed === 'ok', `the rename box can be opened: ${renamed}`);
await sleep(700);
check(
  await ev(`!!document.querySelector('#tree .session .stitle.alias')`),
  'the title turns into the custom name',
);
check(
  await ev(`!!document.querySelector('#tree .zrow .stitle.alias')`),
  'and the name is marked in the top zone as well, not only in the history',
);
check(
  await ev(`(localStorage.getItem('sh.alias') || '').includes('UJI ALIAS')`),
  'the alias is stored in localStorage, not sent to the daemon',
);
// Put it back the way it was: empty the name out.
await ev(`
  (() => {
    // The alias now shows up in two places — the top zone and the history. Only
    // the history row has a rename button.
    const s = document.querySelector('#tree .session .stitle.alias')?.closest('.session');
    const pencil = s && [...s.querySelectorAll('.fork')].find(x => x.textContent === '\\u270e');
    if (pencil) {
      pencil.click();
      const inp = document.querySelector('#tree .srename');
      inp.value = '';
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
  })()
`);
await sleep(600);
// Scoped to THIS alias, not to the marker in general: a named terminal wears
// the same marker on purpose — a name you chose has to look like a name
// wherever its row appears — so "no alias anywhere" would fail for reasons that
// have nothing to do with renaming a session.
check(
  !(await ev(`
    [...document.querySelectorAll('#tree .stitle.alias')]
      .some(x => x.textContent.includes('UJI ALIAS'))
  `)),
  'emptying it restores the original title',
);

// --- 7. no Indonesian leaks onto the screen ---------------------------------
// The convention: comments and documents in Indonesian, but every word the
// user gets to see in English. Checked, not merely kept in mind.
await goto(`/?token=${TOKEN}`);
await waitFor(`!!document.querySelector('#tree .zlabel')`, 20000);
// Only the text the app ITSELF produces is checked. Session titles that belong
// to the user really are in Indonesian, and pulling them in here would make
// this check fail because of the data, not because of the UI.
const leaked = await ev(`
  (() => {
    const chrome = [
      ...document.querySelectorAll('#tree .zlabel, #tree .blabel, #tree .when'),
    ].map((n) => n.textContent);
    for (const n of document.querySelectorAll('#tree .fork, #tree .pmeta, #tree .twist')) {
      if (n.title) chrome.push(n.title);
    }
    const bad = ['hari ini', 'kemarin', 'lebih lama', 'sesi', 'hasil', 'aktif', 'baru', 'nama'];
    const t = chrome.join(' | ').toLowerCase();
    return JSON.stringify(bad.filter((w) => t.includes(w)));
  })()
`).then(JSON.parse);
check(
  leaked.length === 0,
  `the sidebar is English all the way through${leaked.length ? ' — leaked: ' + leaked.join(', ') : ''}`,
);

const signin = await fetch(`http://127.0.0.1:${PORT}/`, {
  headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' },
});
const body = await signin.text();
check(signin.status === 401, `the sign-in page is still a 401, not a 200 (${signin.status})`);
check(body.includes('<input'), 'without a token, the browser gets an input box');
check(
  !/Tempel|Masuk|Tokennya/.test(body),
  'the sign-in page is in English too',
);
check(
  !body.includes('/app.css') && !body.includes('/vendor/'),
  'the sign-in page refers to no asset that would itself need a token',
);

// Only what was opened here gets closed again. A terminal that was already
// alive before this test ran is not ours.
if (spawned !== null) {
  const done = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise((r) => { done.onopen = r; });
  done.send(JSON.stringify({ t: 'kill', id: spawned }));
  await sleep(600);
  done.close();
}

// Clean up what we made ourselves; whatever existed beforehand is left alone.
if (spawned !== null) {
  const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise((r) => { ws2.onopen = r; });
  ws2.send(JSON.stringify({ t: 'kill', id: spawned }));
  await sleep(800);
  ws2.close();
}

// --- 8. the second dead end: valid cookie, empty localStorage ---------------
// A 401 never happens here, so the daemon's own sign-in page is never seen —
// the input box has to exist inside the app as well.
await goto(`/?token=${TOKEN}`);
await waitFor(`!!document.querySelector('#tree .project')`, 20000);
// Remove it first, then move pages. `location.reload()` inside an evaluate
// makes the reply never come back, and `ev` waits forever.
await ev(`localStorage.removeItem('sh.token')`);
await goto('/');
check(
  await waitFor(`!!document.querySelector('#tokenform input')`, 15000),
  'without a token in localStorage, the app offers an input box',
);
check(
  await ev(`!/No token yet/.test(document.getElementById('empty').textContent)`),
  'no longer a dead message with no way out',
);
check(
  await ev(`document.querySelector('#tokenform input').type === 'password'`),
  'the token cannot be read off the screen as it is typed',
);
// Fill it in and submit — the token must really be used, not merely stored.
await ev(`
  (() => {
    const i = document.querySelector('#tokenform input');
    i.value = ${JSON.stringify(TOKEN)};
    document.getElementById('tokenform').dispatchEvent(new Event('submit', { cancelable: true }));
  })()
`);
check(
  await waitFor(`!!document.querySelector('#tree .project')`, 20000),
  'filling it in really does let you in — the sidebar fills up again',
);
check(
  await ev(`!location.search.includes('token')`),
  'and the token is cleaned back out of the URL',
);

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
