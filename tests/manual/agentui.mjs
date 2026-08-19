// Adding and removing agents from the Settings panel.
// Needs Chrome with --remote-debugging-port=9222 and the test daemon on 7719.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 7719;
const HOME =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome';
const CFG = join(HOME, '.sessionhub', 'config.toml');
const TOKEN = /token\s*=\s*"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cfgText = () => readFileSync(CFG, 'utf8');

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const cmd = (method, params = {}) => {
  const i = ++seq;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pending.set(i, r));
};
const ev = async (e) =>
  (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))
    .result?.result?.value;

await cmd('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.setItem('sh.theme','light'); localStorage.setItem('sh.sidebar.hidden','0')`);
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5000);

await ev(`document.getElementById('settings-btn').click()`);
/// Agents sit behind the rail; the section that opens first is Network.
const openAgents = () =>
  ev(`document.querySelector('#settings .sitem[data-section="agents"]')?.click()`);
const waitRows = async (ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await openAgents();
    if (await ev(`document.querySelectorAll('#settings .agent').length > 1`)) return true;
    await sleep(200);
  }
  return false;
};
/// Open one agent row; while it is closed, its body is not drawn at all.
const expandAgent = (name) =>
  ev(`
    (() => {
      const r = [...document.querySelectorAll('#settings .agent')]
        .find(a => a.querySelector('.aname')?.textContent === ${JSON.stringify(name)});
      if (r && !r.classList.contains('open')) r.querySelector('.ahead').click();
      return !!r;
    })()
  `);
/// The add form is no longer always open — it sits behind a button.
const openAddForm = async () => {
  await ev(`
    (() => {
      const b = [...document.querySelectorAll('#settings .addbtn')]
        .find(x => /Add an agent/.test(x.textContent));
      if (b) b.click();
    })()
  `);
  await sleep(400);
};
check(await waitRows(), 'the Settings panel loads the agent list');

const path2 = await ev(`document.querySelector('.shead .path').textContent`);
if (!path2.includes('fakehome')) { console.log(`  [ABORT] pointing at the real config: ${path2}`); process.exit(2); }

// --- 1. the add form ---------------------------------------------------------
await openAddForm();
const form = await ev(`
  (() => {
    const b = document.querySelector('.addrow');
    if (!b) return null;
    return {
      judul: b.querySelector('.aname').textContent,
      label: [...b.querySelectorAll('label')].map(l => l.textContent),
      isi: [...b.querySelectorAll('input')].map(i => i.placeholder),
      tombol: b.querySelector('.addbtn')?.textContent,
      terakhir: b === document.querySelector('#settings .sec.agents').lastElementChild,
    };
  })()
`);
check(!!form, 'there is an add-agent form in the panel');
check(form?.judul === 'Add an agent', `its title is plain ("${form?.judul}")`);
check(form?.terakhir, 'it sits below the agent list rather than cutting into it');
check(
  ['Name', 'Command', 'Resume args', 'Fork args'].every((l) => form.label.includes(l)),
  `four fields are available: ${form.label.join(', ')}`,
);
check(form.isi.some((p) => /cannot fork/.test(p)), 'the fork field explains what leaving it empty means');
check(form.isi.some((p) => /just opens a shell/.test(p)), 'the resume field explains what leaving it empty means');

// --- 2. adding a real agent -------------------------------------------------
const fill = (n, v) => `
  (() => {
    const i = document.querySelectorAll('#settings .addrow input')[${n}];
    i.value = ${JSON.stringify(v)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`;
await ev(fill(0, 'uicoder'));
await ev(fill(1, 'cmd.exe'));
await ev(fill(2, '--resume {session_id}'));
await ev(fill(3, '--resume {session_id} --fork'));
await ev(`document.querySelector('#settings .addrow .addbtn').click()`);
await sleep(2000);

check(/\[agents\.uicoder\]/.test(cfgText()), 'the new agent is written into config.toml');
await expandAgent('uicoder');
await sleep(400);
const created = await ev(`
  (() => {
    const rows = [...document.querySelectorAll('#settings .agent')];
    const r = rows.find(x => x.querySelector('.aname')?.textContent === 'uicoder');
    if (!r) return null;
    const inputs = [...r.querySelectorAll('.abody input[type=text]')].map(i => i.value);
    return {
      inputs,
      status: r.querySelector('.awhere').textContent,
      buruk: r.querySelector('.adot').classList.contains('bad'),
    };
  })()
`);
check(!!created, 'its row turns up in the list straight away');
check(created?.inputs.includes('cmd.exe'), 'its command is stored');
check(created?.inputs.some((v) => v.includes('--fork')), 'the fork args are stored and can be edited again');
check(created && !created.buruk && /cmd\.exe/i.test(created.status), `its command is checked against PATH straight away: ${created?.status}`);

