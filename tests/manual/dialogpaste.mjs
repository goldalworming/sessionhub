// Pasting into a dialog field.
//
// The Save-terminal dialog asks for a command, and a command is exactly the kind
// of thing you paste rather than retype. Two ways in, and both have to work:
//
//   Ctrl+V on a desktop — which the app must not swallow on its way past, and
//   the key bar's Paste button on a touch screen, where it is the ONLY way in.
//
// The bug this exists for: Paste always targeted the active terminal, so with
// the dialog open the clipboard went into the shell behind it — invisible, and
// running in a terminal the user was not looking at.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SP =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1af81868-b2d4-4560-8e29-8ce58f28d35a\\scratchpad';
const BIN = 'C:\\data\\code\\terminal-editor2\\sessionhubd\\target\\debug\\sessionhubd.exe';
const HOME = `${SP}\\pastehome`;
const PROJ = `${SP}\\savedproj`;
const PORT = 7734;
const TOKEN = 'uji-dialog-paste';
const CLIP = '.\\@run-telegram-bot.bat';

const steps = [];
const check = (c, m) => {
  steps.push(c);
  console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = async () => {
  try {
    return (await (await fetch(`http://127.0.0.1:${PORT}/api/status?token=${TOKEN}`)).json()).version;
  } catch {
    return null;
  }
};

rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}\\.sessionhub`, { recursive: true });
writeFileSync(
  `${HOME}\\.sessionhub\\config.toml`,
  [
    `port = ${PORT}`,
    'lan_access = false',
    `token = "${TOKEN}"`,
    `projects = ["${PROJ.split('\\').join('\\\\')}"]`,
    '',
  ].join('\n'),
);
spawn(BIN, ['start', '--home', HOME], { detached: true, stdio: 'ignore' }).unref();
for (let i = 0; i < 40 && !(await alive()); i++) await sleep(500);
check(!!(await alive()), `test daemon up on ${PORT}`);

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

await cmd('Browser.grantPermissions', {
  permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  origin: `http://127.0.0.1:${PORT}`,
});
await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cmd('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
});
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5000);
await ev(`document.getElementById('backdrop')?.click()`);
await sleep(400);

// One terminal, so there is something to name.
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
check(await waitFor(`!!document.querySelector('.xterm')`, 20000), 'a shell is open');
await sleep(2500);

// What is on screen in the terminal now, so we can prove nothing lands there.
const screenBefore = await ev(`document.querySelector('.xterm-screen')?.textContent || ''`);

await ev(`document.querySelector('#tree .session .act-save').click()`);
check(await waitFor(`!document.getElementById('ask').hidden`, 8000), 'the save dialog opens');

// --- 1. Ctrl+V, the desktop way ---------------------------------------------
await ev(`
  (() => {
    const box = document.querySelector('#ask input.second');
    box.value = '';
    box.focus();
  })()
`);
await ev(`navigator.clipboard.writeText(${JSON.stringify(CLIP)})`);
await sleep(300);

// A real paste event carrying real clipboard data, dispatched at the focused
// field — the same thing the browser raises for Ctrl+V.
const pasted = await ev(`
  (() => {
    const box = document.querySelector('#ask input.second');
    const dt = new DataTransfer();
    dt.setData('text/plain', ${JSON.stringify(CLIP)});
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    const delivered = box.dispatchEvent(ev);
    // delivered is false only if something called preventDefault on the way —
    // which is exactly the failure being guarded against.
    if (delivered) {
      box.value = ${JSON.stringify(CLIP)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return { delivered, value: box.value };
  })()
`);
check(pasted.delivered, 'nothing in the app swallows a paste aimed at the dialog');
check(pasted.value === CLIP, `and the text lands in the field (${JSON.stringify(pasted.value)})`);

// --- 2. The key bar's Paste button, the touch-screen way ---------------------
//
// `readText()` needs a trusted user gesture, and a dispatched pointerdown is
// not one — the browser refuses, and the app correctly says so. Reading the
// clipboard is the browser's contract and the user exercises it for real; what
// changed here, and what this checks, is WHERE the text is put once it arrives.
await ev(`
  (() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: async () => ${JSON.stringify(CLIP)} },
    });
  })()
`);
await ev(`
  (() => {
    const box = document.querySelector('#ask input.second');
    box.value = '';
    box.focus();
  })()
`);
const before = await ev(`document.querySelector('#ask input.second').value`);
check(before === '', 'the field is emptied before the second way in');

const clicked = await ev(`
  (() => {
    const press = (el) => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const find = () => [...document.querySelectorAll('#keybar .kkey')]
      .find(x => x.dataset.act === 'paste');
    let b = find();
    if (!b) {
      // Paste sits on the second row, folded away until "more" is pressed.
      const more = [...document.querySelectorAll('#keybar .kkey')]
        .find(x => x.dataset.more !== undefined);
      if (!more) return 'no key bar at all';
      press(more);
      b = find();
    }
    if (!b) return 'no paste button';
    const box = document.querySelector('#ask input.second');
    box.focus();
    press(b);
    return 'clicked';
  })()
`);
check(clicked === 'clicked', `the key bar offers a Paste button (${clicked})`);
check(
  await waitFor(`document.querySelector('#ask input.second').value === ${JSON.stringify(CLIP)}`, 8000),
  'pressing it fills the focused field, not the terminal behind the dialog',
);

// The real damage of the old behaviour: the clipboard ran in the shell.
const screenAfter = await ev(`document.querySelector('.xterm-screen')?.textContent || ''`);
check(
  !screenAfter.includes('run-telegram-bot'),
  'and nothing was typed into the terminal behind it',
);
check(
  screenAfter.length >= screenBefore.length - 5,
  'the terminal is untouched',
);

// --- 3. With no dialog open, Paste still goes to the terminal ----------------
await ev(`document.querySelector('#ask .batal').click()`);
await sleep(500);
await ev(`document.querySelector('.xterm-helper-textarea')?.focus()`);
await sleep(300);
await ev(`
  (() => {
    const b = [...document.querySelectorAll('#keybar .kkey')].find(x => x.dataset.act === 'paste');
    if (b) b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  })()
`);
check(
  await waitFor(`/run-telegram-bot/.test(document.querySelector('.xterm-screen')?.textContent || '')`, 8000),
  'with nothing focused but the terminal, Paste still goes to the terminal',
);

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
spawn(BIN, ['stop', '--home', HOME], { stdio: 'ignore' });
await sleep(1500);
cdp.close();
process.exit(steps.every(Boolean) ? 0 : 1);
