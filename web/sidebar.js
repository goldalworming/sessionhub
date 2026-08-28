// The sidebar: projects, sessions and live terminals — arranged by time.
//
// The bet: what you are looking for is almost always what was touched most
// recently, and what tells thirty identically titled sessions apart is when,
// not the title. So time becomes a fixed column, today's sessions rise to the
// top, and old history is folded per day instead of laid out in full.
//
// Its predecessor laid every session out as one flat row: one project holding
// 31 identically titled sessions pushed seven other projects off screen, and
// `24d ago` distinguished nothing because the number shifts every day.

import { absoluteDate, dayBucket, BUCKETS } from './format.js';

const LS_BUCKETS = 'sh.buckets';
const LS_ALIAS = 'sh.alias';
/// Sessions taken out of the "live & today" zone by hand.
///
/// Only out of that zone — the project's own history keeps them. The zone is a
/// convenience ("which one was that just now?"), so what belongs in it is a
/// matter of taste; the history is the record, and sessionhub does not own it.
/// Nothing is deleted anywhere: this is a list of ids in this browser.
const LS_HIDDEN = 'sh.zonehidden';

/// The fold state of the services group, kept in the same set as the day groups
/// so there is one place that remembers what is open.
const SERVICES_KEY = ' services';

/// The top rows are capped so this zone does not slowly turn into a second long
/// list — its whole value is that it always fits.
const ZONE_MAX = 8;

/// Groups open on first sight. The rest are folded: old history exists to be
/// searched occasionally, not looked at every day.
const OPEN_BY_DEFAULT = new Set(['today']);

/// Below this the history is laid out flat, without day groups.
const FLAT_MAX = 3;

// What is stored are the groups whose state DIFFERS from the default, not the
// list of open ones. That way a project never touched needs no record at all.
const toggled = loadSet(LS_BUCKETS);
const alias = loadMap(LS_ALIAS);
const hidden = loadSet(LS_HIDDEN);

function loadSet(key) {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || '[]'));
  } catch {
    return new Set();
  }
}

function loadMap(key) {
  try {
    const o = JSON.parse(localStorage.getItem(key) || '{}');
    return o && typeof o === 'object' ? new Map(Object.entries(o)) : new Map();
  } catch {
    return new Map();
  }
}

const saveToggled = () => localStorage.setItem(LS_BUCKETS, JSON.stringify([...toggled]));
const saveHidden = () => localStorage.setItem(LS_HIDDEN, JSON.stringify([...hidden]));
const saveAlias = () =>
  localStorage.setItem(LS_ALIAS, JSON.stringify(Object.fromEntries(alias)));

const bucketKey = (path, key) => `${path} ${key}`;
const bucketOpen = (path, key) =>
  OPEN_BY_DEFAULT.has(key) !== toggled.has(bucketKey(path, key));

