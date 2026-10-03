// Deep links to one terminal: `/?t=<name-or-id>`, on a paired machine with
// `&m=<machine>`, and with `&embed=1` showing that terminal alone — for
// another local tool (abwork) to put it in an iframe.
//
// The name-or-id rule is the CLI's (`sessionhubd send/capture`): all digits is
// an id, anything else a name; a name has to belong to exactly one live
// terminal. Pure functions, so the rule can be tested without a page.

/// `{ t, m, embed }` from a query string. Empty strings when absent.
export function parseDeepLink(search) {
  const q = new URLSearchParams(search);
  return {
    t: (q.get('t') || '').trim(),
    m: (q.get('m') || '').trim(),
    embed: q.get('embed') === '1',
  };
}

/// Which terminal `t` means among `terminals` (as the daemon lists them):
/// `{ id }`, or `{ error }` worded for someone looking at an empty panel.
export function findTerminal(terminals, t) {
  const list = terminals || [];
  if (/^\d+$/.test(t)) {
    const id = Number(t);
    const term = list.find((x) => x.id === id);
    if (!term) return { error: `There is no terminal ${id} here.` };
    if (!term.alive) return { error: `Terminal ${id} has exited.` };
    return { id };
  }
  const named = list.filter((x) => x.name === t);
  const live = named.filter((x) => x.alive);
  if (live.length === 1) return { id: live[0].id };
  if (live.length > 1) {
    return { error: `More than one live terminal is named “${t}” — link to it by its id instead.` };
  }
  if (named.length) return { error: `The terminal “${t}” has exited.` };
  return { error: `There is no live terminal named “${t}” here.` };
}

/// The query string for the terminal now on screen, keeping `embed`: its name
/// when it has one (it outlives the id across a restart), else its id; `m` for
/// a paired machine. `null` terminal clears `t`.
export function deepLinkSearch(current, terminal, machine) {
  const q = new URLSearchParams(current);
  q.delete('token');
  if (terminal) q.set('t', terminal.name || String(terminal.id));
  else q.delete('t');
  if (machine) q.set('m', machine);
  else q.delete('m');
  const s = q.toString();
  return s ? `?${s}` : '';
}
