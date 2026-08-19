// Naming a terminal so it outlives the daemon.
//
// The whole point of this feature is what happens across a restart, so that is
// what is exercised here: a real shell is opened, a real script typed into it,
// the terminal named, the daemon stopped and started again — and then the saved
// row is clicked and the script has to actually run.
//
// Nothing is stubbed. The daemon under test is a separate one, on its own port
// and its own home, so the user's own terminals are never touched.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1af81868-b2d4-4560-8e29-8ce58f28d35a\\scratchpad';
const BIN = 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\savedhome`;
const PROJ = `${SP}\\savedproj`;
const CFG = `${HOME}\\.sessionhub\\config.toml`;
const TRACE = `${PROJ}\\jejak.txt`;
const PORT = 7726;
const TOKEN = 'uji-saved-terminal';

const steps = [];
const check = (c, m) => {
  steps.push(c);
  console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/status?token=${TOKEN}`);
    return (await r.json()).version;
  } catch {
    return null;
  }
};

const startDaemon = async () => {
  spawn(BIN, ['start', '--home', HOME], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40 && !(await alive()); i++) await sleep(500);
  return await alive();
};
const stopDaemon = async () => {
  spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
  for (let i = 0; i < 30 && (await alive()); i++) await sleep(500);
  return !(await alive());
};

// ------------------------------------------------------------------ CDP setup

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => {
  cdp.onopen = r;
});
let seq = 0;
const pending = new Map();
cdp.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const cmd = (method, params = {}) => {
  const i = ++seq;
  cdp.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pending.set(i, r));
};
const ev = async (e) =>
  (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))
    .result?.result?.value;
const waitFor = async (expr, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(expr)) return true;
    await sleep(250);
  }
  return false;
};

/// The row for one named terminal, picked by the name it shows rather than by
/// being first in the list.
const ROW = (name) =>
  `[...document.querySelectorAll('#tree .session')]` +
  `.find(r => r.querySelector('.stitle')?.textContent === ${JSON.stringify(name)})`;

/// Real keystrokes into the focused terminal, not a shortcut through the app's
/// own send function — the daemon has to see what a person's typing looks like.
const type = async (text) => {
  for (const ch of text) {
    await cmd('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
};
const pressEnter = async () => {
  await cmd('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    text: '\r',
  });
  await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
};

// ------------------------------------------------------------------- the test

// A clean home every run. Left-over saved entries from an earlier run made an
// earlier version of this test pick "the first saved row" and get a different
// terminal than the one it went on to ask about — the test failed while the
// daemon was behaving correctly.
await stopDaemon();
const CFGDIR = `${HOME}\\.sessionhub`;
rmSync(CFGDIR, { recursive: true, force: true });
mkdirSync(CFGDIR, { recursive: true });
writeFileSync(
  CFG,
  [
    `port = ${PORT}`,
    'lan_access = false',
    `token = "${TOKEN}"`,
    // TOML needs each backslash doubled inside a basic string.
    `projects = ["${PROJ.split('\\').join('\\\\')}"]`,
    '',
  ].join('\n'),
);
rmSync(TRACE, { force: true });
const version = await startDaemon();
check(!!version, `test daemon up on ${PORT} (${version})`);

await cmd('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 820,
  deviceScaleFactor: 1,
  mobile: false,
});
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5000);
await ev(`document.getElementById('backdrop')?.click()`);
await sleep(400);

// 1. Open a plain shell in the project.
await ev(`
  (() => {
    const row = [...document.querySelectorAll('#tree .row')]
      .find(r => (r.dataset.path || '').toLowerCase().includes('savedproj'));
    row.querySelector('.add').click();
  })()
`);
await sleep(500);
await ev(`
  [...document.querySelectorAll('#menu > div')]
    .find(x => /terminal/i.test(x.textContent)).click()
`);
check(await waitFor(`!!document.querySelector('.xterm')`, 20000), 'a shell opens in the project');
await sleep(2500);

// 2. Type the script's name, as a person would.
await ev(`document.querySelector('.xterm-helper-textarea')?.focus()`);
await type('.\\@run-bot.bat');
await pressEnter();
check(
  await waitFor(`/service dimulai/.test(document.querySelector('.xterm-screen')?.textContent||'')`, 20000),
  'the script starts running in it',
);

// 3. Name it. The command box has to arrive already filled in.
await ev(`document.querySelector('.session.loose .act-save').click()`);
check(await waitFor(`!document.getElementById('ask').hidden`, 8000), 'the save dialog opens');
const prefilled = await ev(`document.querySelector('#ask input.second').value`);
check(
  prefilled === '.\\@run-bot.bat',
  `it already holds the command that was typed ("${prefilled}")`,
);