/// The title actually shown: your own alias when there is one.
///
/// This is the only thing that solves duplicate titles at the root — everything
/// else only makes the duplicates easier to tell apart, not fewer.
export function displayTitle(s) {
  return alias.get(s.session_id) || s.title;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function renderTree(ctx) {
  const { tree, filter } = ctx.el;
  tree.textContent = '';
  const query = filter.value;
  const rows = ctx.filterTree(query);
  const searching = !!query.trim();

  if (ctx.state.projects.length && !rows.length) {
    tree.appendChild(el('div', 'empty-hint', 'No matches.'));
    return;
  }
  if (!ctx.state.projects.length) {
    const hint = el('div', 'empty-hint');
    hint.innerHTML = ctx.state.scanning
      ? 'Scanning sessions…'
      : 'No projects yet. Pick a folder to start one, or run an agent once ' +
        'inside a folder and it will show up here by itself.';
    tree.appendChild(hint);
    if (!ctx.state.scanning) {
      const b = el('button', null, 'New project…');
      b.id = 'new-project-empty';
      b.onclick = () => ctx.picker.show();
      hint.appendChild(b);
    }
    return;
  }

  const liveSession = new Map();
  for (const t of ctx.state.terminals) {
    if (t.alive && t.session_id) liveSession.set(t.session_id, t.id);
  }

  // While filtering, the top zone is hidden: the search results are already the
  // answer, and a second list above them only makes the eye move twice.
  if (!searching) {
    const zone = recentRows(ctx, liveSession);
    if (zone.length) {
      tree.appendChild(zoneLabel('live & today', String(zone.length)));
      for (const r of zone) tree.appendChild(r);
      // Anything hidden by hand says so and offers itself back. Nothing here is
      // deleted, so nothing should be unreachable — and a row that vanishes with
      // no way to recall it is the same as one that was lost.
      const back = hiddenToday(ctx);
      if (back) {
        const line = el('div', 'zback', `${back} hidden today · show`);
        line.title = 'Put them back in this zone. Their history was never touched.';
        line.onclick = () => {
          hidden.clear();
          saveHidden();
          ctx.rerender();
        };
        tree.appendChild(line);
      }
      tree.appendChild(el('div', 'zsep'));
    }
  }

  const focus = rows.filter((r) => ctx.bookmarks.has(r.p.path));
  const rest = rows.filter((r) => !ctx.bookmarks.has(r.p.path));
  const node = (entry) => projectNode(ctx, entry, liveSession, searching);

  if (searching) {
    tree.appendChild(zoneLabel('results', String(rows.length)));
    for (const entry of [...focus, ...rest]) tree.appendChild(node(entry));
    return;
  }

  // Marked projects rise into a group of their own. When nothing is marked, the
  // list stays flat with a single label — two labels over one list only suggest
  // a division that is not really there.
  if (focus.length) {
    tree.appendChild(zoneLabel('focused', String(focus.length)));
    for (const entry of focus) tree.appendChild(node(entry));
    if (rest.length) tree.appendChild(zoneLabel('all projects', String(rest.length)));
  } else {
    tree.appendChild(zoneLabel('projects', String(rest.length)));
  }
  for (const entry of rest) tree.appendChild(node(entry));
}

function zoneLabel(text, extra) {
  const d = el('div', 'zlabel');
  d.appendChild(el('span', null, text));
  if (extra) d.appendChild(el('span', 'zcount', extra));
  return d;
}

/// How many of the hidden ones would be in the zone today.
///
/// Counted rather than taken from the set's size: yesterday's hidden sessions
/// have dropped out of the zone on their own, and offering to bring back six
/// when only one would appear is a promise the row cannot keep.
function hiddenToday(ctx) {
  let n = 0;
  for (const p of ctx.state.projects) {
    for (const s of p.sessions) {
      if (hidden.has(s.session_id) && dayBucket(s.updated_at) === 'today') n++;
    }
  }
  return n;
}

// --------------------------------------------------------------- top zone

/// The saved entry a live terminal is running under, if it has one.
///
/// Giving a terminal a name is the act that says "this is a part of something,
/// not a scratch shell" — so that is the line the fold is drawn along. No
/// separate idea of a group is needed, and nothing has to be assigned by hand:
/// a backend and a frontend named inside one project are that project's set
/// because they are named and they are there.
///
/// The zone answers "which one was that just now?", and a named thing that has
/// been running since the daemon came up is never the answer to that. Two of
/// them on a zone capped at 8 rows is a quarter of it spent on things that do
/// not change.
function serviceOf(ctx, t) {
  return ctx.state.saved.find((s) => s.live_terminal_id === t.id) || null;
}

/// Named things set to start with the daemon that are NOT running.
///
/// The daemon starts each one once and never restarts it (it is not a
/// supervisor, and says so). So a service that exited is a silent failure —
/// exactly the case the fold below must not swallow.
function stoppedServices(ctx) {
  return ctx.state.saved.filter((s) => s.autostart && s.live_terminal_id === null);
}

/// The services, as one line that opens.
///
/// Folded by default, because a service running is the expected state and
/// nothing about it needs reading. Folding is only safe because failure is
/// loud: one that has stopped puts the line in the warning colour, names how
/// many, and forces the group open — you never have to remember to look.
function serviceRows(ctx, up, down) {
  const open = down.length > 0 || toggled.has(SERVICES_KEY);
  const rows = [];

  const head = el('div', 'zsvc' + (down.length ? ' bad' : '') + (open ? ' open' : ''));
  head.appendChild(el('span', 'twist', open ? '▾' : '▸'));
  head.appendChild(el('span', 'dot' + (down.length ? '' : ' live')));

  const total = up.length + down.length;
  head.appendChild(
    el(
      'span',
      'zsvclabel',
      down.length
        ? `${down.length} of ${total} service${total === 1 ? '' : 's'} stopped`
        : `${total} service${total === 1 ? '' : 's'}`,
    ),
  );
  // Named even while folded: which ones they are is the one thing you might
  // want without opening it.
  head.appendChild(
    el('span', 'zsvcnames', [...up.map((x) => x.s.name), ...down.map((s) => s.name)].join(', ')),
  );
  head.title = down.length
    ? 'Something set to start with sessionhub is not running. Click to see which.'
    : 'Started with sessionhub and still running. Click to see them.';
  head.onclick = () => {
    if (toggled.has(SERVICES_KEY)) toggled.delete(SERVICES_KEY);
    else toggled.add(SERVICES_KEY);
    saveToggled();
    ctx.rerender();
  };
  rows.push(head);

  if (!open) return rows;

  for (const { t, s } of up) {
    const p = ctx.state.projects.find((x) => x.path === t.project);
    rows.push(
      zoneRow(ctx, {
        when: 'live',
        title: s.name,
        named: true,
        project: p ? p.name : t.project,
        agent: t.agent,
        live: true,
        color: t.color,
        tid: t.id,
        indent: true,
        selected: t.id === ctx.activeId,
        open: () => (ctx.terms.has(t.id) ? ctx.show(t.id) : ctx.attach(t.id)),
      }),
    );
  }
  // A stopped one keeps its own row whether the group is open or not — it is
  // the thing worth acting on, and clicking it starts it again.
  for (const s of down) {
    const p = ctx.state.projects.find((x) => x.path === s.project);
    rows.push(
      zoneRow(ctx, {
        when: 'stopped',
        title: s.name,
        named: true,
        stopped: true,
        project: p ? p.name : s.project,
        agent: s.agent,
        live: false,
        indent: true,
        open: () => ctx.openSaved(s.project, s.name),
      }),
    );
  }
  return rows;
}

/// Live terminals, then sessions touched today. Both in one zone because the
/// question is the same: "which one was that just now?"
function recentRows(ctx, liveSession) {
  const seen = new Set();
  const out = [];

  // Find the stored session belonging to each live terminal so its title comes
  // along, rather than just "terminal 7".
  const byId = new Map();
  for (const p of ctx.state.projects) {
    for (const s of p.sessions) {
      const id = s.live_terminal_id ?? liveSession.get(s.session_id) ?? null;
      if (id !== null) byId.set(id, { p, s });
    }
  }

  const services = [];
  for (const t of ctx.state.terminals) {
    if (!t.alive) continue;
    // Set apart before anything else: a service is not what the zone is for.
    const svc = serviceOf(ctx, t);
    if (svc) {
      services.push({ t, s: svc });
      continue;
    }
    const hit = byId.get(t.id);
    if (hit) {
      seen.add(hit.s.session_id);
      out.push(
        zoneRow(ctx, {
          when: absoluteDate(hit.s.updated_at),
          title: displayTitle(hit.s),
          named: alias.has(hit.s.session_id),
          project: hit.p.name,
          agent: hit.s.agent,
          live: true,
          color: t.color,
          tid: t.id,
          selected: t.id === ctx.activeId,
          open: () => ctx.attach(t.id),
        }),
      );
    } else {
      const p = ctx.state.projects.find((x) => x.path === t.project);
      out.push(
        zoneRow(ctx, {
          when: t.name ? 'live' : 'new',
          title: t.name || `terminal ${t.id}`,
          named: !!t.name,
          loose: !t.name,
          project: p ? p.name : t.project,
          agent: t.agent,
          live: true,
          color: t.color,
          tid: t.id,
          selected: t.id === ctx.activeId,
          open: () => (ctx.terms.has(t.id) ? ctx.show(t.id) : ctx.attach(t.id)),
        }),
      );
    }
  }

  // The services go in as one folded row, at the head — they are the roof over
  // the work, not part of it. Folded they cost one line however many there are;
  // opened, each is an ordinary row with its own menu and colour.
  const down = stoppedServices(ctx);
  if (services.length || down.length) out.unshift(...serviceRows(ctx, services, down));

  const today = [];
  for (const p of ctx.state.projects) {
    for (const s of p.sessions) {
      if (seen.has(s.session_id)) continue;
      if (hidden.has(s.session_id)) continue;
      if (dayBucket(s.updated_at) !== 'today') continue;
      today.push({ p, s });
    }
  }
  today.sort((a, b) => Date.parse(b.s.updated_at) - Date.parse(a.s.updated_at));

  for (const { p, s } of today) {
    if (out.length >= ZONE_MAX) break;
    out.push(
      zoneRow(ctx, {
        when: absoluteDate(s.updated_at),
        title: displayTitle(s),
        named: alias.has(s.session_id),
        project: p.name,
        agent: s.agent,
        live: false,
        session: { p, s, inZone: true },
        open: () => ctx.spawn(p.path, s.agent, s.session_id),
      }),
    );
  }
  return out;
}

/// Colour, relaunch and kill, on every row that stands for a running terminal.
///
/// They already exist on the tab, which is the trouble: on a phone the strip is
/// often scrolled somewhere else, and the sidebar is where you were looking. The
/// terminal is looked up when the menu opens rather than captured here, so a row
/// rendered a minute ago still offers the truth.
/// Right-click on a row, whatever kind of row it is.
///
/// It used to bind only when a terminal was running, and every other row fell
/// through to the browser's own menu — Copy image, View source, in the middle of
/// the sidebar. A row that answers a right-click sometimes teaches nothing about
/// when it will.
///
/// A live terminal gets the terminal menu. A session with nothing running gets
/// what can be done to a session: rename it, fork it, take it out of the zone.
function bindRowMenu(ctx, node, id, session) {
  ctx.bindMenu(node, () => {
    if (id !== null && id !== undefined) {
      const t = ctx.state.terminals.find((x) => x.id === id);
      if (t) return ctx.terminalMenu(t);
    }
    return session ? sessionMenu(ctx, session) : [];
  });
}

/// What can be done to a session that is not running.
function sessionMenu(ctx, { p, s, inZone }) {
  const items = [
    {
      label: alias.has(s.session_id) ? 'Rename…' : 'Give it a name…',
      run: () => {
        // Looked up rather than captured: the menu is built once and may be
        // acted on after a state broadcast has replaced the tree, and a
        // reference to a row that is no longer on screen renames nothing.
        const row = document.querySelector(`[data-sid="${CSS.escape(s.session_id)}"]`);
        const title = row?.querySelector('.stitle');
        if (row && title) startRename(ctx, row, title, s);
      },
    },
  ];
  if (ctx.state.agents.find((a) => a.name === s.agent)?.can_fork) {
    items.push({ label: 'Fork into a new session…', run: () => ctx.forkSession(p.path, s) });
  }
  // Only offered where it does something. From the project's own history this
  // would read as "delete", and that is not what it does.
  if (inZone) {
    items.push({
      label: 'Hide from live & today',
      run: () => {
        hidden.add(s.session_id);
        saveHidden();
        ctx.rerender();
      },
    });
  }
  return items;
}

function zoneRow(ctx, o) {
  const r = el(
    'div',
    'zrow' + (o.selected ? ' selected' : '') + (o.indent ? ' zsub' : '') +
      (o.stopped ? ' zstopped' : ''),
  );
  r.title = `${o.project} · ${o.agent}\n${o.title}`;
  // The terminal id, for the activity sweep in app.js: busy/done marks are
  // toggled on `[data-tid]` without rebuilding this tree.
  if (o.tid !== undefined) r.dataset.tid = String(o.tid);
  if (o.color) r.dataset.color = o.color;

  r.appendChild(el('span', 'dot' + (o.live ? ' live' : '')));
  r.appendChild(el('span', 'when' + (o.live ? ' on' : ''), o.when));

  const col = el('div', 'zcol');
  // The same marker as in the history: your own name has to look like a name,
  // wherever its row appears.
  col.appendChild(
    el('div', 'stitle' + (o.loose ? ' loose' : '') + (o.named ? ' alias' : ''), o.title),
  );
  const meta = el('div', 'zmeta');
  meta.appendChild(el('span', 'zproj', o.project));
  meta.appendChild(el('span', null, '·'));
  meta.appendChild(el('span', null, o.agent));
  col.appendChild(meta);
  r.appendChild(col);

  if (o.session) r.dataset.sid = o.session.s.session_id;
  r.onclick = () => {
    o.open();
    ctx.closeDrawerIfNarrow();
  };
  bindRowMenu(ctx, r, o.live ? o.tid : null, o.session);
  return r;
}

// ------------------------------------------------------------- project row

function projectNode(ctx, entry, liveSession, searching) {
  const p = entry.p;
  const expanded = entry.open !== null ? entry.open : !ctx.collapsed.has(p.path);

  const wrap = el('div', 'project' + (p.exists ? '' : ' gone'));
  const row = el('div', 'row' + (ctx.explorerRoot()?.path === p.path ? ' focused' : ''));
  row.dataset.path = p.path;
  row.title = p.exists
    ? `${p.path}\nClick to show this project in the file panel`
    : `${p.path}\n(directory no longer exists)`;

  // The left arrow opens and closes, the name moves focus. That rule was already
  // chosen for the old sidebar and is not changed here — this is about arranging
  // by time, not about what happens when a row is clicked.
  const twist = el('span', 'twist', expanded ? '▾' : '▸');
  twist.title = expanded ? 'Collapse' : 'Expand';
  twist.onclick = (e) => {
    e.stopPropagation();
    const set = ctx.el.filter.value.trim() ? ctx.filterCollapsed : ctx.collapsed;
    if (set.has(p.path)) set.delete(p.path);
    else set.add(p.path);
    if (set === ctx.collapsed) ctx.saveCollapsed();
    ctx.rerender();
  };
  row.appendChild(twist);

  const name = el('span', 'pname');
  name.appendChild(ctx.mark(p.name, entry.pos));
  row.appendChild(name);

  if (entry.folder) {
    const via = el('span', 'pvia', entry.folder);
    via.title = p.path;
    row.appendChild(via);
  }

  // How much history there is and when it was last touched, in one piece. The
  // word "sessions" is dropped: in a 260px sidebar it beats the project name,
  // and the name is what the eye looks for first.
  const n =
    p.sessions.length + ctx.looseTerminals(p.path).length + ctx.savedTerminals(p.path).length;
  const last = p.sessions[0]?.updated_at;
  if (n) {
    const meta = el('span', 'pmeta');
    meta.textContent = last ? `${n} · ${absoluteDate(last)}` : String(n);
    meta.title = `${n} session${n === 1 ? '' : 's'}`;
    row.appendChild(meta);
  }

  const marked = ctx.bookmarks.has(p.path);
  const star = el('span', 'star' + (marked ? ' on' : ''));
  star.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    `<path d="M4 2.5h8a1 1 0 0 1 1 1v10.2a.4.4 0 0 1-.62.33L8 11.1l-4.38 2.93A.4.4 0 0 1 3 13.7V3.5a1 1 0 0 1 1-1z"${
      marked ? '' : ' fill="none" stroke="currentColor" stroke-width="1.3"'
    }/></svg>`;
  star.title = marked ? 'Remove from focus' : 'Mark as focus';
  star.onclick = (e) => {
    e.stopPropagation();
    if (marked) ctx.bookmarks.delete(p.path);
    else ctx.bookmarks.add(p.path);
    ctx.saveBookmarks();
    ctx.rerender();
  };
  row.appendChild(star);

  const add = el('span', 'add', '+');
  add.title = 'New terminal in this project';
  add.onclick = (e) => {
    e.stopPropagation();
    const r = add.getBoundingClientRect();
    ctx.openMenu(r.left, r.bottom + 2, startMenu(ctx, p));
  };
  row.appendChild(add);

  row.onclick = () => ctx.focusProject(p.path);
  wrap.appendChild(row);

  if (!expanded) return wrap;

  // The project's named terminals — backend and frontend, say — fold into one
  // line with the controls for the whole set. What is left over is the scratch
  // shells: those have no name, belong to nothing, and stay as they are.
  for (const r of groupRows(ctx, p)) wrap.appendChild(r);
  for (const t of ctx.looseTerminals(p.path)) {
    if (!t.name) wrap.appendChild(looseRow(ctx, t));
  }

  // While filtering, day groups are skipped entirely. This is not a
  // simplification: search results hiding behind a fold is the easiest way to
  // make the filter look broken.
  const mixed = new Set(entry.sessions.map((s) => s.agent)).size > 1;

  if (searching) {
    for (const [si, s] of entry.sessions.entries()) {
      wrap.appendChild(sessionRow(ctx, p, s, liveSession, entry.positions?.[si] || [], mixed));
    }
    return wrap;
  }

  // Short histories are laid out as they are. A group header for one session
  // only adds a row without hiding anything — precisely the opposite of its use.
  if (entry.sessions.length <= FLAT_MAX) {
    for (const s of entry.sessions) {
      wrap.appendChild(sessionRow(ctx, p, s, liveSession, [], mixed));
    }
    return wrap;
  }

  const groups = new Map(BUCKETS.map((b) => [b.key, []]));
  for (const s of entry.sessions) groups.get(dayBucket(s.updated_at)).push(s);

  for (const b of BUCKETS) {
    const list = groups.get(b.key);
    if (!list.length) continue;
    const open = bucketOpen(p.path, b.key);

    const head = el('div', 'bhead');
    const arw = el('span', 'barw', open ? '▾' : '▸');
    head.appendChild(arw);
    head.appendChild(el('span', 'blabel', b.label));
    head.appendChild(el('span', 'bcount', String(list.length)));
    head.onclick = () => {
      const k = bucketKey(p.path, b.key);
      if (toggled.has(k)) toggled.delete(k);
      else toggled.add(k);
      saveToggled();
      ctx.rerender();
    };
    wrap.appendChild(head);

    if (!open) continue;
    for (const s of list) wrap.appendChild(sessionRow(ctx, p, s, liveSession, [], mixed));
  }
  return wrap;
}

function sessionRow(ctx, p, s, liveSession, positions, mixed) {
  const live = s.live_terminal_id ?? liveSession.get(s.session_id) ?? null;
  const item = el('div', 'session' + (live !== null && live === ctx.activeId ? ' selected' : ''));
  item.title = `${s.title}\n${s.agent}`;
  if (live !== null) item.dataset.tid = String(live);

  // The same tag as on its tab, while something is running under this session.
  // A colour set from this row is not a mark if the row cannot show it.
  const running = live !== null ? ctx.state.terminals.find((x) => x.id === live) : null;
  if (running && running.color) item.dataset.color = running.color;

  item.appendChild(el('span', 'dot' + (live !== null ? ' live' : '')));
  item.appendChild(el('span', 'when', absoluteDate(s.updated_at)));
  if (mixed) item.appendChild(el('span', 'badge', s.agent));

  const custom = alias.get(s.session_id);
  const title = el('span', 'stitle' + (custom ? ' alias' : ''));
  // What gets marked is the original title; an alias is never matched against,
  // so marking it would highlight the wrong letters.
  if (custom) title.textContent = custom;
  else title.appendChild(ctx.mark(s.title, positions));
  item.appendChild(title);

  // `fork` is the shared look of a row action; the second class says which
  // action it is. Without it every selector here matches the pencil, the fork,
  // and the kill alike — which is exactly how a test ends up clicking rename
  // and reporting that forking is broken.
  const rename = el('span', 'fork act-rename', '✎');
  rename.title = custom
    ? 'Rename — leave it empty to go back to the original title'
    : 'Give this session your own name';
  rename.onclick = (e) => {
    e.stopPropagation();
    startRename(ctx, item, title, s);
  };
  item.appendChild(rename);

  if (ctx.state.agents.find((a) => a.name === s.agent)?.can_fork) {
    const fork = el('span', 'fork act-fork', '⑂');
    fork.title = 'Fork this session into a new one';
    fork.onclick = (e) => {
      e.stopPropagation();
      ctx.forkSession(p.path, s);
    };
    item.appendChild(fork);
  }

  item.dataset.sid = s.session_id;
  item.onclick = () => {
    if (live !== null) ctx.attach(live);
    else ctx.spawn(p.path, s.agent, s.session_id);
    ctx.closeDrawerIfNarrow();
  };
  bindRowMenu(ctx, item, live, { p, s, inZone: false });
  return item;
}

/// Turn the title into an input in place. Enter saves, Escape cancels, and
/// emptying it restores the original title.
function startRename(ctx, item, title, s) {
  const input = el('input', 'srename');
  input.type = 'text';
  input.spellcheck = false;
  input.value = alias.get(s.session_id) || '';
  input.placeholder = s.title;
  title.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const v = input.value.trim();
      if (v) alias.set(s.session_id, v);
      else alias.delete(s.session_id);
      saveAlias();
    }
    ctx.rerender();
  };
  input.onclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
}

