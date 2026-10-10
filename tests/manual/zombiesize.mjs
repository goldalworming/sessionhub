// A page that reconnects replaces its old socket at once. Through a tunnel a
// phone's dropped socket can stay "attached" for minutes, holding the terminal
// at the size it had — half a screen with the keyboard up. The same page
// coming back must drop it; a different page must still count.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad';
const BIN = process.env.SH_BIN || 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\zombiehome`;
const PROJ = `${SP}\\zombieproj`;
const PORT = 7775;
const TOKEN = 'uji-zombie';

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
mkdirSync(PROJ, { recursive: true });
writeFileSync(`${HOME}\\.sessionhub\\config.toml`,
  `port = ${PORT}\nlan_access = false\ntoken = "${TOKEN}"\nremote_commands = true\nprojects = ['${PROJ}']\n`);
const daemon = spawn(BIN, ['start', '--foreground', '--no-open', '--no-tray', '--home', HOME], { stdio: 'ignore' });
await sleep(3000);
const cli = (...a) => spawnSync(BIN, [...a, '--home', HOME], { encoding: 'utf8' });
const id = Number(cli('spawn', '--agent', 'terminal', '--project', PROJ, '--name', 'z').stdout.trim());
const rows = () => JSON.parse(cli('ls', '--json').stdout).find((t) => t.id === id).rows;

async function socket(page) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}${page ? `&page=${page}` : ''}`);
  await new Promise((r) => { ws.onopen = r; });
  return {
    attach: (r) => ws.send(JSON.stringify({ t: 'attach', id, cols: 66, rows: r })),
    send: (o) => ws.send(JSON.stringify(o)),
    close: () => ws.close(),
  };
}

// The phone, keyboard up.
const zombie = await socket('aaaaaaaaaaaaaaaa');
zombie.attach(22);
await sleep(800);
check(rows() === 22, `keyboard up: 22 rows (${rows()})`);

// Its link drops without the daemon hearing of it (the old socket is left
// open), and the same page comes back with the keyboard down.
const back = await socket('aaaaaaaaaaaaaaaa');
back.attach(41);
await sleep(800);
check(rows() === 41, `the same page back, keyboard down: 41 rows straight away (${rows()})`);

// Another page — a second device — is a real viewer and still counts.
const other = await socket('bbbbbbbbbbbbbbbb');
other.attach(30);
await sleep(800);
check(rows() === 30, `a different page that is smaller still wins (${rows()})`);

// And a socket that names no page is left alone, as before.
const plain = await socket('');
plain.attach(25);
await sleep(500);
const plain2 = await socket('');
plain2.attach(45);
await sleep(800);
check(rows() === 25, `sockets without a page are never taken for each other (${rows()})`);

// A page in the background — another tab on the phone, frozen by the browser
// with its socket open — stops counting once it says it is out of view.
for (const s of [zombie, back, other, plain, plain2]) s.close();
await sleep(800);
const bgTab = await socket('cccccccccccccccc');
bgTab.attach(22);
await sleep(600);
const looking = await socket('dddddddddddddddd');
looking.attach(41);
await sleep(600);
check(rows() === 22, `two pages on screen: the smaller, 22 (${rows()})`);
bgTab.send({ t: 'visibility', visible: false });
await sleep(800);
check(rows() === 22, `the background tab hides: no jump at once, the grace applies (${rows()})`);
await sleep(31000);
check(rows() === 41, `after the grace, the page being looked at gets its full height (${rows()})`);
bgTab.send({ t: 'visibility', visible: true });
await sleep(800);
check(rows() === 22, `the tab comes back on screen: it counts again at once (${rows()})`);
bgTab.send({ t: 'visibility', visible: false });
const late = await socket('eeeeeeeeeeeeeeee');
late.attach(41);
await sleep(800);
check(rows() === 41, `a page attaching while the other is hidden gets its size straight away (${rows()})`);
for (const s of [bgTab, looking, late]) s.close();
cli('stop');
daemon.kill();
console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