check(
  await ev(`!document.querySelector('#settings .addrow')`),
  'the form closes itself once it succeeds, leaving no empty fields behind',
);
await openAddForm();
const empty = await ev(`[...document.querySelectorAll('#settings .addrow input')].every(i => i.value === '')`);
check(empty, 'opened again, its fields are clean for the next agent');

// --- 3. refusals that are plain ----------------------------------------------
await ev(fill(0, 'uicoder'));
await ev(fill(1, 'cmd.exe'));
await ev(`document.querySelector('#settings .addrow .addbtn').click()`);
await sleep(500);
let message = await ev(`document.querySelector('#settings .addrow .sstat').textContent`);
check(/already an agent/.test(message), `a duplicate name is refused on the spot: "${message}"`);

await ev(fill(0, 'kosongan'));
await ev(fill(1, ''));
await ev(`document.querySelector('#settings .addrow .addbtn').click()`);
await sleep(500);
message = await ev(`document.querySelector('#settings .addrow .sstat').textContent`);
check(/name and a command/.test(message), `an empty command is refused: "${message}"`);
check(!/\[agents\.kosongan\]/.test(cfgText()), 'what was refused is not written into the config');

// --- 4. the delete button takes two clicks ----------------------------------
const btnOf = (agentName) => `
  [...document.querySelectorAll('#settings .agent')]
    .find(x => x.querySelector('.aname')?.textContent === ${JSON.stringify(agentName)})
    ?.querySelector('.del')`;
await expandAgent('terminal');
await sleep(400);
check(await ev(`!${btnOf('terminal')}`), '`terminal` is given no delete button at all');
await expandAgent('uicoder');
await sleep(400);
check(await ev(`!!${btnOf('uicoder')}`), 'an ordinary agent does have a delete button');

await ev(`${btnOf('uicoder')}.click()`);
await sleep(300);
const armed = await ev(`
  (() => {
    const b = ${btnOf('uicoder')};
    return { teks: b.textContent, armed: b.classList.contains('armed') };
  })()
`);
check(/Click again/.test(armed.teks), `the first click only asks for confirmation ("${armed.teks}")`);
check(armed.armed, 'the button changes its look so that it is clear it awaits confirmation');
check(/\[agents\.uicoder\]/.test(cfgText()), 'nothing is deleted yet after the first click');

await ev(`${btnOf('uicoder')}.click()`);
await sleep(1800);
check(!/\[agents\.uicoder\]/.test(cfgText()), 'the second click really does delete it from config.toml');
check(await ev(`!${btnOf('uicoder')}`), 'its row disappears from the panel');

// --- 5. delete pi, which is not in use anyway -------------------------------
if (/\[agents\.pi\]/.test(cfgText())) {
  await expandAgent('pi');
  await sleep(400);
  await ev(`${btnOf('pi')}.click()`);
  await sleep(300);
  await ev(`${btnOf('pi')}.click()`);
  await sleep(1800);
  check(!/\[agents\.pi\]/.test(cfgText()), '`pi` can be deleted through the panel');
  await ev(`document.querySelector('#settings .close').click()`);
  await sleep(1200);
  await ev(`document.querySelector('.project .add').click()`);
  await sleep(800);
  const menu = await ev(`[...document.querySelectorAll('#menu div')].map(d => d.textContent)`);
  console.log(`  menu +: ${menu.join(' | ')}`);
  check(menu.length > 0, 'the new terminal menu really does open');
  check(!menu.some((m) => /\bpi\b/i.test(m)), 'and `pi` is no longer inside it');
  check(menu.some((m) => /claude/i.test(m)), 'while the other agents are still offered');
  await ev(`document.body.click()`);
  await sleep(400);

  // Put it back the way it was.
  await ev(`document.getElementById('settings-btn').click()`);
  await waitRows();
  await openAddForm();
  await ev(fill(0, 'pi'));
  await ev(fill(1, 'pi'));
  await ev(fill(2, '--session {session_id}'));
  await ev(`document.querySelector('#settings .addrow .addbtn').click()`);
  await sleep(1500);
  check(/\[agents\.pi\]/.test(cfgText()), '`pi` can be added again through that same form');
}

await ev(`document.querySelector('#settings .close')?.click()`);

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
