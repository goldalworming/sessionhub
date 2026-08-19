// Unit tests for the command palette's fuzzy matching.
const { match, rank } = await import('file:///C:/data/code/terminal-editor2/sessionhubd/web/fuzzy.js');

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };

// --- basics ------------------------------------------------------------------
check(match('abc', 'abcdef') !== null, 'a prefix matches');
check(match('adf', 'abcdef') !== null, 'a subsequence with gaps still matches');
check(match('fa', 'abcdef') === null, 'the order of the letters has to be respected');
check(match('xyz', 'abcdef') === null, 'a letter that is not there -> no match');
check(match('', 'anything at all')?.score === 0, 'an empty query matches with a score of zero');
check(match('ABC', 'abcdef') !== null, 'case insensitive');

// --- positions, for highlighting ----------------------------------------------
check(JSON.stringify(match('ace', 'abcde').positions) === '[0,2,4]', 'the positions of the matching letters are reported');

// --- ranking ------------------------------------------------------------------
const better = (q, a, b) => match(q, a).score > match(q, b).score;
check(better('notex', 'notex', 'no other text example'), 'a full match beats a scattered one');
check(better('nt', 'notex tools', 'internet'), 'letters at the start of a word are rewarded');
check(better('abc', 'abc', 'abcdefghijklmnop'), 'shorter text is preferred');

// --- rank() -------------------------------------------------------------------
const items = [
  { t: 'Migrate system census', when: 10 },
  { t: 'Menu givesession', when: 30 },
  { t: 'Mapping pigaru', when: 20 },
  { t: 'not relevant at all', when: 99 },
];
const got = rank('mig', items, (i) => i.t);
check(got.length === 2, `only the ones that match get through (${got.length})`);
check(got[0].item.t === 'Migrate system census', `the most relevant one on top: "${got[0].item.t}"`);

// Tied scores are broken by recency.
const tie = [
  { t: 'same', when: 1 },
  { t: 'same', when: 5 },
];
const ranked = rank('same', tie, (i) => i.t, (i) => i.when);
check(ranked[0].item.when === 5, 'a tied score is won by the most recent one');

// --- a space as a word separator ----------------------------------------------
check(match('mig sen', 'Migrate system census') !== null, 'a query with a space still matches');
check(match('zzz zzz', 'Migrate system census') === null, 'a space does not turn a non-match into a match');

const failed = steps.filter((s) => !s).length;
console.log(`\n${steps.length - failed}/${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