await ev(`
  (() => {
    const d = document.getElementById('ask');
    d.querySelector('input:not(.second)').value = 'bot uji';
    d.querySelector('.ok').click();
  })()
`);
await sleep(1200);

const cfgText = readFileSync(CFG, 'utf8');
check(/name = "bot uji"/.test(cfgText), 'it is written to config.toml, not just held in the page');
check(/@run-bot\.bat/.test(cfgText), 'and the command comes with it');
check(
  await waitFor(`/bot uji/.test(document.getElementById('tree').textContent)`, 8000),
  'the row now carries the name instead of "terminal 1"',
);

// 3b. A name belongs to one terminal at a time. Saving a second terminal under a
// name an older one already wears must take it off the older one — otherwise the
// sidebar draws the same row twice and clicking either is a coin toss. Found by
// looking at a screenshot, so it gets a test.
{
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  const msgs = [];
  await new Promise((r) => {
    ws.onopen = r;
  });
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') msgs.push(JSON.parse(e.data));
  };
  ws.send(
    JSON.stringify({ t: 'spawn', project: PROJ, agent: 'terminal', resume: null, cols: 100, rows: 30 }),
  );
  await sleep(2500);
  const second = msgs.filter((m) => m.t === 'attached').pop().id;
  ws.send(
    JSON.stringify({ t: 'save_terminal', id: second, name: 'bot uji', command: '.\\@run-bot.bat' }),
  );
  await sleep(1000);
  msgs.length = 0;
  ws.send(JSON.stringify({ t: 'list' }));
  await sleep(800);
  const st = msgs.filter((m) => m.t === 'state').pop();
  const wearing = st.terminals.filter((t) => t.alive && t.name === 'bot uji');
  check(wearing.length === 1, `only one terminal wears the name (${wearing.length})`);
  check(wearing[0]?.id === second, 'and it is the one just saved, not the one before it');
  check(
    st.saved.filter((s) => s.name === 'bot uji').length === 1,
    'saving the same name again updates the entry instead of adding a second',
  );
  ws.send(JSON.stringify({ t: 'kill', id: second }));
  await sleep(1000);
  ws.close();
}

// 4. The point of the whole thing: stop the daemon and start it again.
check(await stopDaemon(), 'the daemon is stopped — every terminal in it dies');
rmSync(TRACE, { force: true });
check(!existsSync(TRACE), 'and the script it was running has left off');

const back = await startDaemon();
check(!!back, 'the daemon comes back');
await ev(`location.reload()`);
await sleep(5000);
await ev(`document.getElementById('backdrop')?.click()`);
await sleep(600);

check(
  await waitFor(`/bot uji/.test(document.getElementById('tree').textContent)`, 15000),
  'the saved terminal is still listed after the restart',
);
check(
  await ev(`!!document.querySelector('.session.saved')`),
  'shown as saved rather than as something still running',
);
const shownCmd = await ev(`document.querySelector('.session.saved .scmd')?.textContent`);
check(shownCmd === '.\\@run-bot.bat', `the row says what it will run ("${shownCmd}")`);

// 4b. The row has to fit a phone. A saved row carries more than any other — a
// name, an agent badge and a command — and the command is the part that grows
// without limit. Measured, not eyeballed: a settings panel once grew to 1100px
// inside a 420px viewport and every DOM-level test still passed.
await cmd('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 780,
  deviceScaleFactor: 2,
  mobile: true,
});
await ev(`location.reload()`);
await sleep(5000);
await waitFor(`!!document.querySelector('#tree .session.saved')`, 15000);
const fit = await ev(`
  (() => {
    const row = document.querySelector('#tree .session.saved');
    if (!row) return null;
    const r = row.getBoundingClientRect();
    const host = document.getElementById('sidebar').getBoundingClientRect();
    const cmdEl = row.querySelector('.scmd');
    return {
      rowRight: Math.round(r.right), hostRight: Math.round(host.right),
      rowWidth: Math.round(r.width), scrollW: row.scrollWidth,
      cmdRight: cmdEl ? Math.round(cmdEl.getBoundingClientRect().right) : 0,
      bodyScroll: document.body.scrollWidth, bodyClient: document.body.clientWidth,
    };
  })()
`);
console.log(`    phone: ${JSON.stringify(fit)}`);
check(
  fit && fit.rowRight <= fit.hostRight + 1,
  'on a 390px phone the saved row stays inside the drawer',
);
check(
  fit && fit.bodyScroll <= fit.bodyClient + 1,
  'and a long command does not push the page sideways',
);
const tap = await ev(`
  (() => {
    const b = document.querySelector('#tree .session.saved .act-forget').getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x) };
  })()
`);
check(tap.w >= 24 && tap.h >= 24, `its buttons are big enough to tap (${tap.w}×${tap.h})`);
check(tap.x > 0 && tap.x < 390, `and sit on screen (x=${tap.x})`);

