// Small formatting shared by the sidebar and the tab bar.

export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

// Day and month names are written out here rather than taken from
// `toLocaleDateString`: its output shifts with the machine's locale, and the
// date column in the sidebar is only tidy when its width can be relied on.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/// Distance in calendar days, not in 24-hour steps: 23:50 and 00:10 are twenty
/// minutes apart but still "yesterday" and "today", and that is what the eye
/// looks for.
function dayDiff(then, now) {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 86400000);
}

/// An absolute date for the fixed column in the sidebar.
///
/// `24d ago` tells you the distance but not the identity: thirty sessions with
/// exactly the same title can only be told apart when the date is something
/// memorable, not a countdown that shifts every day.
export function absoluteDate(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  const ref = new Date(now);
  const days = dayDiff(d, ref);
  if (days <= 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days === 1) return 'yesterday';
  if (d.getFullYear() === ref.getFullYear()) {
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
}

/// Day buckets for folding history. Their order is also their display order.
export const BUCKETS = [
  { key: 'today', label: 'today', max: 0 },
  { key: 'yesterday', label: 'yesterday', max: 1 },
  { key: 'week', label: 'last 7 days', max: 7 },
  { key: 'older', label: 'older', max: Infinity },
];

export function dayBucket(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'older';
  const days = dayDiff(new Date(t), new Date(now));
  return BUCKETS.find((b) => days <= b.max).key;
}

export function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}

export function basename(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}