/// The menu behind ＋ : one row per agent, with both ways to start it.
///
/// It used to be a flat list — `New claude`, `Resume claude…`, `New opencode` —
/// where the two things you can do with one agent sat apart and every agent
/// added two more lines to read. One row per agent puts the choice where the
/// eye already is, and says in passing what there is to resume.
///
/// The shell is kept out of that grid and put at the foot: it is not an agent,
/// it has no history to resume, and a Resume button greyed out beside it would
/// only raise the question of why.
function startMenu(ctx, p) {
    const shell = ctx.state.agents.find((a) => a.name === 'terminal');
    const agents = ctx.state.agents.filter((a) => a.name !== 'terminal');
    // Every new config.toml enables claude, opencode and pi, so a machine with
    // one of them installed was offered all three — and a row with two buttons
    // for something that cannot start is worse than a line of text was. Agents
    // whose command is nowhere on this machine are left out.
    //
    // `found === false` and not `!found`: a daemon too old to send the field
    // leaves it undefined, and there the old behaviour — show everything — is
    // the right guess.
    const missing = agents.filter((a) => a.found === false);
    const rows = agents
        .filter((a) => a.found !== false)
        .map((a, i) => ({ node: agentRow(ctx, p, a, i) }));

    // Nothing vanishes without a word. One quiet line says how many, and the
    // place that can fix or disable them is one click away.
    if (missing.length) {
        rows.push({
            label: `${missing.length} not installed`,
            hint: missing.map((a) => a.name).join(', '),
            dot: true,
            run: () => ctx.openSettings('agents'),
        });
    }

    if (shell) {
        rows.push({ sep: true });
        rows.push({
            label: 'New terminal',
            hint: 'shell',
            // A dot like the agents above have, so the four rows share one left
            // edge. Colourless, because a shell is not an agent and has no
            // identity to carry — the alignment is the whole point.
            dot: true,
            run: () => ctx.spawn(p.path, shell.name, null),
        });
    }
    return rows;
}

