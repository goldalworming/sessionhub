// Unit tests for the file finder's Downloads grouping (`dateGroups`).
const { dateGroups } = await import('file:///C:/data/code/terminal-editor2/sessionhubd/web/filebrowser.js');

const steps = [];
const check = (c, m) => { steps.push(c); console.log(`  [${c ? ' ok ' : 'FAIL'}] ${m}`); };

const at = (y, mo, d, h = 12) => new Date(y, mo - 1, d, h).getTime();
const labelsOf = (entries, now) =>
  Object.fromEntries(dateGroups(entries, now).flatMap(([l, items]) => items.map((e) => [e.name, l])));

// Tuesday 29 Sep 2026, 10:00 — the week began Monday the 28th.
const tue = new Date(2026, 8, 29, 10);
const files = [
  { name: 'today', modified_ms: at(2026, 9, 29, 8) },
  { name: 'monday', modified_ms: at(2026, 9, 28) },
  { name: 'sunday', modified_ms: at(2026, 9, 27) },
  { name: 'lastweek', modified_ms: at(2026, 9, 22) },
  { name: 'thismonth', modified_ms: at(2026, 9, 3) },
  { name: 'august', modified_ms: at(2026, 8, 15) },
  { name: 'march', modified_ms: at(2026, 3, 1) },
  { name: 'old', modified_ms: at(2025, 12, 31) },
  { name: 'unknown', modified_ms: 0 },
];
const g = labelsOf(files, tue);
check(g.today === 'Today', 'this morning is Today');
check(g.monday === 'Yesterday', 'yesterday is Yesterday, even though it is also this week');
check(g.sunday === 'Last week', 'Sunday belongs to last week — weeks start on Monday');
check(g.lastweek === 'Last week', 'a week ago is Last week');
check(g.thismonth === 'Earlier this month', 'earlier in the month');
check(g.august === 'Last month', 'August is Last month');
check(g.march === 'Earlier this year', 'March is Earlier this year');
check(g.old === 'A long time ago', 'last year is A long time ago');
check(g.unknown === 'A long time ago', 'no date at all falls to the end, not to Today');

const order = dateGroups(files, tue).map(([l]) => l);
check(
  order.join('|') === 'Today|Yesterday|Last week|Earlier this month|Last month|Earlier this year|A long time ago',
  `groups come newest first, empty ones left out (${order.join(', ')})`,
);
const within = dateGroups(
  [{ name: 'a', modified_ms: at(2026, 9, 29, 6) }, { name: 'b', modified_ms: at(2026, 9, 29, 9) }],
  tue,
)[0][1].map((e) => e.name);
check(within.join() === 'b,a', 'newest first inside a group too');

// Thursday 1 Oct 2026: the week began in September.
const thu = new Date(2026, 9, 1, 10);
const h = labelsOf([{ name: 'sep29', modified_ms: at(2026, 9, 29) }], thu);
check(h.sep29 === 'Earlier this week', 'a day of this week in last month is still Earlier this week');

console.log(`\n${steps.filter(Boolean).length}/${steps.length} steps passed`);
process.exit(steps.every(Boolean) ? 0 : 1);
