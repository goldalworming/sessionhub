// The folder picker: browsing the disk of the daemon machine, creating a new
// folder, then turning it into a project. Run the test daemon with
// --home <scratchpad>\fakehome.

import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 7719;
const HOME =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome';
const CFG = join(HOME, '.sessionhub', 'config.toml');
const SANDBOX = join(HOME, 'browsebox');

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!CFG.includes('fakehome')) { console.error('ABORT: not the test config.'); process.exit(1); }
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];
const cfgText = () => readFileSync(CFG, 'utf8');

rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(join(SANDBOX, 'alpha'), { recursive: true });
mkdirSync(join(SANDBOX, 'Beta'), { recursive: true });
mkdirSync(join(SANDBOX, 'gamma', '.git'), { recursive: true });

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
const send = (o) => ws.send(JSON.stringify(o));

let lastState = null;
let waiter = null;
const want = () =>
  new Promise((res, rej) => {
    waiter = res;
    setTimeout(() => rej(new Error('timeout')), 15000);
  });

ws.onmessage = (e) => {
  if (typeof e.data !== 'string') return;
  const m = JSON.parse(e.data);
  if (m.t === 'state') { lastState = m; return; }
  if (waiter && (m.t === 'dir' || m.t === 'error')) { waiter(m); waiter = null; }
};

await new Promise((r) => { ws.onopen = r; });

// --- 1. an empty path means the home folder ----------------------------------
send({ t: 'browse', path: '' });
let d = await want();
check(d.t === 'dir', `an empty path is answered with the contents of a folder: ${d.t}`);
check(d.path.toLowerCase() === HOME.toLowerCase(), `starts at the home folder: ${d.path}`);
check(d.roots.length > 0, `starting points are offered: ${d.roots.map((r) => r.name).join(', ')}`);
check(d.roots.some((r) => r.name === 'Home'), 'the home folder is among them');
check(d.roots.some((r) => /^[A-Z]:$/.test(r.name)), 'Windows drives are listed as well');
check(typeof d.parent === 'string', 'it has a parent, so the up button can be used');

// --- 2. folders only, and their markers --------------------------------------
send({ t: 'browse', path: SANDBOX });
d = await want();
const names = d.entries.map((e) => e.name);
check(names.join(',') === 'alpha,Beta,gamma', `sorted case-insensitively: ${names.join(', ')}`);
check(d.entries.every((e) => !e.name.includes('.toml')), 'files are left out — this is a folder picker');
check(d.entries.find((e) => e.name === 'gamma')?.is_repo === true, 'a folder with a .git is marked as a repo');
check(d.entries.find((e) => e.name === 'alpha')?.is_repo === false, 'one that is not a repo is not marked');
check(d.entries.every((e) => !e.is_project), 'none of them is a project yet');

// --- 3. odd paths are cleaned up before touching the disk --------------------
send({ t: 'browse', path: `${SANDBOX}\\alpha\\..\\gamma` });
d = await want();
check(d.path.toLowerCase() === join(SANDBOX, 'gamma').toLowerCase(), `".." is cleaned up: ${d.path}`);
check(d.is_repo === true, 'the folder currently open is reported as a repo too');

send({ t: 'browse', path: join(SANDBOX, 'tidakada') });
d = await want();
check(d.t === 'error' && d.code === 'browse_failed', `a folder that does not exist -> ${d.code}`);
check(/Cannot open/.test(d.message || ''), `the message explains itself: ${d.message}`);

send({ t: 'browse', path: CFG });
d = await want();
check(d.t === 'error' && /not a folder/.test(d.message || ''), `a file is rejected: ${d.message}`);

// --- 4. create a new folder and step straight into it ------------------------
send({ t: 'make_dir', parent: SANDBOX, name: 'proyek-baru' });
d = await want();
check(d.t === 'dir', 'creating a folder is answered directly with its contents');
check(d.path.toLowerCase() === join(SANDBOX, 'proyek-baru').toLowerCase(), `we are already inside it: ${d.path}`);
check(existsSync(join(SANDBOX, 'proyek-baru')), 'the folder really exists on disk');
check(d.entries.length === 0, 'it is empty, as it should be');

send({ t: 'make_dir', parent: SANDBOX, name: 'proyek-baru' });
d = await want();
check(d.t === 'error' && /already exists/.test(d.message || ''), `a duplicate name is rejected: ${d.message}`);

// --- 5. a folder name is not a path ------------------------------------------
for (const [name2, why] of [
  ['..\\..\\keluar', 'escaping upwards'],
  ['a/b', 'directory separator'],
  ['C:\\Windows\\x', 'absolute path'],
  ['', 'empty'],
  ['q|r', 'forbidden character'],
]) {
  send({ t: 'make_dir', parent: SANDBOX, name: name2 });
  d = await want();
  check(d.t === 'error' && d.code === 'mkdir_failed', `the name "${name2}" is rejected (${why})`);
}
check(!existsSync(join(HOME, 'keluar')), 'no folder was created outside the target');

// --- 6. turn it into a project -------------------------------------------------
const created = join(SANDBOX, 'proyek-baru');
send({ t: 'add_project', path: created });
await sleep(2500);
check(cfgText().includes('browsebox'), 'written to config.toml');
check(
  (lastState?.projects || []).some((p) => p.path.toLowerCase() === created.toLowerCase()),
  'shows up in the sidebar without needing a restart',
);
const entry = (lastState?.projects || []).find((p) => p.path.toLowerCase() === created.toLowerCase());
check(entry?.exists === true, 'marked as existing, not as missing');
check(entry?.name === 'proyek-baru', `its name is taken from the folder: ${entry?.name}`);

// --- 7. the same project cannot be added twice ------------------------------
send({ t: 'add_project', path: created });
d = await want();
check(d.t === 'error' && d.code === 'duplicate_project', `rejected: ${d.code}`);
send({ t: 'add_project', path: created.toUpperCase() });
d = await want();
check(d.t === 'error' && d.code === 'duplicate_project', 'a different upper/lower case spelling still counts as the same');

send({ t: 'add_project', path: CFG });
d = await want();
check(d.t === 'error' && d.code === 'bad_project', `a file cannot become a project: ${d.code}`);

// --- 8. what is already a project is marked when browsing again -------------
send({ t: 'browse', path: SANDBOX });
d = await want();
check(d.entries.find((e) => e.name === 'proyek-baru')?.is_project === true, 'marked as "project" in the folder listing');
send({ t: 'browse', path: created });
d = await want();
check(d.is_project === true, 'the folder currently open knows it has become a project');

// --- 9. take it back out of the project list --------------------------------
send({ t: 'remove_project', path: created });
await sleep(2000);
check(!cfgText().includes('browsebox'), 'it can be taken back out of config.toml');
check(
  !(lastState?.projects || []).some((p) => p.path.toLowerCase() === created.toLowerCase()),
  'and it disappears from the sidebar',
);

send({ t: 'remove_project', path: join(HOME, 'tidak-pernah-ada') });
d = await want();
check(d.t === 'error' && d.code === 'unknown_project', `removing something that is not in the config -> ${d.code}`);
check(/come back on its own/.test(d.message || ''), `the message is honest about why: ${d.message}`);

// --- done ----------------------------------------------------------------------
ws.close();
rmSync(SANDBOX, { recursive: true, force: true });

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
