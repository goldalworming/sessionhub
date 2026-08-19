// The "Network access" row in the Settings panel, seen from a real browser.
// Needs Chrome with --remote-debugging-port=9222 and the test daemon on 7719.
import { readFileSync } from 'node:fs';

const PORT = 7719;
const CFG =
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\C--data-code-terminal-editor2\\' +
  '1c72f2cc-7025-4869-a627-df2b835ecce0\\scratchpad\\fakehome\\.sessionhub\\config.toml';
const TOKEN = /token\s*=\s*"([^"]+)"/.exec(readFileSync(CFG, 'utf8'))[1];

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

await cmd('Emulation.setDeviceMetricsOverride', { width: 1180, height: 800, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.setItem('sh.theme','light'); localStorage.setItem('sh.sidebar.hidden','0')`);
await ev(`location.href = 'http://127.0.0.1:${PORT}/?token=${TOKEN}'`);
await sleep(5000);

await ev(`document.getElementById('settings-btn').click()`);
const waitNet = async (ms = 15000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(`!!document.querySelector('#settings .sec.net')`)) return true;
    await sleep(200);
  }
  return false;
};
check(await waitNet(), 'the Settings panel loads the Network access row');

// Safety catch: this test writes to a real config.
const path2 = await ev(`document.querySelector('.shead .path').textContent`);
if (!path2.includes('fakehome')) {
  console.log(`  [ABORT] the panel points at a real config: ${path2}`);
  process.exit(2);
}

// It is no longer about vertical ordering — every section has its own panel.
// What still has to hold: Network is the FIRST section, and the one open first.
const order = await ev(`
  (() => {
    const rail = [...document.querySelectorAll('#settings .sitem')];
    return {
      pertama: rail[0]?.dataset.section,
      terbuka: document.querySelector('#settings .sitem.on')?.dataset.section,
    };
  })()
`);
check(
  order.pertama === 'network' && order.terbuka === 'network',
  `Network is the first section and the one open first (${order.pertama}/${order.terbuka})`,
);

const initial = await ev(`
  (() => {
    const b = document.querySelector('#settings .sec.net');
    return {
      judul: b.querySelector('.sechead h3').textContent,
      nyala: b.querySelector('input[type=checkbox]').checked,
      hint: b.querySelector('.sechead p').textContent,
      adaUrl: !!b.querySelector('.secval'),
      adaWarn: !!b.querySelector('.sstat.warn'),
    };
  })()
`);
check(initial.judul === 'Network access', `its title is "${initial.judul}"`);
check(initial.nyala === false, 'it starts out switched off');
check(/Only this computer/.test(initial.hint), 'while off, the explanation says only this computer');
check(!initial.adaUrl && !initial.adaWarn, 'while off, it shows neither a URL nor a warning');

// --- switch it on with a click -----------------------------------------------
await ev(`document.querySelector('#settings .sec.net input[type=checkbox]').click()`);
const waitOn = async (ms = 8000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(`!!document.querySelector('#settings .sec.net .secval')`)) return true;
    await sleep(200);
  }
  return false;
};
check(await waitOn(), 'a single click switches it on straight away, with no separate Save button');

const onState = await ev(`
  (() => {
    const b = document.querySelector('#settings .sec.net');
    const secret = b.querySelector('.secret');
    return {
      // What is shown right now is masked; the full value is held by the Copy button.
      tampil: secret.querySelector('.secval').value,
      readonly: secret.querySelector('.secval').readOnly,
      warn: b.querySelector('.sstat.warn')?.textContent || '',
      tips: [...b.querySelectorAll('.sechint')].map((n) => n.textContent),
      chip: document.querySelector('#settings .sitem[data-section="network"] .schip')?.textContent,
      label: b.querySelector('.switchword').textContent,
      tombol: [...secret.querySelectorAll('.secbtn')].map((x) => x.textContent),
    };
  })()
`);
check(
  /^http:\/\/\d+\.\d+\.\d+\.\d+:7719\/\?token=/.test(onState.tampil),
  `the address stays readable: ${onState.tampil}`,
);
// Settings tend to be opened precisely while sharing a screen; the token is not laid bare.
check(!/token=[A-Za-z0-9_-]{8}/.test(onState.tampil), `the token is masked (${onState.tampil.slice(-14)})`);
check(onState.tombol.includes('Copy'), `copying is the primary action (${onState.tombol.join(', ')})`);
check(onState.tombol.includes('Reveal'), 'and it can still be revealed if it really needs to be read');
check(onState.readonly === true, 'the URL is only there to be copied, it cannot be edited');
check(onState.chip === 'on', `the rail shows its state without having to open it ("${onState.chip}")`);
check(onState.label === 'on', `the label changes along with it ("${onState.label}")`);
check(/full shell/.test(onState.warn), 'the warning names what is at stake, not just "be careful"');
check(onState.warn.length <= 90, `the warning stays one short sentence (${onState.warn.length} characters)`);
check(onState.tips.some((t) => /firewall/i.test(t)), 'the firewall is mentioned as a separate hint, not piled into the warning');

// The full address is taken from the daemon rather than from the screen — what
// is on screen is deliberately masked.
const fullUrl = await ev(`
  (() => {
    const eye = [...document.querySelectorAll('#settings .sec.net .secbtn')]
      .find(b => b.textContent === 'Reveal');
    if (eye) eye.click();
    return true;
  })()
`).then(async () => {
  await sleep(400);
  return ev(`document.querySelector('#settings .sec.net .secval').value`);
});
check(/token=[A-Za-z0-9_-]{20,}/.test(fullUrl), 'Reveal really does uncover the token');

const code = await (async () => {
  try {
    return (await fetch(fullUrl, { signal: AbortSignal.timeout(3000) })).status;
  } catch { return null; }
})();
check(code === 200, `the address shown really does answer (${code})`);

// --- switch it back off ------------------------------------------------------
await ev(`document.querySelector('#settings .sec.net input[type=checkbox]').click()`);
const waitOff = async (ms = 8000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!(await ev(`!!document.querySelector('#settings .sec.net .secval')`))) return true;
    await sleep(200);
  }
  return false;
};
check(await waitOff(), 'it is switched back off with the same toggle');
check(/lan_access\s*=\s*false/.test(readFileSync(CFG, 'utf8')), 'config.toml goes back to false as well');

await ev(`document.querySelector('#settings .close').click()`);

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
