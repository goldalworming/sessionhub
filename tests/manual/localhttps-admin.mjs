// The real administrator step, by hand: needs someone to accept two UAC
// prompts. Uses a made-up hostname so nothing real is redirected.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\lh2home`;
const PROJ = `${SP}\\lh2proj`;
const PORT = 7795;
const TOKEN = 'uji-lh2';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(`${HOME}\\.sessionhub\\config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nremote_commands = true\nprojects = ['${PROJ}']\n` +
  `[cloudflare]\napi_token = "x"\nzone_id = "z"\nzone_name = "example.com"\naccount_id = "a"\ntunnel_id = "t"\ntunnel_name = "dev"\n`);
// The hostname as Cloudflare would have answered it, fresh, so nothing is asked.
writeFileSync(`${HOME}\\.sessionhub\\public-host`, `${PORT} sbox-uji.example.com\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3000);
const cli = (...a) => spawnSync(BIN, [...a, '--home', HOME], { encoding: 'utf8' });

const hostsFile = 'C:/Windows/System32/drivers/etc/hosts';
const inHosts = () => readFileSync(hostsFile, 'utf8').split('\n').some((l) => /^127\.0\.0\.1\s+sbox-uji\.example\.com\s/.test(l));
const trusted = () => spawnSync('certutil', ['-verifystore', 'Root', 'sessionhub local sbox-uji.example.com'], { encoding: 'utf8' }).status === 0;
const ask = (on) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'local_https', on }));
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    const m = JSON.parse(e.data);
    if (m.t === 'local_https' || (m.t === 'error' && m.code === 'local_https_failed')) { ws.close(); resolve(m); }
  };
});
const before = inHosts();
const up = await ask(true);
console.log('    answer:', JSON.stringify(up));
check(inHosts(), 'the hosts file now sends the name here');
check(trusted(), 'and the certificate is among the trusted roots');
check(up.t === 'error' ? /443/.test(up.message) : up.local_https?.on === true, 'and it answers (port 443 being taken is said plainly)');
const down = await ask(false);
console.log('    answer:', JSON.stringify(down));
check(!inHosts(), 'turning it off takes the hosts line out');
check(!trusted(), 'and the certificate');
check(!before, '(the line was not there before)');
cli('stop');
daemon.kill();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