await cmd('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 820,
  deviceScaleFactor: 1,
  mobile: false,
});
await ev(`location.reload()`);
await sleep(4500);
await ev(`document.getElementById('backdrop')?.click()`);
await sleep(500);
await waitFor(`!!document.querySelector('#tree .session.saved')`, 15000);

// 5. One click, and the script has to actually run.
await ev(`${ROW('bot uji')}.click()`);
check(
  await waitFor(`/service dimulai/.test(document.querySelector('.xterm-screen')?.textContent||'')`, 25000),
  'clicking it opens the shell and runs the command by itself',
);
check(existsSync(TRACE), 'the script really ran — it left its mark on disk');

// A bare filename is not something a shell will run from the current folder.
// Two real services were saved that way and quietly never started; the only
// clue was an error in a panel nobody had open.
{
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  const msgs = [];
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (e) => { if (typeof e.data === 'string') msgs.push(JSON.parse(e.data)); };
  await sleep(800);
  // A terminal of its own. Saving the RUNNING one under a second name would take
  // the first name off it — one name per terminal, by design — and every later
  // step here looks that first name up.
  ws.send(
    JSON.stringify({ t: 'spawn', project: PROJ, agent: 'terminal', resume: null, cols: 90, rows: 26 }),
  );
  await sleep(2500);
  const spare = msgs.filter((m) => m.t === 'attached').pop().id;
  ws.send(JSON.stringify({ t: 'save_terminal', id: spare, name: 'bare', command: '@run-bot.bat' }));
  await sleep(1200);
  msgs.length = 0;
  ws.send(JSON.stringify({ t: 'list' }));
  await sleep(800);
  const entry = msgs.filter((m) => m.t === 'state').pop().saved.find((s) => s.name === 'bare');
  check(
    entry?.command === '.\\@run-bot.bat',
    `a bare filename is stored the way the shell will actually run it (${JSON.stringify(entry?.command)})`,
  );
  ws.send(JSON.stringify({ t: 'forget_terminal', project: PROJ, name: 'bare' }));
  await sleep(400);
  ws.send(JSON.stringify({ t: 'kill', id: spare }));
  await sleep(1200);
  ws.close();
}

const liveCount = async () =>
  (await (await fetch(`http://127.0.0.1:${PORT}/api/status?token=${TOKEN}`)).json())
    .terminals_alive;
check((await liveCount()) === 1, 'exactly one terminal is running');

// 6. Asked to open it again while it is already running — which is what a second
// device does before the state broadcast reaches it — it must attach, not start
// the bot a second time on the same port.
const raw = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  raw.onopen = r;
});
raw.send(
  JSON.stringify({ t: 'open_saved', project: PROJ, name: 'bot uji', cols: 100, rows: 30 }),
);
await sleep(3000);
const after = await liveCount();
check(after === 1, `opening it again attaches instead of starting a second copy (${after})`);
// 7. Forgetting takes two clicks, so a mis-tap on a phone loses nothing.
//
// The kill goes over the protocol rather than through the sidebar's ✕: that
// button asks with `confirm()`, and a modal dialog freezes a CDP-driven page.
const tid = Number(await ev(`${ROW('bot uji')}?.dataset.tid`));
raw.send(JSON.stringify({ t: 'kill', id: tid }));
await sleep(1500);
raw.close();
check(
  await waitFor(`!!document.querySelector('#tree .session.saved')`, 15000),
  'killing it puts the row back to saved-but-not-running',
);

await ev(`document.querySelector('.session.saved .act-forget').click()`);
await sleep(500);
check(
  /name = "bot uji"/.test(readFileSync(CFG, 'utf8')),
  'one click on ✕ forgets nothing — it only arms',
);
check(
  await ev(`document.querySelector('.session.saved .act-forget').classList.contains('armed')`),
  'and says so',
);
await ev(`document.querySelector('.session.saved .act-forget').click()`);
await sleep(800);
check(
  !/name = "bot uji"/.test(readFileSync(CFG, 'utf8')),
  'the second click removes it from config.toml',
);

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
await stopDaemon();
cdp.close();
process.exit(steps.every(Boolean) ? 0 : 1);
