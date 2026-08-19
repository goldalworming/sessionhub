// The sign-in cookie: what is sent, where it is accepted, and — the point of
// the whole thing — that it outlives the browser being closed.
//
// None of this was covered before. The `Set-Cookie` header had no test at all,
// and neither did the cookie-only path, which is how every asset and every
// `/api/file` image actually authenticates once the page is open.

import { readFileSync } from 'node:fs';

const PORT = 7719;
const CFG = 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome\\.sessionhub\\config.toml';
const TOKEN = /token *= *"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];
const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${PORT}`;

/// Fetch, and always drain the body.
///
/// Undici keeps the socket around for reuse and trips an internal assertion
/// when the daemon closes one whose body was never read — which is every 401
/// here. Draining costs nothing and keeps a test about cookies from dying of
/// something else entirely.
const get = async (url, opts) => {
  const r = await fetch(url, opts);
  await r.arrayBuffer();
  return r;
};

// --- what the daemon sends ---------------------------------------------------
{
  const r = await get(`${base}/?token=${TOKEN}`);
  const set = r.headers.get('set-cookie') || '';
  check(r.status === 200, `signing in with ?token= works (${r.status})`);
  check(/(^|[;\s])sh_token=/.test(set), 'and it hands back an sh_token cookie');

  // The whole reason this test exists. Without Max-Age the cookie dies with the
  // browser, and the next visit is the sign-in page again — with the token still
  // in localStorage and nothing able to read it, because app.js is behind the
  // same gate.
  const maxAge = Number(/Max-Age=(\d+)/i.exec(set)?.[1]);
  check(maxAge > 30 * 24 * 60 * 60, `the cookie outlives the browser (Max-Age=${maxAge || 'MISSING'})`);

  // Strict withholds the cookie when the app is opened from a link somewhere
  // else — a chat message — which showed the sign-in page with a good cookie in
  // the jar.
  check(/SameSite=Lax/i.test(set), `arriving by a link still carries it (${/SameSite=\w+/i.exec(set)?.[0] || 'no SameSite'})`);
  check(/HttpOnly/i.test(set), 'no script can read it');
  check(/Path=\//.test(set), 'it covers every asset, not just the page');
  // Plain HTTP on a LAN: Secure would stop it being sent at all.
  check(!/;\s*Secure/i.test(set), 'and it is not marked Secure, which the LAN could not use');
}

// --- where it is accepted ----------------------------------------------------
{
  const withCookie = await get(`${base}/app.js`, { headers: { Cookie: `sh_token=${TOKEN}` } });
  check(withCookie.status === 200, `an asset authenticates on the cookie alone (${withCookie.status})`);

  const bare = await get(`${base}/app.js`);
  check(bare.status === 401, `and on nothing at all it is refused (${bare.status})`);

  const wrong = await get(`${base}/app.js`, { headers: { Cookie: 'sh_token=nope' } });
  check(wrong.status === 401, `a wrong cookie is refused too (${wrong.status})`);
}

// --- and where it is not handed out ------------------------------------------
// Only a page load should mint a cookie. An API call carrying a token in the
// query has no business leaving a credential in the browser's jar.
// `/ws` is not among them: a plain fetch of an upgrade route makes Node's HTTP
// parser abort outright, and the point here is the cookie, not the handshake.
for (const path of ['/api/status', '/api/file?path=nope']) {
  const r = await get(`${base}${path.includes('?') ? `${path}&` : `${path}?`}token=${TOKEN}`);
  check(!r.headers.get('set-cookie'), `${path.split('?')[0]} does not hand out a cookie (${r.status})`);
}

// --- the browser's own view of it --------------------------------------------
// The header could say Max-Age and the browser still treat it as a session
// cookie if the syntax were wrong. Ask the browser what it stored.
{
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = targets.find((t) => t.type === 'page');
  const cdp = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { cdp.onopen = r; });
  let seq = 0;
  const pending = new Map();
  cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const cmd = (method, params = {}) => { const i = ++seq; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
  const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

  await cmd('Network.enable');
  await cmd('Network.deleteCookies', { name: 'sh_token', url: `${base}/` });
  await ev(`location.href = '${base}/?token=${TOKEN}'`);
  await sleep(4000);

  const jar = (await cmd('Network.getCookies', { urls: [`${base}/`] })).result?.cookies || [];
  const sh = jar.find((c) => c.name === 'sh_token');
  check(!!sh, 'the browser accepted the cookie');
  check(sh && sh.session === false, `and stored it as a persistent one, not a session one (session=${sh?.session})`);
  check(sh && sh.expires > Date.now() / 1000 + 30 * 24 * 60 * 60, `with a real expiry well in the future (${sh ? new Date(sh.expires * 1000).toISOString().slice(0, 10) : 'none'})`);
  check(sh && sh.sameSite === 'Lax', `sameSite=${sh?.sameSite}`);
  check(sh && sh.httpOnly === true, `httpOnly=${sh?.httpOnly}`);

  // And the frontend still keeps its own copy, which is what serves the
  // WebSocket URL.
  check(await ev(`!!localStorage.getItem('sh.token')`), 'the frontend still stores its token as well');
}

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
