// Relay to another machine: pairing, then the WHOLE flow through `?via=`.
//
// Needs two test daemons:
//   sessionhubd start --foreground --home <scratchpad>\fakehome   (near, 7719)
//   sessionhubd start --foreground --home <scratchpad>\farhome    (far,  7721)

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const NEAR = 7719;
const FAR = 7721;
const SEP = String.fromCharCode(92);
const SCRATCH = [
  'C:', 'Users', 'user', 'AppData', 'Local', 'Temp', 'claude',
  'C--data-code-terminal-editor2', '1c72f2cc-7025-4869-a627-df2b835ecce0', 'scratchpad',
].join(SEP);
const NEAR_CFG = join(SCRATCH, 'fakehome', '.sessionhub', 'config.toml');
const FAR_CFG = join(SCRATCH, 'farhome', '.sessionhub', 'config.toml');
const FAR_BOX = join(SCRATCH, 'farhome', 'farbox');

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!NEAR_CFG.includes('fakehome')) { console.error('ABORT: not the test config.'); process.exit(1); }
const NEAR_TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(NEAR_CFG, 'utf8'))[1];
const FAR_TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(FAR_CFG, 'utf8'))[1];
const nearCfg = () => readFileSync(NEAR_CFG, 'utf8');

// A file that exists only on the far machine — proof the contents really do
// come from over there.
rmSync(FAR_BOX, { recursive: true, force: true });
mkdirSync(FAR_BOX, { recursive: true });
writeFileSync(join(FAR_BOX, 'only-far.txt'), 'ini hanya ada di mesin jauh\n');
writeFileSync(join(FAR_BOX, 'pic.png'), Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]));

// --- a small client ---------------------------------------------------------
function client(via) {
  const url = via
    ? `ws://127.0.0.1:${NEAR}/ws?token=${NEAR_TOKEN}&via=${encodeURIComponent(via)}`
    : `ws://127.0.0.1:${NEAR}/ws?token=${NEAR_TOKEN}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const c = { ws, screen: '', errors: [], last: {}, waiter: null };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') {
      c.screen += Buffer.from(e.data).subarray(4).toString('utf8');
      return;
    }
    const m = JSON.parse(e.data);
    c.last[m.t] = m;
    if (m.t === 'error') c.errors.push(m);
    if (c.waiter && (m.t === c.waiter.kind || m.t === 'error')) {
      const w = c.waiter;
      c.waiter = null;
      w.res(m);
    }
  };
  c.send = (o) => ws.send(JSON.stringify(o));
  c.want = (kind, ms = 20000) =>
    new Promise((res, rej) => {
      c.waiter = { kind, res };
      setTimeout(() => rej(new Error(`timeout waiting for ${kind}`)), ms);
    });
  c.open = () => new Promise((r) => { ws.onopen = r; });
  return c;
}

// --- 1. pairing -------------------------------------------------------------
const near = client(null);
await near.open();
await sleep(500);

// Pairings left over from an earlier test run make the name unpredictable:
// pairing the same address again deliberately REUSES the name that already
// exists, rather than replacing it.
near.send({ t: 'remotes' });
{
  const first = await near.want('remotes');
  // Only the names THIS suite creates. A blanket forget-everything once ran
  // against the wrong daemon and unpaired the user's real machine.
  const ours = (first.remotes || []).filter((r) => ['127-0-0-1', 'jauh', 'balik'].includes(r.name));
  for (const r of ours) {
    near.send({ t: 'forget', name: r.name });
    await near.want('remotes');
  }
}

near.send({ t: 'remotes' });
let m = await near.want('remotes');
check(Array.isArray(m.remotes), `the machine list is answered (${m.remotes.length})`);

// Half a link is refused before any connection is made.
for (const [link, why] of [
  ['', 'empty'],
  [`sessionhub://127.0.0.1:${FAR}/pair`, 'no token'],
  [`sessionhub://127.0.0.1/pair#token=${FAR_TOKEN}`, 'no port'],
  [`sessionhub://127.0.0.1:0/pair#token=${FAR_TOKEN}`, 'port 0'],
]) {
  near.send({ t: 'pair', link, name: '' });
  m = await near.want('remotes');
  check(m.t === 'error' && m.code === 'pair_failed', `a ${why} link is refused: ${(m.message || '').slice(0, 46)}`);
}

// A wrong token is refused by the far machine, not accepted and failed later.
near.send({ t: 'pair', link: `sessionhub://127.0.0.1:${FAR}/pair#token=salah`, name: '' });
m = await near.want('remotes');
check(m.t === 'error' && /refused the token/.test(m.message || ''), `a wrong token is refused: ${m.message}`);

// Pairing with itself is refused.
near.send({ t: 'pair', link: `sessionhub://127.0.0.1:${NEAR}/pair#token=${NEAR_TOKEN}`, name: '' });
m = await near.want('remotes');
check(m.t === 'error' && /this machine/.test(m.message || ''), `pairing with itself is refused: ${m.message}`);

// The right one.
near.send({ t: 'pair', link: `sessionhub://127.0.0.1:${FAR}/pair#token=${FAR_TOKEN}`, name: 'jauh' });
m = await near.want('remotes');
check(m.t === 'remotes', `pairing succeeded: ${m.t}`);
const entry = (m.remotes || []).find((r) => r.name === 'jauh');
check(!!entry, 'the machine goes into the list');
check(entry?.addr === `127.0.0.1:${FAR}`, `its address is right (${entry?.addr})`);
check(!!entry?.version, `its version is recorded too (${entry?.version})`);
check(
  !JSON.stringify(m.remotes).includes(FAR_TOKEN),
  'the far machine token is NOT sent along to the client',
);
check(nearCfg().includes(FAR_TOKEN), 'the token is stored in the config of the near daemon');