/// One agent: what history it has here, and the two buttons.
function agentRow(ctx, p, a, slot) {
    const here = p.sessions.filter((s) => s.agent === a.name).length;
    const live = ctx.state.terminals.some(
        (t) => t.alive && t.agent === a.name && t.project === p.path,
    );

    const row = el('div', 'magent');

    const dot = el('span', 'dot' + (live ? ' live' : ''));
    // Colour by position, so an agent keeps the same one across every project
    // and can be recognised without reading. The palette is in the stylesheet.
    if (!live) dot.dataset.slot = String(slot % 6);
    dot.title = live ? `${a.name} is running here` : '';
    row.appendChild(dot);

    row.appendChild(el('span', 'maname', a.name));

    const count = el(
        'span',
        'macount' + (here ? '' : ' none'),
        here ? `${here} session${here === 1 ? '' : 's'}` : 'no history here',
    );
    row.appendChild(count);

    const New = document.createElement('button');
    New.type = 'button';
    New.className = 'secbtn primary';
    New.textContent = 'New';
    New.title = `Start ${a.name} in ${p.name}`;
    New.onclick = (e) => {
        e.stopPropagation();
        ctx.closeMenu();
        ctx.spawn(p.path, a.name, null);
    };
    row.appendChild(New);

    const resume = document.createElement('button');
    resume.type = 'button';
    resume.className = 'secbtn';
    resume.textContent = 'Resume';
    // Resume means "carry on here", and there are two ways to get there.
    //
    // An agent with a picker of its own is handed the choice — claude's
    // `--resume` with no value opens its list, and recognising a conversation
    // there beats reading a title and a date. An agent without one is not out
    // of luck: sessionhub knows the ids, so the newest session in this project
    // is opened directly. opencode is the case that made this necessary — its
    // `--help` has `-s/--session <id>` and `-c/--continue`, and no picker flag
    // at all, so the button was permanently dead for it while resuming a named
    // session from the history worked perfectly well.
    const newest = here
        ? p.sessions
              .filter((s) => s.agent === a.name)
              .reduce((best, s) =>
                  !best || Date.parse(s.updated_at) > Date.parse(best.updated_at) ? s : best,
              null)
        : null;
    resume.disabled = !a.can_pick && !newest;
    resume.title = a.can_pick
        ? here
            ? `Let ${a.name} show its sessions here`
            : `${a.name} has no sessions in ${p.name} yet — its picker opens anyway`
        : newest
          ? `Carry on the newest ${a.name} session here. ${a.name} cannot show a list of its own.`
          : `${a.name} has nothing to carry on in ${p.name}, and cannot show a list of its own`;
    resume.onclick = (e) => {
        e.stopPropagation();
        ctx.closeMenu();
        if (a.can_pick) ctx.spawn(p.path, a.name, null, true);
        else if (newest) ctx.spawn(p.path, a.name, newest.session_id);
    };
    row.appendChild(resume);

    return row;
}

