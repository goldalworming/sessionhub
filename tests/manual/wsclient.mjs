// A test client for step 1: spawn -> echo -> resize -> kill.
// Run with the WebSocket built into Node 22+, with no dependency.

import { readFileSync } from 'node:fs';

const PORT = 7719;
// Read from the config rather than hard-coded: the daemon's token changes,
// and a stale copy here fails as "cannot connect", which says nothing about
// what this test is actually checking.
const TOKEN = /token *= *"([^"]+)"/.exec(
  readFileSync(
    'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome\\.sessionhub\\config.toml',
    'utf8',
  ),
)[1];
const PROJECT = 'C:\\data\\code\\terminal-editor2';

const steps = [];
const ok = (m) => { steps.push(['ok', m]); console.log('  [ ok ] ' + m); };
const bad = (m) => { steps.push(['FAIL', m]); console.log('  [FAIL] ' + m); };

function strip(s) {
  return s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
}

// --- 1. a wrong token must be a 401, with no upgrade -----------------------
async function testBadToken() {
  const res = await fetch(`http://127.0.0.1:${PORT}/`, { headers: {} });
  if (res.status === 401) ok('without a token -> 401'); else bad(`without a token -> ${res.status}`);

  const res2 = await fetch(`http://127.0.0.1:${PORT}/?token=salah`);
  if (res2.status === 401) ok('a wrong token -> 401'); else bad(`a wrong token -> ${res2.status}`);

  const res3 = await fetch(`http://127.0.0.1:${PORT}/?token=${TOKEN}`);
  if (res3.status === 200) ok('the right token -> 200'); else bad(`the right token -> ${res3.status}`);

  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=salah`);
    ws.onopen = () => { bad('a WS with a wrong token got upgraded anyway'); ws.close(); resolve(); };
    ws.onerror = () => { ok('a WS with a wrong token is refused before the upgrade'); resolve(); };
  });
}

// --- 2. the terminal flow --------------------------------------------------
function testTerminal() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    ws.binaryType = 'arraybuffer';

    let termId = null;
    let screen = '';
    let phase = 'awaiting-state';
    const seen = { attached: false, size: false, exit: false, sameId: true };
    const timer = setTimeout(() => { bad(`timeout in phase: ${phase}`); ws.close(); }, 40000);

    const sendJson = (o) => ws.send(JSON.stringify(o));
    const sendInput = (id, text) => {
      const body = Buffer.from(text, 'utf8');
      const frame = Buffer.alloc(4 + body.length);
      frame.writeUInt32LE(id, 0);
      body.copy(frame, 4);
      ws.send(frame);
    };

    ws.onopen = () => { /* the server sends state of its own accord */ };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        const buf = Buffer.from(ev.data);
        const id = buf.readUInt32LE(0);
        if (termId !== null && id !== termId) seen.sameId = false;
        screen += strip(buf.subarray(4).toString('utf8'));

        if (phase === 'awaiting-prompt' && /PS [A-Z]:/.test(screen)) {
          phase = 'awaiting-echo';
          screen = '';
          sendInput(termId, 'echo ("MA"+"RK1")\r');
        } else if (phase === 'awaiting-echo' && screen.includes('MARK1')) {
          ok('echo goes there and back over WS: input -> PTY -> output');
          phase = 'awaiting-initial-size';
          screen = '';
          sendInput(termId, 'Write-Host ("SI"+"ZE=" + $Host.UI.RawUI.WindowSize.Width + "x" + $Host.UI.RawUI.WindowSize.Height)\r');
        } else if (phase === 'awaiting-initial-size' && screen.includes('SIZE=80x24')) {
          ok('the PTY is opened at the size the client asked for (80x24)');
          phase = 'awaiting-resize';
          screen = '';
          sendJson({ t: 'resize', id: termId, cols: 100, rows: 30 });
          setTimeout(() => sendInput(termId, 'Write-Host ("SI"+"ZE=" + $Host.UI.RawUI.WindowSize.Width + "x" + $Host.UI.RawUI.WindowSize.Height)\r'), 400);
        } else if (phase === 'awaiting-resize' && screen.includes('SIZE=100x30')) {
          ok('a resize over WS reaches the child (100x30)');
          phase = 'awaiting-exit';
          sendJson({ t: 'kill', id: termId });
        }
        return;
      }

      const msg = JSON.parse(ev.data);
      if (msg.t === 'state') {
        if (phase === 'awaiting-state') {
          // "at least one, and the configured one is among them" rather than
          // "exactly one": the opencode CLI is not scoped by `--home`, so the
          // test daemon also discovers whatever opencode sessions exist on this
          // machine. That is real behaviour, not a fault of this test.
          if (msg.projects.some((p) => p.name === 'terminal-editor2')) {
            ok('the initial state is sent automatically, the project is read from the config');
          } else {
            bad('the initial state is wrong: ' + ev.data.slice(0, 120));
          }
          phase = 'awaiting-attached';
          sendJson({ t: 'spawn', project: PROJECT, agent: 'shell', resume: null, cols: 80, rows: 24 });
        }
      } else if (msg.t === 'attached') {
        termId = msg.id;
        seen.attached = true;
        ok(`spawn -> attached id=${msg.id} ${msg.cols}x${msg.rows}`);
        phase = 'awaiting-prompt';
      } else if (msg.t === 'size') {
        seen.size = true;
      } else if (msg.t === 'exit') {
        seen.exit = true;
        ok(`kill -> exit id=${msg.id} code=${msg.code}`);
        clearTimeout(timer);
        ws.close();
      } else if (msg.t === 'error') {
        bad(`error from the server: ${msg.code} — ${msg.message}`);
        clearTimeout(timer);
        ws.close();
      }
    };

    ws.onclose = () => {
      if (seen.sameId && termId !== null) ok('every binary frame uses the right terminal id');
      if (seen.size) ok('the server broadcasts {"t":"size"} after a resize');
      if (!seen.exit) bad('never received {"t":"exit"}');
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {};
  });
}

// --- 3. errors that are plain, not "something went wrong" ------------------
function testErrors() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    let n = 0;
    const timer = setTimeout(() => { bad('timeout in the error test'); ws.close(); }, 15000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'spawn', project: PROJECT, agent: 'tidakada', cols: 80, rows: 24 }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      const msg = JSON.parse(ev.data);
      if (msg.t !== 'error') return;
      n++;
      if (n === 1) {
        if (msg.code === 'unknown_agent') ok(`an unknown agent -> ${msg.code}: ${msg.message}`);
        else bad(`wrong code: ${msg.code}`);
        ws.send(JSON.stringify({ t: 'spawn', project: 'C:\\tidak\\ada\\folder', agent: 'shell', cols: 80, rows: 24 }));
      } else if (n === 2) {
        if (msg.code === 'bad_project') ok(`a missing project -> ${msg.code}: ${msg.message}`);
        else bad(`wrong code: ${msg.code}`);
        ws.send(JSON.stringify({ t: 'attach', id: 999, cols: 80, rows: 24 }));
      } else {
        if (msg.code === 'no_such_terminal') ok(`attaching to a foreign id -> ${msg.code}`);
        else bad(`wrong code: ${msg.code}`);
        clearTimeout(timer);
        ws.close();
      }
    };
    ws.onclose = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => {};
  });
}

await testBadToken();
await testTerminal();
await testErrors();

const failed = steps.filter((s) => s[0] === 'FAIL').length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
