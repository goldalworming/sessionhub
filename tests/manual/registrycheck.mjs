// Step 4 test against real data: the registry of three agents + the file watcher.

const PORT = 7719;
const FAKEHOME = 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome';

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

// Read from the config rather than hard-coded: the daemon's token changes, and
// a stale copy here fails as "cannot connect", which says nothing about what
// this test is actually checking.
const TOKEN = /token *= *"([^"]+)"/.exec(
  readFileSync(`${FAKEHOME}\\.sessionhub\\config.toml`, 'utf8'),
)[1];

// Clean up what earlier runs left behind, so a "new session" really is new.
rmSync(`${FAKEHOME}\\.pi\\agent\\sessions\\C--baru`, { recursive: true, force: true });
rmSync(`${FAKEHOME}\\.pi\\agent\\sessions\\C--badai`, { recursive: true, force: true });

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
ws.binaryType = 'arraybuffer';
const states = [];
ws.onmessage = (ev) => {
  if (typeof ev.data === 'string') {
    const m = JSON.parse(ev.data);
    if (m.t === 'state') states.push(m);
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('failed to connect')); });

async function waitFor(pred, what, ms = 90000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const last = states[states.length - 1];
    if (last && pred(last)) return last;
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${what} (${states.length} states received)`);
}

// --- 1. the initial registry -------------------------------------------------
const st = await waitFor(
  (s) => s.projects.length > 5 && s.projects.flatMap((p) => p.sessions).filter((x) => x.agent === 'pi').length === 1,
  'a stable registry after the cleanup'
);
const projects = st.projects;
const all = projects.flatMap((p) => p.sessions);
const byAgent = {};
for (const s of all) byAgent[s.agent] = (byAgent[s.agent] || 0) + 1;

console.log(`  projects: ${projects.length}, sessions: ${all.length}, per agent: ${JSON.stringify(byAgent)}`);
check(projects.length > 20, `found ${projects.length} projects in the real data`);
check((byAgent.claude || 0) > 20, `claude sessions are read (${byAgent.claude || 0})`);
const subagents = all.filter((s) => s.session_id.startsWith('agent-'));
check(subagents.length === 0, `subagent transcripts do not end up in the sidebar (${subagents.length})`);
const fallbackTitles = all.filter((s) => /^(claude|opencode|pi) · \d{4}-\d{2}-\d{2}$/.test(s.title));
check(fallbackTitles.length / all.length < 0.2, `the real title is read for almost every session (fallbacks: ${fallbackTitles.length}/${all.length})`);
check((byAgent.opencode || 0) > 0, `opencode sessions are read via the CLI (${byAgent.opencode || 0})`);
check((byAgent.pi || 0) === 1, `pi sessions are read (${byAgent.pi || 0})`);

// --- 2. the real cwd, not one reconstructed from the directory name ----------
const encodedLooking = projects.filter((p) => /^[A-Za-z]--/.test(p.name));
check(encodedLooking.length === 0, 'no project is named like an encoded directory (the cwd is read from the file contents)');
const withDrive = projects.filter((p) => /^[A-Za-z]:\\/.test(p.path));
check(withDrive.length > 20, `project paths look like real Windows paths (${withDrive.length})`);

// --- 3. titles -------------------------------------------------------------
const piSession = all.find((s) => s.agent === 'pi');
check(piSession?.title?.startsWith('prompt asli dari pi'), `the pi title skips past the synthetic prompt: "${piSession?.title}"`);
check(piSession.title.endsWith('…') && [...piSession.title].length === 61, 'the title is cut at 60 characters + an ellipsis');

const tooLong = all.filter((s) => [...s.title].length > 61);
check(tooLong.length === 0, 'no title exceeds the limit');
const syntheticTitles = all.filter((s) => s.title.startsWith('<') || s.title.startsWith('Caveat:'));
check(syntheticTitles.length === 0, `no title comes from a synthetic prompt (out of ${all.length} sessions)`);

// --- 4. ordering and marking -------------------------------------------------
// Projects are ordered by their most recent session, descending. The ones
// without sessions sit at the bottom, so only the part that has sessions is
// checked for ordering.
const stamps = projects.filter((p) => p.sessions.length).map((p) => p.sessions[0].updated_at);
check(
  stamps.every((s, i) => i === 0 || stamps[i - 1] >= s),
  `projects are ordered newest first (${stamps[0]} … ${stamps[stamps.length - 1]})`
);
const withoutSessions = projects.findIndex((p) => !p.sessions.length);
check(
  withoutSessions === -1 || projects.slice(withoutSessions).every((p) => !p.sessions.length),
  'projects without sessions gather at the bottom'
);
const unsorted = projects.find((p) => p.sessions.some((s, i) => i > 0 && p.sessions[i - 1].updated_at < s.updated_at));
check(!unsorted, 'the sessions within each project are ordered newest first');
const missing = projects.filter((p) => !p.exists);
check(projects.some((p) => p.exists), `a project that exists is marked exists (missing: ${missing.length})`);

const iso = all.every((s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s.updated_at));
check(iso, 'updated_at is formatted as ISO 8601 UTC');

// --- 5. the file watcher ----------------------------------------------------
const before = states.length;
const dir = `${FAKEHOME}\\.pi\\agent\\sessions\\C--baru`;
mkdirSync(dir, { recursive: true });
writeFileSync(
  `${dir}\\pi-uji-2.jsonl`,
  [
    '{"type":"meta","sessionId":"pi-uji-2"}',
    '{"type":"user","cwd":"C:\\\\data\\\\code\\\\terminal-editor2","message":{"role":"user","content":"sesi baru muncul saat daemon jalan"}}',
  ].join('\n')
);
console.log('  writing a new pi session while the daemon is running…');

const t0 = Date.now();
let found = null;
while (Date.now() - t0 < 30000) {
  const last = states[states.length - 1];
  if (last && last.projects.flatMap((p) => p.sessions).some((s) => s.session_id === 'pi-uji-2')) { found = last; break; }
  await sleep(200);
}
check(!!found, `the watcher pushes a new state without being asked (${((Date.now() - t0) / 1000).toFixed(1)}s, ${states.length - before} states)`);
const s2 = found?.projects.flatMap((p) => p.sessions).find((s) => s.session_id === 'pi-uji-2');
check(s2?.title === 'sesi baru muncul saat daemon jalan', `the title of the new session is right: "${s2?.title}"`);

// --- 6. debounce: a storm of writes must not become a storm of states -------
// Note: the real ~/.claude is being actively written to by this very Claude Code
// session, so "zero states" is not a legitimate expectation. What is tested:
// 12 new files at once do not produce 12 scans.
const dir2 = `${FAKEHOME}\\.pi\\agent\\sessions\\C--badai`;
mkdirSync(dir2, { recursive: true });
const beforeBurst = states.length;
for (let i = 0; i < 12; i++) {
  writeFileSync(
    `${dir2}\\badai-${i}.jsonl`,
    `{"type":"user","cwd":"C:\\\\data\\\\code\\\\badai","message":{"role":"user","content":"berkas ke-${i}"}}`
  );
  await sleep(120);
}
await sleep(4000);
const bursts = states.length - beforeBurst;
const allNow = states[states.length - 1].projects.flatMap((p) => p.sessions);
check(allNow.filter((s) => s.session_id.startsWith('badai-')).length === 12, 'all 12 storm sessions are read');
check(bursts <= 5, `12 writes in a row only triggered ${bursts} states (the debounce works)`);
rmSync(dir2, { recursive: true, force: true });

ws.close();
const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