function looseRow(ctx, t, inGroup) {
  // A named terminal is not "loose" any more — that class greys the title and
  // sets it in italic, which is right for a row called `terminal 7` and wrong
  // for one called `telegram bot`.
  const item = el(
    'div',
    'session' +
      (t.name ? '' : ' loose') +
      (t.id === ctx.activeId ? ' selected' : '') +
      (inGroup ? ' zsub' : ''),
  );
  item.title = t.name
    ? `${t.name} · ${t.agent} · terminal ${t.id} · ${t.cols}×${t.rows}`
    : `${t.agent} · terminal ${t.id} · ${t.cols}×${t.rows}`;
  item.dataset.tid = String(t.id);
  // The same tag as on its tab: one terminal, one colour, wherever it appears.
  if (t.color) item.dataset.color = t.color;
  item.appendChild(el('span', 'dot live'));
  // `new` means "just started, nothing behind it". A named one is not new, it is
  // the thing you set up running — so it says so.
  item.appendChild(el('span', 'when on', t.name ? 'live' : 'new'));
  // The badge earns its place when it says something: on an unnamed row the
  // number tells you nothing, so the agent is all there is. On a named row the
  // name already identifies it, and a plain shell's badge would only crowd out
  // the command on a phone.
  if (!t.name || t.agent !== 'terminal') item.appendChild(el('span', 'badge', t.agent));
  // A saved terminal wears its name here rather than its number — the number is
  // what it is called when nobody has said what it is for.
  item.appendChild(
    el('span', 'stitle' + (t.name ? ' alias' : ' loose'), t.name || `terminal ${t.id}`),
  );

  const save = el('span', 'fork act-save');
  save.innerHTML = SAVE_ICON;
  save.title = t.name
    ? `Saved as “${t.name}” — click to change the name or the command`
    : 'Save this terminal: give it a name and it comes back after a restart';
  save.onclick = (e) => {
    e.stopPropagation();
    ctx.saveTerminal(t.id);
  };
  item.appendChild(save);

  const kill = el('span', 'fork act-kill', '✕');
  kill.title = 'Kill this terminal';
  kill.onclick = (e) => {
    e.stopPropagation();
    ctx.killTerminal(t.id);
  };
  item.appendChild(kill);

  item.onclick = () => {
    if (ctx.terms.has(t.id)) ctx.show(t.id);
    else ctx.attach(t.id);
    ctx.closeDrawerIfNarrow();
  };
  bindRowMenu(ctx, item, t.id, null);
  return item;
}

