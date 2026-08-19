// Dropping a file onto the terminal: the upload over WS, storage in
// ~/.sessionhub/dropped/, the sanitised name, the size limit, and the sweep.
//
// Start the test daemon first with --home <scratchpad>\fakehome.

import { readFileSync, readdirSync, existsSync, utimesSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 7719;
const HOME =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome';
const CFG = join(HOME, '.sessionhub', 'config.toml');
const DIR = join(HOME, '.sessionhub', 'dropped');
const PROJECT = 'C:\\data\\code\\terminal-editor2';

const steps = [];
const ok = (m) => { steps.push(true); console.log('  [ ok ] ' + m); };
const bad = (m) => { steps.push(false); console.log('  [FAIL] ' + m); };
const check = (c, m) => (c ? ok(m) : bad(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!CFG.includes('fakehome')) { console.error('ABORT: not the test config.'); process.exit(1); }
const TOKEN = /token\s*=\s*"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];
const listDir = () => (existsSync(DIR) ? readdirSync(DIR) : []);

// A real 1x1 PNG, so that what is tested really is binary bytes — not text.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
ws.binaryType = 'arraybuffer';
const send = (o) => ws.send(JSON.stringify(o));

const dropFrame = (term, name, bytes) => {
  const label = Buffer.from(name, 'utf8');
  const f = Buffer.alloc(10 + label.length + bytes.length);
  f.writeUInt32LE(0xffffffff, 0);
  f.writeUInt32LE(term, 4);
  f.writeUInt16LE(label.length, 8);
  label.copy(f, 10);
  bytes.copy(f, 10 + label.length);
  ws.send(f);
};

let termId = null;
let screen = '';
const errors = [];
const dropped = [];
let waiter = null;
const expect = (kind) =>
  new Promise((res, rej) => {
    waiter = { kind, res };
    setTimeout(() => rej(new Error(`timeout waiting for ${kind}`)), 15000);
  });

ws.onmessage = (ev) => {
  if (typeof ev.data !== 'string') {
    screen += Buffer.from(ev.data).subarray(4).toString('utf8');
    return;
  }
  const m = JSON.parse(ev.data);
  if (m.t === 'attached') termId = m.id;
  else if (m.t === 'dropped') dropped.push(m);
  else if (m.t === 'error') errors.push(m);
  else if (m.t === 'config') {
    if (waiter?.kind === 'config') { waiter.res(m); waiter = null; }
    return;
  }
  if (waiter && (m.t === waiter.kind || (waiter.kind === 'dropped' && m.t === 'error'))) {
    waiter.res(m);
    waiter = null;
  }
};

await new Promise((r) => { ws.onopen = r; });

// --- a terminal to receive the path -----------------------------------------
send({ t: 'spawn', project: PROJECT, agent: 'shell', resume: null, cols: 100, rows: 30 });
await sleep(3000);
if (termId === null) { console.error('the test terminal failed to come alive'); process.exit(1); }

// --- 1. an ordinary drop -----------------------------------------------------
const before = listDir().length;
let p = expect('dropped');
dropFrame(termId, 'Screenshot 2026-08-14.png', PNG);
let msg = await p;

check(msg.t === 'dropped', `the daemon answers: ${msg.t}`);
check(existsSync(msg.path), `the file really is there on disk: ${msg.path}`);
check(msg.path.startsWith(DIR), 'it lands in ~/.sessionhub/dropped/, not in the project folder');
check(
  existsSync(msg.path) && Buffer.compare(readFileSync(msg.path), PNG) === 0,
  'its contents are identical byte for byte — undamaged by the trip over WS',
);
check(msg.bytes === PNG.length, `the size is reported correctly (${msg.bytes} B)`);
check(/\d{13}-Screenshot-2026-08-14\.png$/.test(msg.path), `the name is sanitised yet still readable: ${msg.name}`);
check(listDir().length === before + 1, 'exactly one file is added');

// --- 2. two files with the same name do not overwrite each other -------------
p = expect('dropped');
dropFrame(termId, 'Screenshot 2026-08-14.png', PNG);
const msg2 = await p;
check(msg2.path !== msg.path, 'the same name does not overwrite the older one');

// --- 3. a malicious name -----------------------------------------------------
p = expect('dropped');
dropFrame(termId, '..\\..\\..\\Windows\\System32\\evil.dll', PNG);
const msg3 = await p;
check(msg3.t === 'dropped' && msg3.path.startsWith(DIR), 'path traversal does not get out of the drop folder');
check(!msg3.path.includes('..'), `no ".." is left over: ${msg3.name}`);
check(!existsSync('C:\\Windows\\System32\\evil.dll'), 'no file lands in System32');

// --- 4. an oversized file is refused, not cut off ----------------------------
const cfgNow = await (async () => { send({ t: 'config' }); return expect('config'); })();
const capMb = cfgNow.drops.max_file_mb;
check(capMb > 0, `the per-file limit is read from the config (${capMb} MB)`);

p = expect('dropped');
dropFrame(termId, 'huge.bin', Buffer.alloc((capMb + 1) * 1024 * 1024, 7));
const big = await p;
check(big.t === 'error' && big.code === 'drop_failed', `refused with a message rather than cut off: ${big.code}`);
check(/MB limit/.test(big.message || ''), `the message names the limit: ${big.message}`);
check(ws.readyState === 1, 'the connection stays alive after the upload is refused');

// --- 5. the path goes into the terminal, without an Enter -------------------
screen = '';
// It is the real client that types the path in; imitate that.
const typed = /[\s"']/.test(msg.path) ? `"${msg.path}" ` : `${msg.path} `;
const body = Buffer.from(typed, 'utf8');
const f = Buffer.alloc(4 + body.length);
f.writeUInt32LE(termId, 0);
body.copy(f, 4);
ws.send(f);
await sleep(1200);
check(screen.includes(msg.name), 'the path appears on the terminal screen');
check(!/\r?\n.*PS /.test(screen.slice(screen.indexOf(msg.name))), 'it is not run along with it — Enter still belongs to the user');

// --- 6. sweep by age ---------------------------------------------------------
// The old file is made straight on disk, then its mtime is pushed back.
const old = join(DIR, 'aged-test-file.png');
writeFileSync(old, PNG);
const longAgo = Date.now() / 1000 - 48 * 3600;
utimesSync(old, longAgo, longAgo);

send({ t: 'set_drops', max_age_hours: 24, max_total_mb: 100, max_file_mb: capMb });
const after = await expect('config');
check(!existsSync(old), 'a file 48 hours old is swept away by the 24-hour limit');
check(existsSync(msg.path), 'a file that was just dropped is not swept away with it');
check(after.drops.max_age_hours === 24, 'the age limit is stored');

// --- 7. the size limit must not touch a file that is still new ---------------
// The folder is forced to be "full" with a 0 MB limit… but 0 means no limit,
// so 1 MB is used while everything in it is only seconds old.
send({ t: 'set_drops', max_age_hours: 24, max_total_mb: 1, max_file_mb: capMb });
await expect('config');
check(existsSync(msg.path), 'the size limit does not throw away a freshly dropped file (grace period)');

// --- 8. a manual sweep -------------------------------------------------------
send({ t: 'set_drops', max_age_hours: 24, max_total_mb: 100, max_file_mb: capMb });
await expect('config');
send({ t: 'sweep_drops' });
const swept = await expect('config');
check(typeof swept.drops.files === 'number', `usage is reported back: ${swept.drops.files} files`);
check(swept.drops.dir === DIR, 'the folder reported is the same one that is used');

// --- 9. age 0 = never throw anything away -----------------------------------
utimesSync(msg.path, longAgo, longAgo);
send({ t: 'set_drops', max_age_hours: 0, max_total_mb: 100, max_file_mb: capMb });
await expect('config');
check(existsSync(msg.path), '0 hours means never throwing anything away for age');

// --- done --------------------------------------------------------------------
send({ t: 'set_drops', max_age_hours: 24, max_total_mb: 100, max_file_mb: 20 });
await expect('config');
send({ t: 'kill', id: termId });
await sleep(400);
ws.close();

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
