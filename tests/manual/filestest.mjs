// The file tree and file contents over the protocol: one folder per request,
// folders-then-files ordering, the size limit, binary files, and saving.
// Run the test daemon at --home <scratchpad>\fakehome.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 7719;
const HOME =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome';
const CFG = join(HOME, '.sessionhub', 'config.toml');
const BOX = join(HOME, 'filebox');

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };

if (!CFG.includes('fakehome')) { console.error('ABORT: not the test config.'); process.exit(1); }
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];

rmSync(BOX, { recursive: true, force: true });
mkdirSync(join(BOX, 'src'), { recursive: true });
mkdirSync(join(BOX, 'Assets'), { recursive: true });
writeFileSync(join(BOX, 'main.rs'), 'fn main() {\n    println!("hi");\n}\n');
writeFileSync(join(BOX, 'README.md'), '# judul\n');
writeFileSync(join(BOX, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
writeFileSync(join(BOX, 'src', 'lib.rs'), 'pub fn x() {}\n');
// A large file, to exercise truncation at the 2 MB limit.
const line = `${'y'.repeat(999)}\n`;
writeFileSync(join(BOX, 'big.log'), line.repeat(2200));

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
const send = (o) => ws.send(JSON.stringify(o));
let waiter = null;
const want = () =>
  new Promise((res, rej) => {
    waiter = res;
    setTimeout(() => rej(new Error('timeout')), 20000);
  });
ws.onmessage = (e) => {
  if (typeof e.data !== 'string') return;
  const m = JSON.parse(e.data);
  if (m.t === 'state') return;
  if (waiter && ['tree', 'file', 'saved', 'error'].includes(m.t)) { waiter(m); waiter = null; }
};
await new Promise((r) => { ws.onopen = r; });

// --- 1. the contents of a single folder --------------------------------------
send({ t: 'tree', path: BOX });
let m = await want();
check(m.t === 'tree', `the folder is answered: ${m.t}`);
const names = m.entries.map((e) => e.name);
check(
  names.join(',') === 'Assets,src,a.png,big.log,main.rs,README.md',
  `folders first then files, both sorted case-insensitively: ${names.join(', ')}`,
);
check(m.entries[0].is_dir && !m.entries[2].is_dir, 'the folder/file markers are right');
check(m.entries.find((e) => e.name === 'main.rs').size === 34, 'the file size is reported');
check(m.entries.find((e) => e.name === 'src').size === 0, 'a folder does not add up its contents — that is work avoided');
check(!m.truncated, 'a small folder is not marked as truncated');

// --- 2. lazy: subfolders only arrive when asked for --------------------------
check(
  !JSON.stringify(m.entries).includes('lib.rs'),
  'the contents of the subfolder are NOT sent along — only one level per request',
);
send({ t: 'tree', path: join(BOX, 'src') });
m = await want();
check(m.entries.length === 1 && m.entries[0].name === 'lib.rs', 'the subfolder is requested separately when it is opened');

// --- 3. opening a text file ---------------------------------------------------
send({ t: 'open_file', path: join(BOX, 'main.rs') });
m = await want();
check(m.t === 'file', `the file is answered: ${m.t}`);
check(m.text.startsWith('fn main()'), 'the contents come through intact');
check(m.name === 'main.rs' && !m.binary && !m.truncated, 'the name, the binary marker and the truncation marker are right');
check(m.size === 34 && m.modified_ms > 0, `the size and modification time are sent along (${m.size} B)`);

// --- 4. the contents of a binary file are not sent ---------------------------
send({ t: 'open_file', path: join(BOX, 'a.png') });
m = await want();
check(m.binary === true, 'a binary file is marked as such');
check(m.text === '', 'its bytes are not sent along — there is no point drawing them as text');
check(m.size === 7, 'its size is still reported so the UI can say something');

// --- 4b. images are marked so they can be displayed --------------------------
check(m.image === true, 'a PNG is marked as an image, not merely as binary');
const raw = await fetch(
  `http://127.0.0.1:${PORT}/api/file?token=${TOKEN}&path=${encodeURIComponent(join(BOX, 'a.png'))}`,
);
check(raw.status === 200, `its bytes are fetched over HTTP: ${raw.status}`);
check(raw.headers.get('content-type') === 'image/png', `with the right type: ${raw.headers.get('content-type')}`);
check(Buffer.from(await raw.arrayBuffer()).length === 7, 'the contents are intact, byte for byte');

const folderReq = await fetch(
  `http://127.0.0.1:${PORT}/api/file?token=${TOKEN}&path=${encodeURIComponent(BOX)}`,
);
check(folderReq.status === 404, `a folder through /api/file is rejected: ${folderReq.status}`);
const noPath = await fetch(`http://127.0.0.1:${PORT}/api/file?token=${TOKEN}`);
check(noPath.status === 400, `without a path it is rejected: ${noPath.status}`);
const wrongToken = await fetch(
  `http://127.0.0.1:${PORT}/api/file?token=salah&path=${encodeURIComponent(join(BOX, 'a.png'))}`,
);
check(wrongToken.status === 401, `a wrong token still gives 401 on this route: ${wrongToken.status}`);

send({ t: 'open_file', path: join(BOX, 'main.rs') });
m = await want();
check(m.image === false, 'a text file is not marked as an image');

// --- 5. a large file is truncated at a line boundary -------------------------
send({ t: 'open_file', path: join(BOX, 'big.log') });
m = await want();
check(m.truncated === true, 'a file over 2 MB is marked as truncated');
check(m.text.length <= 2 * 1024 * 1024, `what is sent is no more than 2 MB (${m.text.length} B)`);
check(m.text.endsWith('\n'), 'the cut stops at the end of a line, not in the middle of one');
check(m.size > 2 * 1024 * 1024, `the real size is still reported (${(m.size / 1048576).toFixed(1)} MB)`);

// --- 6. saving ------------------------------------------------------------------
send({ t: 'save_file', path: join(BOX, 'main.rs'), text: 'fn main() { /* diubah */ }\n' });
m = await want();
check(m.t === 'saved', `the save is answered: ${m.t}`);
check(
  readFileSync(join(BOX, 'main.rs'), 'utf8') === 'fn main() { /* diubah */ }\n',
  'the contents really did change on disk',
);
check(m.modified_ms > 0, 'the new modification time is sent back');

// --- 7. what is not allowed -----------------------------------------------------
send({ t: 'save_file', path: join(BOX, 'belumada.txt'), text: 'x' });
m = await want();
check(m.t === 'error' && m.code === 'save_failed', `saving to a file that does not exist is rejected: ${m.code}`);
check(!existsSync(join(BOX, 'belumada.txt')), 'and it is not quietly created');

send({ t: 'open_file', path: BOX });
m = await want();
check(m.t === 'error' && /is a folder/.test(m.message), `a folder is not opened as a file: ${m.message}`);

send({ t: 'tree', path: join(BOX, 'tidakada') });
m = await want();
check(m.t === 'error' && m.code === 'tree_failed', `a folder that does not exist -> ${m.code}`);

send({ t: 'open_file', path: `${BOX}\\src\\..\\main.rs` });
m = await want();
check(m.t === 'file' && !m.path.includes('..'), `".." is cleaned up before the disk is touched: ${m.path}`);

ws.close();
rmSync(BOX, { recursive: true, force: true });

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