/// An arrow into a tray — the shape everything else uses for "save".
const SAVE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M8 2v6.6M5.4 6.2 8 8.8l2.6-2.6"/>' +
  '<path d="M3 10.4v1.7a.9.9 0 0 0 .9.9h8.2a.9.9 0 0 0 .9-.9v-1.7"/></svg>';

/// A saved terminal that is not running: a name, and the command waiting behind
/// it. Clicking starts the shell in its folder and runs that line.
/// A project's named terminals, as one line that opens — with the controls for
/// the whole set on it.
///
/// This is the answer to "backend and frontend crowd the list, but I still need
/// to stop and restart them easily". Folded it is one line; the ⟳ and ✕ on that
/// line act on every part at once, which is the thing that was awkward before —
/// two menus to restart one app.
///
/// Folding stays safe for the same reason it does in the zone above: a part that
/// should be running and is not turns the line yellow and opens it.
function groupRows(ctx, p) {
  const mine = ctx.state.saved.filter((s) => ctx.samePath(s.project, p.path));
  if (!mine.length) return [];

  const up = mine.filter((s) => s.live_terminal_id !== null);
  const down = mine.filter((s) => s.live_terminal_id === null);
  // Only something set to start by itself is *missing* when it is not running.
  // One you simply have not started yet is not a fault, and colouring it as one
  // would teach you to ignore the colour.
  const missing = down.filter((s) => s.autostart);

  const open = missing.length > 0 || toggled.has(groupKey(p.path));
  const rows = [];

  const head = el('div', 'zsvc pgroup' + (missing.length ? ' bad' : '') + (open ? ' open' : ''));
  head.appendChild(el('span', 'twist', open ? '▾' : '▸'));
  head.appendChild(el('span', 'dot' + (up.length && !missing.length ? ' live' : '')));
  head.appendChild(
    el(
      'span',
      'zsvclabel',
      missing.length
        ? `${missing.length} of ${mine.length} stopped`
        : `${up.length} of ${mine.length} running`,
    ),
  );
  head.appendChild(el('span', 'zsvcnames', mine.map((s) => s.name).join(', ')));
  head.title = 'The named terminals in this project. Click to see them.';
  head.onclick = (e) => {
    e.stopPropagation();
    const k = groupKey(p.path);
    if (toggled.has(k)) toggled.delete(k);
    else toggled.add(k);
    saveToggled();
    ctx.rerender();
  };

  // The set's own controls, on the line that stands for the set.
  const ids = up.map((s) => s.live_terminal_id);
  if (down.length) {
    head.appendChild(
      groupBtn('▶', `Start ${down.length === mine.length ? 'them' : 'the rest'}`, () =>
        ctx.startGroup(down),
      ),
    );
  }
  if (ids.length) {
    head.appendChild(
      groupBtn('⟳', 'Restart all of them', () => ctx.relaunchGroup(ids)),
    );
    head.appendChild(
      groupBtn('✕', 'Stop all of them', () => ctx.killGroup(ids, p.name)),
    );
  }
  rows.push(head);

  if (!open) return rows;
  // Running ones first: a stopped part is the one you act on, and it reads
  // better at the bottom where the eye lands after the list.
  for (const s of up) {
    const t = ctx.state.terminals.find((x) => x.id === s.live_terminal_id);
    if (t) rows.push(looseRow(ctx, t, true));
  }
  for (const s of down) rows.push(savedRow(ctx, s, true));
  return rows;
}

