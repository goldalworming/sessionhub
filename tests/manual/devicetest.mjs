// Which devices get the touch controls — the key bar, the scrollback buttons.
//
// The rule is: the PRIMARY pointer decides, nothing else. Both refinements
// tried on top of it were wrong in ways only real hardware showed. A width
// fallback put the key bar on any laptop window snapped under 820 px. Then
// `!(any-pointer: fine)` — meant to spare touchscreen laptops — switched the
// bar off on real phones: a stylus digitizer or a once-paired Bluetooth mouse
// makes a phone report a fine pointer somewhere, and Esc, the arrows and PgDn
// never appeared on the exact device they exist for.
//
// The classification is a pure function of media queries, so it is tested here
// against a stubbed matchMedia. It cannot be tested in the headless browser the
// other scripts drive: that Chrome reports a coarse-only device natively and
// ignores pointer-feature emulation, so these profiles cannot be presented
// to it.

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };

const CASES = [
  // [name, coarse, fine, none, anyFine, narrow, expected]
  ['a phone or tablet gets the touch controls', true, false, false, false, true, true],
  ['a stylus phone still does, though its digitizer counts as a fine pointer', true, false, false, true, true, true],
  ['an ordinary laptop does not', false, true, false, true, false, false],
  ['a laptop window snapped under 820px still does not', false, true, false, true, true, false],
  ['a browser with no pointer queries, wide: no', false, false, false, false, false, false],
  ['a browser with no pointer queries, narrow: the width net still applies', false, false, false, false, true, true],
];

let table;
globalThis.window = { matchMedia: (q) => ({ matches: !!table[q] }) };
const { touchOnlyDevice } = await import('../../web/touchscroll.js');

for (const [name, coarse, fine, none, anyFine, narrow, expected] of CASES) {
  table = {
    '(pointer: coarse)': coarse,
    '(pointer: fine)': fine,
    '(pointer: none)': none,
    '(any-pointer: fine)': anyFine,
    '(max-width: 820px)': narrow,
  };
  check(touchOnlyDevice() === expected, name);
}

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
