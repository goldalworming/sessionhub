// The scripted-control commands (ls/spawn/send/capture/wait) over HTTP, plus
// proof that a scripted spawn shows up live to a real WebSocket client — the
// same broadcast the browser gets — without that client doing anything.
// Run the test daemon at --home <scratchpad>\termtest_home first.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 7791;
const HOME =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2-sessionhubd\\' +
  'dc3f7268-dd21-4fc4-b388-8afd498cd912\\scratchpad\\termtest_home';
const CFG = join(HOME, '.sessionhub', 'config.toml');

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };

if (!CFG.includes('termtest_home')) { console.error('ABORT: not the test config.'); process.exit(1); }
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];
const base = `http://127.0.0.1:${PORT}`;
const q = (s) => encodeURIComponent(s);

// --- 0. a real WS client, exactly like the browser opens on load -------------
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
const states = [];
ws.onmessage = (e) => {
  if (typeof e.data !== 'string') return;
  const m = JSON.parse(e.data);
  if (m.t === 'state') states.push(m);
};
await new Promise((r) => { ws.onopen = r; });
await new Promise((r) => setTimeout(r, 200)); // the initial state on connect

// --- 1. spawn --------------------------------------------------------------
const name = `cli-test-${Date.now()}`;
const spawnRes = await fetch(
  `${base}/api/term/spawn?token=${TOKEN}&project=${q(HOME)}&agent=terminal&name=${q(name)}`,
  { method: 'PUT' },
);
check(spawnRes.status === 200, `spawn answers 200: ${spawnRes.status}`);
const { id } = await spawnRes.json();
check(Number.isInteger(id), `spawn returns a numeric id: ${id}`);

// --- 2. it reached the WS client on its own, unprompted ---------------------
await new Promise((r) => setTimeout(r, 300));
const broadcast = states.find((s) => s.terminals?.some((t) => t.id === id));
check(!!broadcast, 'the new terminal arrived in a State broadcast to an already-open WS client');
const infoInBroadcast = broadcast?.terminals.find((t) => t.id === id);
check(infoInBroadcast?.name === name, `the broadcast entry carries the live name: ${infoInBroadcast?.name}`);

// --- 3. spawning the same name again is refused, not silently duplicated ----
const dupe = await fetch(
  `${base}/api/term/spawn?token=${TOKEN}&project=${q(HOME)}&agent=terminal&name=${q(name)}`,
  { method: 'PUT' },
);
check(dupe.status === 400, `a taken name is refused: ${dupe.status}`);
const dupeBody = await dupe.json();
check(dupeBody.code === 'name_taken', `refusal names the reason: ${dupeBody.code}`);

// --- 4. ls shows it, by id and by name ---------------------------------------
const lsRes = await fetch(`${base}/api/term/ls?token=${TOKEN}`);
const list = await lsRes.json();
const mine = list.find((t) => t.id === id);
check(mine?.name === name && mine?.alive === true, 'ls lists the spawned terminal, alive, under its name');

// Poll capture until `pred` is true or the timeout elapses — the same shape
// as `sessionhubd wait`/`--verify`, and the settling pattern the README
// recommends between `spawn` and the first `send`.
async function captureUntil(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/term/capture?token=${TOKEN}&name=${q(name)}`);
    text = Buffer.from(await res.arrayBuffer()).toString('utf8');
    if (pred(text)) return text;
    await new Promise((r) => setTimeout(r, 150));
  }
  return text;
}

// --- 5. send delivers bytes verbatim; capture reads them back out -----------
// This endpoint does no framing of its own (see PROTOCOL.md) — `\r` here is
// standing in for the shell's own Enter key, not a bracketed-paste test. Real
// multi-line-as-one-message behaviour is a readline/ink concern inside an
// actual agent CLI and is out of reach of the plain `terminal` agent used
// here; see TESTING.md's manual checklist for that.
await captureUntil((t) => t.includes('PS '), 5000); // let PowerShell finish starting up first
const marker = `shtest-${id}`;
const sendRes = await fetch(`${base}/api/term/send?token=${TOKEN}&name=${q(name)}`, {
  method: 'PUT',
  body: `echo ${marker}\r`,
});
check(sendRes.status === 200, `send answers 200: ${sendRes.status}`);
const sendBody = await sendRes.json();
check(sendBody.id === id && sendBody.bytes > 0, `send reports the resolved id and byte count: ${JSON.stringify(sendBody)}`);

const capText = await captureUntil(
  (t) => (t.match(new RegExp(marker, 'g')) ?? []).length >= 2,
  5000,
);
check((capText.match(new RegExp(marker, 'g')) ?? []).length >= 2, 'capture shows what was sent, both typed and echoed back by the shell');

// --- 7. capture/send by unknown name is a clear 404, not a crash ------------
const missing = await fetch(`${base}/api/term/capture?token=${TOKEN}&name=${q('no-such-terminal')}`);
check(missing.status === 404, `an unknown name is a 404: ${missing.status}`);

// --- 8. remote commands off: spawn/send refused, ls/capture still allowed ---
ws.send(JSON.stringify({ t: 'set_remote_commands', enabled: false }));
await new Promise((r) => setTimeout(r, 200));
const gatedSpawn = await fetch(
  `${base}/api/term/spawn?token=${TOKEN}&project=${q(HOME)}&agent=terminal&name=${q(`${name}-2`)}`,
  { method: 'PUT' },
);
check(gatedSpawn.status === 403, `spawn is refused while remote commands are off: ${gatedSpawn.status}`);
const gatedSend = await fetch(`${base}/api/term/send?token=${TOKEN}&name=${q(name)}`, {
  method: 'PUT',
  body: 'echo blocked\r',
});
check(gatedSend.status === 403, `send is refused while remote commands are off: ${gatedSend.status}`);
const stillLs = await fetch(`${base}/api/term/ls?token=${TOKEN}`);
check(stillLs.status === 200, `ls still works while remote commands are off: ${stillLs.status}`);
const stillCapture = await fetch(`${base}/api/term/capture?token=${TOKEN}&name=${q(name)}`);
check(stillCapture.status === 200, `capture still works while remote commands are off: ${stillCapture.status}`);
ws.send(JSON.stringify({ t: 'set_remote_commands', enabled: true }));
await new Promise((r) => setTimeout(r, 200));

// --- 9. a killed terminal shows up as not alive — what `wait` polls for -----
ws.send(JSON.stringify({ t: 'kill', id }));
let exited = false;
const exitDeadline = Date.now() + 5000;
while (Date.now() < exitDeadline && !exited) {
  const l = await (await fetch(`${base}/api/term/ls?token=${TOKEN}`)).json();
  const t = l.find((x) => x.id === id);
  if (!t || t.alive === false) exited = true;
  else await new Promise((r) => setTimeout(r, 150));
}
check(exited, 'ls reports the killed terminal as no longer alive');

ws.close();

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
