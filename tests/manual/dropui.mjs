// Drop and paste from the browser side. Needs Chrome with
// --remote-debugging-port=9222 and the test daemon on 7719.
//
// An honest note: the drag/drop events here are raised through a real DragEvent
// + DataTransfer inside the page, not through the drag machinery of the OS.
// What is tested is the whole application path (handler → upload → save → path
// into the terminal); the only thing left untouched is the system drag layer.

import { readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 7719;
const HOME =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome';
const CFG = join(HOME, '.sessionhub', 'config.toml');
const DIR = join(HOME, '.sessionhub', 'dropped');
const TOKEN = /token\s*=\s*"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listDir = () => (existsSync(DIR) ? readdirSync(DIR) : []);

// Uploads left over from an earlier test run throw the file count off.
rmSync(DIR, { recursive: true, force: true });

// --- prepare the terminal that will take the drop ----------------------------
{
  const app = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  app.binaryType = 'arraybuffer';
  let screen = '';
  const seen = [];
  app.onmessage = (ev) => {
    if (typeof ev.data === 'string') seen.push(JSON.parse(ev.data));
    else screen += Buffer.from(ev.data).subarray(4).toString('utf8');
  };
  await new Promise((r) => { app.onopen = r; });
  while (!seen.find((m) => m.t === 'state')) await sleep(120);
  app.send(JSON.stringify({
    t: 'spawn', project: 'C:\\data\\code\\terminal-editor2', agent: 'shell', resume: null,
    cols: 110, rows: 30,
  }));
  const t0 = Date.now();
  while (!/PS [A-Z]:/.test(screen) && Date.now() - t0 < 30000) await sleep(150);
  app.close();
  await sleep(400);
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

await cmd('Emulation.setDeviceMetricsOverride', { width: 1180, height: 780, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.setItem('sh.theme','light'); localStorage.setItem('sh.sidebar.hidden','0')`);
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(3000);

// Do not guess from a pause: an upload is only sent once its WS is connected,
// and a filled sidebar is the proof that `state` has arrived.
const waitFor = async (expr, ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(expr)) return true;
    await sleep(200);
  }
  return false;
};
if (!(await waitFor(`document.querySelectorAll('#tree .row').length > 0`))) {
  console.log('  [ABORT] the page never connected to the daemon');
  process.exit(2);
}

// A safeguard: this test writes real files.
await ev(`document.getElementById('settings-btn').click()`);
for (let i = 0; i < 60; i++) { if (await ev(`!!document.querySelector('.dropset')`)) break; await sleep(200); }
const path2 = await ev(`document.querySelector('.shead .path').textContent`);
if (!path2.includes('fakehome')) { console.log(`  [ABORT] pointing at the real config: ${path2}`); process.exit(2); }
await ev(`document.querySelector('#settings .close').click()`);

// Open the terminal through the first tab.
await ev(`document.querySelector('#tabs .tab')?.click()`);
await sleep(600);
check(await ev(`document.querySelectorAll('#terms .host').length > 0`), 'the terminal is open in the UI');

// --- helper: build a DataTransfer holding one file ---------------------------
const mkDt = (name, type) => `
  (() => {
    const bytes = new Uint8Array([137,80,78,71,13,10,26,10,1,2,3,4,5,6,7,8]);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
    return dt;
  })()`;

// --- 1. dragenter brings up the drop zone -----------------------------------
await ev(`
  window.__dt = ${mkDt('shot.png', 'image/png')};
  document.getElementById('terms').dispatchEvent(
    new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
`);
await sleep(200);
const zone = await ev(`
  (() => {
    const z = document.querySelector('#terms .dropzone');
    if (!z) return null;
    const cs = getComputedStyle(z);
    return { tampak: !z.hidden, teks: z.textContent, klik: cs.pointerEvents };
  })()
`);
check(zone && zone.tampak, 'the drop zone appears when a file is dragged in');
check(/Drop to upload/.test(zone?.teks || ''), 'the zone says what is about to happen');
check(/machine running the agent/.test(zone?.teks || ''), 'it explains the file lands on the agent machine, not on this device');
check(zone?.klik === 'none', 'the zone does not catch the pointer, so it does not flicker as the cursor moves');

// --- 2. dragleave hides it again --------------------------------------------
await ev(`document.getElementById('terms').dispatchEvent(new DragEvent('dragleave', { bubbles: true }))`);
await sleep(200);
check(await ev(`document.querySelector('#terms .dropzone').hidden === true`), 'the zone disappears again when the drag leaves');

// --- 3. a real drop ----------------------------------------------------------
const before = listDir().length;
await ev(`
  document.getElementById('terms').dispatchEvent(
    new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt }));
`);
await sleep(2500);

const files = listDir().filter((f) => f.endsWith('shot.png'));
check(files.length === 1, `the file is stored on the daemon (${files[0] || 'none'})`);
check(listDir().length === before + 1, 'exactly one file is added');
check(await ev(`document.querySelector('#terms .dropzone').hidden === true`), 'the zone closes itself once it is dropped');

const screenText = await ev(`
  (() => {
    const t = document.querySelector('#terms .host:not([hidden]) .xterm-rows');
    return t ? t.textContent : '';
  })()
`);
check(files[0] && screenText.includes(files[0]), 'its path is typed into the terminal');
check(screenText.includes(DIR.replace(/\\/g, '\\')) || screenText.includes('dropped'), 'what is typed is the path on the daemon machine');

const bannerText = await ev(`document.getElementById('banner').hidden ? '' : document.getElementById('banner').textContent`);
check(/uploaded/.test(bannerText), `there is word that the upload succeeded: "${bannerText}"`);

// --- 4. paste an image from the clipboard -----------------------------------
const beforePaste = listDir().length;
await ev(`
  (() => {
    const dt = ${mkDt('', 'image/png')};
    document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  })()
`);
await sleep(2500);
const pasted = listDir().filter((f) => /pasted\.png$/.test(f));
check(pasted.length === 1, `an image from the clipboard is uploaded as well (${pasted[0] || 'none'})`);
check(listDir().length === beforePaste + 1, 'exactly one file is added by the paste');

// --- 5. a stray drop does not navigate the page ------------------------------
const prevented = await ev(`
  (() => {
    const e = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: ${mkDt('x.png', 'image/png')} });
    document.getElementById('sidebar').dispatchEvent(e);
    return e.defaultPrevented;
  })()
`);
check(prevented, 'a drop outside the terminal is prevented, the page does not move to the file');

// --- 6. the settings panel ---------------------------------------------------
await ev(`document.getElementById('settings-btn').click()`);
// Dropped files is now its own section in the rail, not a row in one long scroll.
for (let i = 0; i < 60; i++) {
  await ev(`document.querySelector('#settings .sitem[data-section="files"]')?.click()`);
  if (await ev(`!!document.querySelector('#settings .sec.drops')`)) break;
  await sleep(200);
}
const panel = await ev(`
  (() => {
    const b = document.querySelector('#settings .sec.drops');
    return {
      judul: b.querySelector('.sechead h3').textContent,
      teks: b.textContent,
      angka: [...b.querySelectorAll('input[type=number]')].map(i => ({ v: i.value, t: i.title })),
      tombol: !!b.querySelector('button'),
    };
  })()
`);
check(panel.judul === 'Dropped files', `the row is there in Settings ("${panel.judul}")`);
check(panel.angka.length === 3, `three limits can be set (${panel.angka.map(a => a.v).join(', ')})`);
check(panel.angka.every((a) => /0 =/.test(a.t)), 'each field explains what the value 0 means');
check(panel.teks.includes(DIR), 'it shows the folder that is really used');
check(/Age is the main rule/.test(panel.teks), 'it explains that age is the main rule');
check(/never taken away/.test(panel.teks), 'it explains that a new file will not be thrown away by the size limit');
check(panel.tombol, 'there is a manual cleanup button');

// Change one limit, and make sure it reaches config.toml.
await ev(`
  (() => {
    const i = document.querySelectorAll('#settings .sec.drops input[type=number]')[0];
    i.value = '12';
    i.dispatchEvent(new Event('change', { bubbles: true }));
  })()
`);
await sleep(1500);
check(/max_age_hours\s*=\s*12/.test(readFileSync(CFG, 'utf8')), 'the new limit is stored in config.toml');

// Put it back, then clean the test folder out through that same button.
await ev(`
  (() => {
    const i = document.querySelectorAll('#settings .sec.drops input[type=number]')[0];
    i.value = '24';
    i.dispatchEvent(new Event('change', { bubbles: true }));
  })()
`);
await sleep(1200);
await ev(`document.querySelector('#settings .close').click()`);

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