// --- 2. relay: the whole flow through the far machine -----------------------
const far = client('jauh');
await far.open();
m = await far.want('state');
check(m.t === 'state', 'state arrives from the far machine through the relay');
check(
  (m.agents || []).some((a) => (a.name || a) === 'cmd'),
  `the agents offered belong to the far machine: ${(m.agents || []).map((a) => a.name || a).join(', ')}`,
);

// Spawn + type + read: the full PTY path.
far.send({ t: 'spawn', project: 'C:\\data\\code\\terminal-editor2', agent: 'cmd', resume: null, cols: 90, rows: 24 });
const att = await far.want('attached');
check(att.t === 'attached', `spawn through the relay succeeded (id=${att.id})`);

const t0 = Date.now();
while (!/>/.test(far.screen) && Date.now() - t0 < 20000) await sleep(200);
check(/Microsoft Windows|>/.test(far.screen), 'PTY output flows back through the relay');

far.screen = '';
{
  const body = Buffer.from('echo LEWAT-RELAY\r', 'utf8');
  const f = Buffer.alloc(4 + body.length);
  f.writeUInt32LE(att.id, 0);
  body.copy(f, 4);
  far.ws.send(f);
}
const t1 = Date.now();
while (!far.screen.includes('LEWAT-RELAY') && Date.now() - t1 < 15000) await sleep(200);
check(far.screen.includes('LEWAT-RELAY'), 'the typing reaches the PTY on the far machine and comes back');

// Resize.
far.send({ t: 'resize', id: att.id, cols: 70, rows: 20 });
const size = await far.want('size');
check(size.cols === 70 && size.rows === 20, `a resize through the relay takes effect (${size.cols}x${size.rows})`);

// --- 3. files from the far machine ------------------------------------------
far.send({ t: 'tree', path: FAR_BOX });
m = await far.want('tree');
check(
  m.entries.some((e) => e.name === 'only-far.txt'),
  'the file tree shows the disk contents of the far machine',
);

far.send({ t: 'open_file', path: join(FAR_BOX, 'only-far.txt') });
m = await far.want('file');
check(m.text.includes('hanya ada di mesin jauh'), 'the file contents really do come from there');

far.send({ t: 'save_file', path: join(FAR_BOX, 'only-far.txt'), text: 'disunting lewat relay\n' });
m = await far.want('saved');
check(m.t === 'saved', 'saving through the relay succeeded');
check(
  readFileSync(join(FAR_BOX, 'only-far.txt'), 'utf8').includes('disunting lewat relay'),
  'and the file on the far machine really does change',
);

// An image through /api/file?via=
const img = await fetch(
  `http://127.0.0.1:${NEAR}/api/file?token=${NEAR_TOKEN}&via=jauh&path=${encodeURIComponent(join(FAR_BOX, 'pic.png'))}`,
);
check(img.status === 200, `the image is fetched through the relay: ${img.status}`);
check(img.headers.get('content-type') === 'image/png', `its type is right: ${img.headers.get('content-type')}`);
check(Buffer.from(await img.arrayBuffer()).length === 8, 'its bytes are intact');

// --- 4. the far machine config, not the local one ---------------------------
far.send({ t: 'config' });
m = await far.want('config');
check(m.config_path.includes('farhome'), `the settings shown belong to the far machine: ${m.config_path.slice(-40)}`);

// --- 5. what has to be refused -----------------------------------------------
const nope = await fetch(
  `http://127.0.0.1:${NEAR}/api/file?token=${NEAR_TOKEN}&via=tidakada&path=x`,
);
check(nope.status === 404, `an unregistered remote name is refused: ${nope.status}`);
check(
  (await nope.text()).includes('tidakada'),
  'the refusal names it, rather than being a generic error',
);

// Not an open proxy: a free-form address cannot be asked for, only a registered name.
const proxy = await fetch(
  `http://127.0.0.1:${NEAR}/api/file?token=${NEAR_TOKEN}&via=127.0.0.1:${FAR}&path=x`,
);
check(proxy.status === 404, `a raw address is refused — not an open proxy (${proxy.status})`);

// Chaining is refused: the far machine has no remote by that name.
const chain = client('jauh');
await chain.open();
await sleep(400);
chain.send({ t: 'pair', link: `sessionhub://127.0.0.1:${NEAR}/pair#token=${NEAR_TOKEN}`, name: 'balik' });
m = await chain.want('remotes');
check(m.t === 'error' || m.t === 'remotes', 'pairing from the far side still gets an answer, it does not hang');
chain.ws.close();

// --- 6. detach ---------------------------------------------------------------
near.send({ t: 'forget', name: 'tidakada' });
m = await near.want('remotes');
check(m.t === 'error' && m.code === 'unknown_remote', `detaching one that does not exist -> ${m.code}`);

far.send({ t: 'kill', id: att.id });
await sleep(600);
far.ws.close();

near.send({ t: 'forget', name: 'jauh' });
m = await near.want('remotes');
check(m.t === 'remotes' && !m.remotes.some((r) => r.name === 'jauh'), 'the machine can be detached');
check(!nearCfg().includes(FAR_TOKEN), 'and its token really is gone from the config');

near.ws.close();
rmSync(FAR_BOX, { recursive: true, force: true });

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
