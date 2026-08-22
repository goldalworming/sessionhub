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

// --------------------------------------------------------------- top zone

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

  for (const t of ctx.state.terminals) {
    if (!t.alive) continue;
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

  const today = [];
  for (const p of ctx.state.projects) {
    for (const s of p.sessions) {
      if (seen.has(s.session_id)) continue;
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
function bindTerminalMenu(ctx, node, id) {
  if (id === null || id === undefined) return;
  ctx.bindMenu(node, () => {
    const t = ctx.state.terminals.find((x) => x.id === id);
    return t ? ctx.terminalMenu(t) : [];
  });
}

function zoneRow(ctx, o) {
  const r = el('div', 'zrow' + (o.selected ? ' selected' : ''));
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

  r.onclick = () => {
    o.open();
    ctx.closeDrawerIfNarrow();
  };
  bindTerminalMenu(ctx, r, o.live ? o.tid : null);
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
    ctx.openMenu(
      r.left,
      r.bottom + 2,
      ctx.state.agents.map((a) => ({
        label: `New ${a.name}`,
        run: () => ctx.spawn(p.path, a.name, null),
      })),
    );
  };
  row.appendChild(add);

  row.onclick = () => ctx.focusProject(p.path);
  wrap.appendChild(row);

  if (!expanded) return wrap;

  // Running first, then the named ones waiting to be started. Both sit above the
  // session history: they are what this project *does*, not what it did.
  for (const t of ctx.looseTerminals(p.path)) wrap.appendChild(looseRow(ctx, t));
  for (const s of ctx.savedTerminals(p.path)) wrap.appendChild(savedRow(ctx, s));

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

  item.onclick = () => {
    if (live !== null) ctx.attach(live);
    else ctx.spawn(p.path, s.agent, s.session_id);
    ctx.closeDrawerIfNarrow();
  };
  bindTerminalMenu(ctx, item, live);
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

function looseRow(ctx, t) {
  // A named terminal is not "loose" any more — that class greys the title and
  // sets it in italic, which is right for a row called `terminal 7` and wrong
  // for one called `telegram bot`.
  const item = el(
    'div',
    'session' + (t.name ? '' : ' loose') + (t.id === ctx.activeId ? ' selected' : ''),
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
  bindTerminalMenu(ctx, item, t.id);
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
function savedRow(ctx, s) {
  const item = el('div', 'session saved');
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
