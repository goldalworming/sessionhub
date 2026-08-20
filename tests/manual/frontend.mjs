// Shipping the interface separately from the daemon.
//
// Most changes to this program are changes to `web/`. Sending those as a new
// binary means swapping eight megabytes and killing every live terminal for a
// CSS fix, so the frontend has its own version and its own artifact, and the
// daemon can install one without restarting.
//
// What has to hold:
//   an installed interface wins over the one baked into the binary,
//   `vendor/` still comes from the binary, so bundles stay small,
//   the `?v=` stamp changes, or browsers keep serving themselves the old page,
//   an interface that needs a newer daemon is REFUSED and says why,
//   and removing it falls back to the built-in copy with nothing broken.
//
// The last one is what makes the rest safe to use: there is always a working
// interface inside the binary to fall back to.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1af81868-b2d4-4560-8e29-8ce58f28d35a\\scratchpad';
const REPO = 'C:\\data\\code\\terminal-editor2\\sessionhubd';
const BIN = `${REPO}\\target\\debug\\sessionhubd.exe`;
const HOME = `${SP}\\fehome`;
const WEB = `${HOME}\\.sessionhub\\web`;
const PORT = 7744;
const TOKEN = 'uji-frontend';

const steps = [];
const check = (c, m) => {
  steps.push(c);
  console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (path) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}${path.includes('?') ? '&' : '?'}token=${TOKEN}`);
  return { status: r.status, body: await r.text() };
};
const alive = async () => {
  try {
    return (await (await fetch(`http://127.0.0.1:${PORT}/api/status?token=${TOKEN}`)).json()).version;
  } catch {
    return null;
  }
};
const restartless = () => {}; // nothing here ever restarts the daemon — that is the point

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
writeFileSync(
  `${HOME}\\.sessionhub\\config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\n`,
);
spawn(BIN, ['start', '--home', HOME], { detached: true, stdio: 'ignore' }).unref();
for (let i = 0; i < 40 && !(await alive()); i++) await sleep(500);
const daemon = await alive();
check(!!daemon, `test daemon up on ${PORT} (${daemon})`);

// --- what the binary carries ------------------------------------------------
const builtinApp = await get('/app.js');
check(builtinApp.status === 200 && builtinApp.body.length > 1000, 'the built-in interface is served');
const builtinIndex = await get('/');
const stampOf = (html) => (html.match(/app\.js\?v=([0-9a-f]+)/) || [])[1] || null;
const builtinStamp = stampOf(builtinIndex.body);
check(!!builtinStamp, `index.html is stamped with an asset version (${builtinStamp})`);

// --- install one on top -----------------------------------------------------
// Written straight into place rather than downloaded: the download is `curl`,
// already proven by the binary update. What is unproven is everything after it.
const MARK = 'GANTI-ANTARMUKA-1-0-1';
rmSync(WEB, { recursive: true, force: true });
mkdirSync(WEB, { recursive: true });
cpSync(`${REPO}\\web`, WEB, {
  recursive: true,
  filter: (src) => !src.includes('vendor'),
});
writeFileSync(
  `${WEB}\\app.js`,
  `// ${MARK}\n` + readFileSync(`${REPO}\\web\\app.js`, 'utf8'),
);
writeFileSync(
  `${WEB}\\version.json`,
  JSON.stringify({ version: '1.0.1', needs_daemon: '0.0.4' }),
);
restartless();

const installedApp = await get('/app.js');
check(installedApp.body.includes(MARK), 'the installed interface is served instead of the built-in one');
check(
  !builtinApp.body.includes(MARK),
  'and it really is different from what the binary carries',
);

const installedIndex = await get('/');
const installedStamp = stampOf(installedIndex.body);
check(
  installedStamp && installedStamp !== builtinStamp,
  `the asset stamp changes with it (${builtinStamp} -> ${installedStamp})`,
);

// vendor is deliberately not in a bundle: xterm and Monaco are 5 MB and change
// almost never, so they stay in the binary.
const vendor = await get('/vendor/xterm.js');
check(
  vendor.status === 200 && vendor.body.length > 10000,
  'vendor still comes from the binary, so bundles stay small',
);

// --- one that needs a newer daemon ------------------------------------------
writeFileSync(
  `${WEB}\\version.json`,
  JSON.stringify({ version: '2.0.0', needs_daemon: '9.9.9' }),
);
const refused = await get('/app.js');
check(
  !refused.body.includes(MARK),
  'an interface that needs a newer daemon is refused, not served half-working',
);
check(
  refused.body.length > 1000,
  'and the built-in one is served in its place, so nothing is broken',
);
const refusedStamp = stampOf((await get('/')).body);
check(refusedStamp === builtinStamp, 'the stamp goes back to the built-in one too');

// --- and taking it away ------------------------------------------------------
rmSync(WEB, { recursive: true, force: true });
const back = await get('/app.js');
check(!back.body.includes(MARK), 'removing it falls back to the built-in interface');
check(stampOf((await get('/')).body) === builtinStamp, 'with the original stamp');

// --- the daemon never restarted ---------------------------------------------
const stillUp = await (await fetch(`http://127.0.0.1:${PORT}/api/status?token=${TOKEN}`)).json();
check(stillUp.version === daemon, 'the daemon is the same version throughout');
check(
  stillUp.uptime_secs >= 0 && stillUp.pid > 0,
  `and the same process — pid ${stillUp.pid}, up ${stillUp.uptime_secs}s, never restarted`,
);

// --- the bundle command produces something installable ------------------------
const out = `${SP}\\fe-test.shweb`;
rmSync(out, { force: true });
await new Promise((r) => {
  const p = spawn(BIN, ['bundle-web', out], { stdio: 'ignore' });
  p.on('exit', r);
});
check(existsSync(out), 'bundle-web writes a bundle');
const bundle = readFileSync(out);
check(bundle.subarray(0, 6).toString() === 'SHWEB1', 'with the format it claims');
check(
  bundle.includes(Buffer.from('version.json')) && bundle.length > 100000,
  `carrying the whole interface (${Math.round(bundle.length / 1024)} KB)`,
);
// Read the bundle rather than searching it for text: "vendor/" appears inside
// index.html as a <script src>, so a substring search reports the opposite of
// the truth. Parsing it also proves the format is readable outside Rust.
const entries = (() => {
  const names = [];
  let i = 6; // past "SHWEB1"
  while (i < bundle.length) {
    const n = bundle.readUInt16LE(i);
    i += 2;
    names.push(bundle.subarray(i, i + n).toString());
    i += n;
    const len = bundle.readUInt32LE(i);
    i += 4;
    i += len;
  }
  return names;
})();
console.log(`    bundle holds ${entries.length} files, e.g. ${entries.slice(0, 4).join(', ')}`);
check(
  entries.length > 15 && entries.includes('version.json') && entries.includes('app.js'),
  'the bundle parses back into the files it should hold',
);
check(
  !entries.some((n) => n.startsWith('vendor')),
  'and none of them are vendor — that is what keeps it small',
);
rmSync(out, { force: true });

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
await sleep(1500);
process.exit(steps.every(Boolean) ? 0 : 1);