/// Prefixed rather than suffixed, so it can never collide with a day-group key
/// (`<path> <bucket>`) whatever a bucket is one day called.
const groupKey = (path) => `group:${path}`;

/// One control on a group line. `pointerdown` so the fold underneath does not
/// also toggle, and a title because a symbol on its own is a guess.
function groupBtn(glyph, title, run) {
  const b = el('span', 'gbtn', glyph);
  b.title = title;
  b.onclick = (e) => {
    e.stopPropagation();
    run();
  };
  return b;
}

function savedRow(ctx, s, inGroup) {
  const item = el('div', 'session saved' + (inGroup ? ' zsub' : ''));
  item.title = s.command
    ? `${s.agent} · runs: ${s.command}`
    : `${s.agent} · opens a shell, runs nothing`;

  if (s.color) item.dataset.color = s.color;

  item.appendChild(el('span', 'dot'));
  item.appendChild(el('span', 'when', 'saved'));
  // Same rule as the live row: the badge only when it says something the name
  // does not. On a phone every pixel it takes comes out of the command.
  if (s.agent !== 'terminal') item.appendChild(el('span', 'badge', s.agent));

  item.appendChild(el('span', 'stitle alias', s.name));
  // The command is shown, not just kept in the tooltip: clicking this row runs
  // it, and a row that runs something must say what.
  if (s.command) item.appendChild(el('span', 'scmd', s.command));

  // Autostarting is the normal state for something you named, so it
  // is left to the hover like the other row actions. Turned off it stays on
  // screen: "this one will not come back on its own" is the fact you would
  // otherwise have no way of seeing.
  const boot = el('span', 'fork act-boot' + (s.autostart ? '' : ' off'), '⏻');
  boot.title = s.autostart
    ? 'Autostarts with sessionhub. Click so it does not.'
    : 'Does not autostart. Click so it does.';
  boot.onclick = (e) => {
    e.stopPropagation();
    ctx.setAutostart(s.project, s.name, !s.autostart);
  };
  item.appendChild(boot);

  // Two clicks, because a mis-tap on a phone should not quietly delete the one
  // note saying how a bot is started.
  let armed = false;
  const forget = el('span', 'fork act-forget', '✕');
  forget.title = 'Forget this saved terminal';
  forget.onclick = (e) => {
    e.stopPropagation();
    if (!armed) {
      armed = true;
      forget.classList.add('armed');
      forget.title = 'Click again to forget it';
      setTimeout(() => {
        armed = false;
        forget.classList.remove('armed');
        forget.title = 'Forget this saved terminal';
      }, 3000);
      return;
    }
    ctx.forgetSaved(s.project, s.name);
  };
  item.appendChild(forget);

  item.onclick = () => ctx.openSaved(s.project, s.name);
  return item;
}
