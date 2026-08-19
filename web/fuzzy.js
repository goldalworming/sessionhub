// Fuzzy matching for the command palette. A pure module: no DOM, no state.

const BOUNDARY = new Set([' ', '\\', '/', '-', '_', '.', '·', ':']);

/// Match `query` as a subsequence of `text`.
/// Returns `{ score, positions, span }`, or `null` when there is no match.
///
/// A higher score means more relevant: consecutive letters and letters at the
/// start of a word are rewarded, and a long remainder costs a little. `span` is
/// the distance from the first matched letter to the last — a measure of how
/// scattered the match is, used by callers that want to reject accidental ones.
export function match(query, text) {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, positions: [], span: 0 };
  const lower = text.toLowerCase();

  const positions = [];
  let score = 0;
  let ti = 0;
  let streak = 0;

  for (const ch of q) {
    if (ch === ' ') continue; // a space is only a word separator in the query
    let found = -1;
    for (let i = ti; i < lower.length; i++) {
      if (lower[i] === ch) { found = i; break; }
    }
    if (found === -1) return null;

    let point = 1;
    if (found === ti && positions.length) {
      streak += 1;
      point += 4 + streak; // huruf berurutan jauh lebih berarti
    } else {
      streak = 0;
    }
    if (found === 0 || BOUNDARY.has(text[found - 1])) point += 6; // awal kata
    score += point;
    positions.push(found);
    ti = found + 1;
  }

  // A short text that matches fully is more apt than a long one.
  score -= Math.min(10, (text.length - q.length) / 12);
  const span = positions.length ? positions[positions.length - 1] - positions[0] + 1 : 0;
  return { score, positions, span };
}

/// Sort candidates by relevance. `key` picks the text to match against.
/// Ties are broken by `tie` (last touched, for instance).
export function rank(query, items, key, tie = () => 0) {
  const scored = [];
  for (const item of items) {
    const m = match(query, key(item));
    if (m) scored.push({ item, score: m.score, positions: m.positions });
  }
  scored.sort((a, b) => b.score - a.score || tie(b.item) - tie(a.item));
  return scored;
}
