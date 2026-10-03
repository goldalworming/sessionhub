// Unit tests for the deep link rules (`web/deeplink.js`).
const { parseDeepLink, findTerminal, deepLinkSearch } = await import(
  'file:///C:/data/code/terminal-editor2/sessionhubd/web/deeplink.js'
);

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };

// --- parsing -------------------------------------------------------------------
const p = parseDeepLink('?t=abwork-chat-claude&embed=1');
check(p.t === 'abwork-chat-claude' && p.embed && p.m === '', 'a name, with embed');
check(parseDeepLink('?t=18').t === '18', 'an id');
check(parseDeepLink('?t=ab%20r6&m=mac').t === 'ab r6' && parseDeepLink('?t=x&m=mac').m === 'mac', 'decoded, with a machine');
check(!parseDeepLink('?t=x&embed=true').embed && !parseDeepLink('').embed, 'embed only for embed=1');
check(parseDeepLink('?token=secret').t === '', 'no t: nothing to open');

// --- finding the terminal ------------------------------------------------------
const terms = [
  { id: 3, name: 'abwork-chat-claude', alive: true },
  { id: 7, name: 'ab-r6-sources-2', alive: true },
  { id: 9, name: 'old-one', alive: false },
  { id: 11, name: 'twin', alive: true },
  { id: 12, name: 'twin', alive: true },
  { id: 18, name: null, alive: true },
  { id: 20, name: '42', alive: true },
];
check(findTerminal(terms, 'abwork-chat-claude').id === 3, 'by name');
check(findTerminal(terms, '18').id === 18, 'by id');
check(findTerminal(terms, '42').error && findTerminal(terms, '20').id === 20, 'all digits is an id, never a name (as in the CLI)');
check(/exited/.test(findTerminal(terms, 'old-one').error), 'an exited terminal says so');
check(/exited/.test(findTerminal(terms, '9').error), 'by id too');
check(/no live terminal named/.test(findTerminal(terms, 'nope').error), 'an unknown name says so');
check(/no terminal 99/.test(findTerminal(terms, '99').error), 'an unknown id says so');
check(/More than one/.test(findTerminal(terms, 'twin').error), 'a name two terminals share is refused');

// --- the URL for what is on screen ----------------------------------------------
check(deepLinkSearch('', terms[0], '') === '?t=abwork-chat-claude', 'a named terminal by name');
check(deepLinkSearch('', terms[5], '') === '?t=18', 'an unnamed one by id');
check(deepLinkSearch('?t=old&embed=1', terms[1], '') === '?t=ab-r6-sources-2&embed=1', 'embed is kept');
check(deepLinkSearch('?t=x', terms[0], 'mac') === '?t=abwork-chat-claude&m=mac', 'a paired machine is named');
check(deepLinkSearch('?t=x&m=mac', terms[0], '') === '?t=abwork-chat-claude', 'and dropped for this one');
check(deepLinkSearch('?t=x', null, '') === '', 'nothing on screen: no t');
check(!deepLinkSearch('?token=s', terms[0], '').includes('token'), 'a token never stays in the URL');

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
