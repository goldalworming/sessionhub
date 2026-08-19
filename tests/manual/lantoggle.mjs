// The "Network access" toggle in the Settings panel. What is being tested: the
// second listener really is opened and closed while the daemon is running,
// loopback is left untouched, a running terminal does not get killed along with
// it, and the setting is persisted.
//
// Start the test daemon first:
//   sessionhubd --home <scratchpad>\fakehome start --foreground

import { readFileSync } from 'node:fs';

const PORT = 7719;
const CFG =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome\\.sessionhub\\config.toml';
const PROJECT = 'C:\\data\\code\\terminal-editor2';

const steps = [];
const ok = (m) => { steps.push(['ok', m]); console.log('  [ ok ] ' + m); };
const bad = (m) => { steps.push(['FAIL', m]); console.log('  [FAIL] ' + m); };

// Safety catch: this script writes to a config, so make sure it targets the test one.
const text0 = readFileSync(CFG, 'utf8');
if (!CFG.includes('fakehome')) {
  console.error('ABORT: the target is not the test config.');
  process.exit(1);
}
const TOKEN = /token\s*=\s*"([^"]+)"/.exec(text0)[1];

const cfgText = () => readFileSync(CFG, 'utf8');
const lanInFile = () => /lan_access\s*=\s*true/.test(cfgText());

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status;
  } catch {
    return null;
  }
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
ws.binaryType = 'arraybuffer';
const send = (o) => ws.send(JSON.stringify(o));

let termId = null;
let bytesBefore = 0;
let bytesAfter = null;
const configs = [];
const errors = [];
let resolveConfig = null;

const nextConfig = () =>
  new Promise((res) => {
    resolveConfig = res;
  });

const timer = setTimeout(() => { bad('timeout'); ws.close(); }, 60000);

ws.onmessage = (ev) => {
  if (typeof ev.data !== 'string') {
    if (bytesAfter !== null) bytesAfter += ev.data.byteLength;
    else bytesBefore += ev.data.byteLength;
    return;
  }
  const msg = JSON.parse(ev.data);
  if (msg.t === 'config') {
    configs.push(msg);
    if (resolveConfig) { const r = resolveConfig; resolveConfig = null; r(msg); }
  } else if (msg.t === 'attached') {
    termId = msg.id;
  } else if (msg.t === 'error') {
    errors.push(msg);
  }
};

await new Promise((res) => { ws.onopen = res; });

// --- 1. the initial state --------------------------------------------------
send({ t: 'config' });
let cfg = await nextConfig();
const startedOn = cfg.lan_access;
if (typeof cfg.lan_access === 'boolean') ok(`config carries lan_access=${cfg.lan_access}`);
else bad('the config message has no lan_access');

// A live terminal, to prove that switching network access on and off does not
// disturb it.
send({ t: 'spawn', project: PROJECT, agent: 'shell', resume: null, cols: 80, rows: 24 });
await new Promise((r) => setTimeout(r, 2500));
if (termId !== null && bytesBefore > 0) ok(`the test terminal is alive (id=${termId}, ${bytesBefore} B out)`);
else bad('the test terminal never came up');

// --- 2. switch it off first, whatever the initial state was ----------------
if (startedOn) {
  send({ t: 'set_lan_access', enabled: false });
  cfg = await nextConfig();
}
if (!cfg.lan_access && !cfg.lan_url) ok('network access is off: the config offers no URL');
else bad(`still on: lan_access=${cfg.lan_access} url=${cfg.lan_url}`);
if (!lanInFile()) ok('config.toml stores lan_access = false');
else bad('config.toml is still true');

// --- 3. switch it on -------------------------------------------------------
send({ t: 'set_lan_access', enabled: true });
cfg = await nextConfig();
if (cfg.lan_access && cfg.lan_url) ok(`network access is on: ${cfg.lan_url}`);
else bad(`failed to switch on: ${JSON.stringify(cfg.lan_access)} ${cfg.lan_url}`);

if (cfg.lan_url && cfg.lan_url.includes(`:${PORT}/`)) ok('the URL uses the same daemon port');
else bad(`the URL does not use port ${PORT}: ${cfg.lan_url}`);
if (cfg.lan_url && cfg.lan_url.includes(TOKEN)) ok('the URL already includes the token');
else bad('the URL has no token');

if (lanInFile()) ok('config.toml stores lan_access = true');
else bad('config.toml did not change along with it');

const codeOn = cfg.lan_url ? await reachable(cfg.lan_url) : null;
if (codeOn === 200) ok('the network address answers 200 without restarting the daemon');
else bad(`the network address answers ${codeOn}`);

// --- 4. switch it off again, and the address must really be closed ---------
const lanUrl = cfg.lan_url;
send({ t: 'set_lan_access', enabled: false });
cfg = await nextConfig();
await new Promise((r) => setTimeout(r, 500));

const codeOff = await reachable(lanUrl);
if (codeOff === null) ok('once switched off, the network address no longer answers');
else bad(`the network address still answers ${codeOff}`);

const loop = await reachable(`http://127.0.0.1:${PORT}/?token=${TOKEN}`);
if (loop === 200) ok('loopback was left untouched throughout the test (200)');
else bad(`loopback got disturbed too: ${loop}`);

// --- 5. the terminal must still be alive ------------------------------------
bytesAfter = 0;
const frame = Buffer.alloc(4 + 24);
frame.writeUInt32LE(termId, 0);
Buffer.from('echo ("HI"+"DUP")\r', 'utf8').copy(frame, 4);
ws.send(frame.subarray(0, 4 + Buffer.from('echo ("HI"+"DUP")\r', 'utf8').length));
await new Promise((r) => setTimeout(r, 2000));
if (bytesAfter > 0) ok(`the terminal still answers after the toggle was used (${bytesAfter} B)`);
else bad('the terminal stopped answering — flipping the toggle cut the session');

if (!errors.length) ok('no error messages throughout the test');
else bad(`error: ${errors.map((e) => e.code).join(', ')}`);

// --- 6. put things back the way they were ----------------------------------
send({ t: 'kill', id: termId });
if (startedOn) {
  send({ t: 'set_lan_access', enabled: true });
  await nextConfig();
}
await new Promise((r) => setTimeout(r, 500));
clearTimeout(timer);
ws.close();

const failed = steps.filter((s) => s[0] === 'FAIL').length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
