// The settings panel. It edits the real `config.toml` through the daemon rather
// than keeping a copy in the browser — so the single source of truth stays in
// one place.
//
// Its shape is a left rail plus one pane at a time, not one long scroll. The
// reason is not taste: laid out flat, this panel is 1040px tall, so Agents could
// only be reached by scrolling past Network and Dropped files every time. The
// rail has a second job too — it carries each section's state, so "an agent's
// command cannot be found" reads at a glance instead of hiding in one sentence
// at the foot of the panel.

const mb = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const split = (s) => s.split(/\s+/).filter(Boolean);

/// Hide the token inside a URL, leaving the shape of the address.
///
/// Settings gets opened precisely while a screen is being shared, and what is
/// usually wanted is to copy — not to read. So it is closed by default, with
/// Copy as the primary action.
function maskToken(url) {
  return url.replace(/(token=)[^&\s]+/i, (_, k) => `${k}${'•'.repeat(12)}`);
}

/// Write a path into an element that trims from the left.
///
/// The content is wrapped in `<bdi>`: the container's direction is reversed so
/// what gets trimmed is the left end, and without that isolation the leading
/// slash of a unix path moves to the back — `/Users/tbs/x` shows as
/// `Users/tbs/x/`.
function setPath(el, value) {
  el.textContent = '';
  const bdi = document.createElement('bdi');
  bdi.textContent = value;
  el.appendChild(bdi);
  el.title = value;
}

const SECTIONS = [
  { key: 'network', label: 'Network' },
  { key: 'files', label: 'Dropped files' },
  { key: 'agents', label: 'Agents' },
  // Only present while looking at this machine itself: the paired list is held
  // by the LOCAL daemon, and remotes are never chained. Showing it while looking
  // at a remote machine would promise something that is not there.
  { key: 'machines', label: 'Machines', localOnly: true },
  // Not `localOnly`: every machine has its own tunnel, so this belongs to the
  // one the panel is showing. Hidden entirely by a daemon that does not know
  // how to forward a port — see `can_forward`.
  { key: 'cloudflare', label: 'Cloudflare' },
  { key: 'update', label: 'Update' },
];

export class Settings {
  /// `onSave(agent)` sends one agent to the daemon; a new name creates one.
  /// `onRemove(name)` deletes it. `onLan(enabled)` opens or closes network
  /// access. `onDrops(limits|null)` stores the drop folder limits; null = sweep
  /// now.
  constructor(
    root,
    onSave,
    onLan,
    onDrops,
    onRemove,
    onForget,
    onMoveRemote,
    onUpdate,
    onUpdateAgent,
    onCloudflare,
    onAddForward,
    onRemoveForward,
  ) {
    /// `onUpdate('check'|'apply'|'apply_web')` asks the daemon to look for a
    /// release, to install it and restart into it, or to install only the
    /// interface — which costs no restart.
    this.onUpdate = onUpdate || (() => {});
    /// `onUpdateAgent(name)` runs that agent's own updater in a terminal.
    this.onUpdateAgent = onUpdateAgent || (() => {});
    this.onSave = onSave;
    this.onLan = onLan;
    this.onDrops = onDrops;
    this.onRemove = onRemove;
    this.onForget = onForget || (() => {});
    this.onMoveRemote = onMoveRemote || (() => {});
    this.onCloudflare = onCloudflare || (() => {});
    this.onAddForward = onAddForward || (() => {});
    this.onRemoveForward = onRemoveForward || (() => {});
    this.cf = null;
    this.agents = [];
    this.shells = [];
    this.configPath = '';
    this.section = 'network';
    /// The name of the agent whose row is open. Only one — two forms open at
    /// once brings back exactly the wall of fields this was meant to avoid.
    this.openAgent = null;
    this.adding = false;
    this.revealed = false;
    /// The machine whose settings are being shown. This panel follows the active
    /// machine tab, and that has to be readable — not inferred from a config path.
    this.machine = { label: 'This machine', via: '' };
    this.remotes = [];
    /// The last answer to a release check: null until one is asked for.
    /// NOT called `update` — that is the method the daemon's config arrives
    /// through, and a field of the same name would shadow it into silence.
    this.release = null;
    /// How many terminals would die with the daemon, set by app.js.
    this.liveTerminals = 0;

    this.el = document.createElement('div');
    this.el.id = 'settings';
    this.el.hidden = true;
    this.el.innerHTML =
      '<div class="sbox" role="dialog" aria-label="Settings">' +
      '<div class="shead"><h2>Settings</h2>' +
      '<span class="smachine"></span>' +
      '<span class="path" title="Everything here is written straight to this file"></span>' +
      '<button class="close" title="Close (Esc)" aria-label="Close">✕</button></div>' +
      '<nav class="srail"></nav>' +
      '<div class="spane"></div>' +
      '<div class="sfootrow"><span class="note"></span></div>' +
      '</div>';
    root.appendChild(this.el);

    this.rail = this.el.querySelector('.srail');
    this.pane = this.el.querySelector('.spane');
    this.note = this.el.querySelector('.note');
    this.el.querySelector('.close').onclick = () => this.close();
    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
      e.stopPropagation(); // typing in here is not an app shortcut
    });
  }

  get open() {
    return !this.el.hidden;
  }

  show() {
    this.el.hidden = false;
    this.note.textContent = 'Loading…';
  }

  close() {
    this.el.hidden = true;
    // The token does not stay revealed for the next visit.
    this.revealed = false;
  }

  /// Which machine's settings are shown. Called when the machine tab changes,
  /// not only when the panel opens.
  setMachine(m) {
    const changed = this.machine.via !== (m.via || '');
    this.machine = { label: m.label, via: m.via || '' };
    if (changed) {
      // A section that does not exist on a remote machine must not stay selected.
      if (this.section === 'machines' && m.via) this.section = 'network';
      this.openAgent = null;
      this.adding = false;
      this.revealed = false;
    }
    this.paintHead();
    if (this.open) this.paint();
  }

  /// The list of paired machines, from the local daemon.
  ///
  /// `canMove` is whether that daemon understands being told a new address. An
  /// older one drops the message without answering, so the address is left as
  /// plain text there rather than as a field that swallows what is typed.
  setRemotes(list, canMove) {
    this.remotes = list || [];
    this.canMove = canMove === true;
    if (this.open) this.paint();
  }

  paintHead() {
    const el = this.el.querySelector('.smachine');
    el.textContent = '';
    el.className = 'smachine' + (this.machine.via ? ' remote' : '');
    const dot = document.createElement('span');
    dot.className = 'mdot ok';
    el.appendChild(dot);
    const name = document.createElement('span');
    name.textContent = this.machine.label;
    el.appendChild(name);
    el.title = this.machine.via
      ? `These settings belong to ${this.machine.label}, not to this computer.`
      : 'These settings belong to this computer.';
  }

  /// Called every time the daemon sends the latest config.
  update(msg) {
    this.agents = msg.agents || [];
    this.shells = msg.shells || [];
    this.configPath = msg.config_path || '';
    this.lanAccess = !!msg.lan_access;
    this.lanUrl = msg.lan_url || '';
    this.pairUrl = msg.pair_url || '';
    this.drops = msg.drops || null;
    this.setCloudflare(msg.cloudflare, false);
    setPath(this.el.querySelector('.path'), this.configPath);
    this.paint();
  }

  /// The forwarding settings, from the config message or on their own after one
  /// of them changed.
  setCloudflare(info, repaint = true) {
    this.cf = info || null;
    if (repaint && this.open) this.paint();
  }

  // ------------------------------------------------------------------ frame

  paint() {
    this.paintRail();
    this.pane.textContent = '';
    if (this.section === 'network') this.pane.appendChild(this.networkPane());
    else if (this.section === 'files') this.pane.appendChild(this.filesPane());
    else if (this.section === 'machines') this.pane.appendChild(this.machinesPane());
    else if (this.section === 'cloudflare') this.pane.appendChild(this.cloudflarePane());
    else if (this.section === 'update') this.pane.appendChild(this.updatePane());
    else this.pane.appendChild(this.agentsPane());

    const missing = this.brokenAgents();
    const where = this.machine.via ? ` on ${this.machine.label}` : '';
    this.note.textContent = missing
      ? `${missing} enabled agent${missing > 1 ? 's have' : ' has'} a command that can't be found${where} — ` +
        'disable it or fix the path.'
      : `Changes are saved to config.toml${where} right away.`;
    this.note.className = 'note' + (missing ? ' bad' : '');
  }

  brokenAgents() {
    return this.agents.filter((a) => a.enabled && !a.resolved).length;
  }

  /// The left rail. Each section carries one short note about its state, so what
  /// needs looking at shows before the section is opened.
  paintRail() {
    this.rail.textContent = '';
    const shown = SECTIONS.filter((x) => !x.localOnly || !this.machine.via).filter(
      // A daemon too old to forward a port says nothing about it, and a pane
      // whose every control is refused is worse than no pane.
      (x) => x.key !== 'cloudflare' || this.cf?.can_forward,
    );
    for (const s of shown) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sitem' + (s.key === this.section ? ' on' : '');
      b.dataset.section = s.key;

      const label = document.createElement('span');
      label.className = 'silabel';
      label.textContent = s.label;
      b.appendChild(label);

      const chip = this.chipFor(s.key);
      if (chip) b.appendChild(chip);

      b.onclick = () => {
        this.section = s.key;
        this.paint();
      };
      this.rail.appendChild(b);
    }
  }

  /// The small badge beside a section's name. `null` when that section has
  /// nothing worth saying — which is not the same as zero, and is why every
  /// section is named here rather than left to a default: Update wore the count
  /// of enabled agents for a while, purely because it fell through to the end.
  chipFor(key) {
    const chip = document.createElement('span');
    chip.className = 'schip';
    if (key === 'network') {
      chip.textContent = this.lanAccess ? 'on' : 'off';
      chip.classList.add(this.lanAccess ? 'warn' : 'muted');
      return chip;
    }
    if (key === 'files') {
      if (!this.drops) return null;
      chip.textContent = this.drops.files ? mb(this.drops.bytes) : 'empty';
      chip.classList.add('muted');
      return chip;
    }
    if (key === 'machines') {
      chip.textContent = String(this.remotes.length);
      chip.classList.add('muted');
      return chip;
    }
    const broken = this.brokenAgents();
    if (broken) {
      chip.textContent = String(broken);
      chip.title = `${broken} agent command(s) not found`;
      chip.classList.add('bad');
      return chip;
    }
    if (key === 'cloudflare') {
      const n = this.cf?.ports?.length || 0;
      chip.textContent = this.cf?.connected ? String(n) : 'off';
      chip.classList.add(this.cf?.connected && n ? 'warn' : 'muted');
      return chip;
    }
    if (key === 'update') {
      // Nothing until something has been checked. This pane does not ask on its
      // own — each check is a call to GitHub — and a number invented before the
      // answer is known would be a number about nothing.
      const r = this.release;
      if (!r) return null;
      // `installable` as well as `newer`: a release with no build for this
      // platform is not something anyone here can press, and a badge that
      // counts it sends you to a pane that only explains why it cannot.
      const waiting = (r.newer && r.installable ? 1 : 0) + (r.web_newer ? 1 : 0);
      chip.textContent = waiting ? String(waiting) : 'ok';
      chip.classList.add(waiting ? 'warn' : 'muted');
      return chip;
    }
    if (key !== 'agents') return null;
    chip.textContent = String(this.agents.filter((a) => a.enabled).length);
    chip.classList.add('muted');
    return chip;
  }

  // ------------------------------------------------------------------ pieces

  head(title, sub) {
    const wrap = document.createElement('div');
    wrap.className = 'sechead';
    const h = document.createElement('h3');
    h.textContent = title;
    wrap.appendChild(h);
    if (sub) {
      const p = document.createElement('p');
      p.textContent = sub;
      wrap.appendChild(p);
    }
    return wrap;
  }

  static stat(kind, text) {
    const d = document.createElement('div');
    d.className = `sstat ${kind}`;
    d.textContent = text;
    return d;
  }

  /// A value that is long and dangerous: closed, with Copy as the primary action
  /// and Reveal as the second.
  secretRow(value, { label, hint }) {
    const wrap = document.createElement('div');
    wrap.className = 'secret';

    if (label) {
      const cap = document.createElement('div');
      cap.className = 'seclabel';
      cap.textContent = label;
      wrap.appendChild(cap);
    }

    const row = document.createElement('div');
    row.className = 'secrow';

    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'secval';
    field.readOnly = true;
    field.spellcheck = false;
    field.value = this.revealed ? value : maskToken(value);
    field.title = 'Click to select';
    field.onclick = () => field.select();
    row.appendChild(field);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'secbtn primary';
    copy.textContent = 'Copy';
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(value);
        copy.textContent = 'Copied';
      } catch {
        // The clipboard can be refused; selecting it still makes Ctrl+C work.
        field.value = value;
        field.select();
        copy.textContent = 'Press Ctrl+C';
      }
      setTimeout(() => {
        if (copy.isConnected) copy.textContent = 'Copy';
      }, 1600);
    };
    row.appendChild(copy);

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'secbtn';
    eye.textContent = this.revealed ? 'Hide' : 'Reveal';
    eye.title = this.revealed ? 'Hide the token again' : 'Show the token in full';
    eye.onclick = () => {
      this.revealed = !this.revealed;
      this.paint();
    };
    row.appendChild(eye);

    wrap.appendChild(row);
    if (hint) {
      const h = document.createElement('div');
      h.className = 'sechint';
      h.textContent = hint;
      wrap.appendChild(h);
    }
    return wrap;
  }

  // ----------------------------------------------------------------- network

  networkPane() {
    const pane = document.createElement('div');
    pane.className = 'sec net';
    pane.appendChild(
      this.head(
        'Network access',
        this.lanAccess
          ? 'Other devices on this network can open sessionhub.'
          : 'Only this computer can open sessionhub. Turn on to use it from your phone.',
      ),
    );

    const row = document.createElement('div');
    row.className = 'switchrow';
    const toggle = document.createElement('label');
    toggle.className = 'switch';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.lanAccess;
    toggle.appendChild(cb);
    const track = document.createElement('span');
    track.className = 'track';
    toggle.appendChild(track);
    const word = document.createElement('span');
    word.className = 'switchword';
    word.textContent = this.lanAccess ? 'on' : 'off';
    toggle.appendChild(word);
    row.appendChild(toggle);
    pane.appendChild(row);

    cb.onchange = () => {
      this.note.textContent = cb.checked ? 'Opening…' : 'Closing…';
      this.onLan(cb.checked);
    };

    if (!this.lanAccess) return pane;

    // The warning comes before the address: what is being shared is a shell, not
    // a web page, and that has to be read before the link is copied.
    pane.appendChild(
      Settings.stat(
        'warn',
        'Anyone with this link gets a full shell here. Turn it off when you are done.',
      ),
    );

    if (this.lanUrl) {
      pane.appendChild(
        this.secretRow(this.lanUrl, {
          label: 'Open on another device',
          hint: 'Not connecting? Allow the port in your firewall.',
        }),
      );
    } else {
      pane.appendChild(
        Settings.stat('bad', 'No network address found — this computer is offline.'),
      );
    }

    if (this.pairUrl) {
      pane.appendChild(
        this.secretRow(this.pairUrl, {
          label: 'Pairing link',
          hint: 'Paste this into another machine’s ＋ Connect box to reach this one from there.',
        }),
      );
    }
    return pane;
  }

  /// "Refresh": refetch every file this page runs on, past every cache,
  /// then reload.
  ///
  /// It lives on the Update pane, beside the version it is about, and not on
  /// Network where it began — that was only ever where a phone could reach it.
  ///
  /// This exists because a browser that cached the interface BEFORE the daemon
  /// sent any Cache-Control header will keep that copy on heuristics and never
  /// ask again — on a phone, where there is no hard-reload, there is otherwise
  /// no way out short of clearing the site's data by hand. `cache: 'reload'`
  /// both bypasses the cache and overwrites the entry, so the reload that
  /// follows picks the fresh copies up.
  ///
  /// The list of files is not written down anywhere: the page itself knows what
  /// it loaded (`performance.getEntriesByType('resource')`), which also covers
  /// vendor files and any module added later without this list going stale.
  refreshRow() {
    const row = document.createElement('div');
    row.className = 'usagebar';

    const label = document.createElement('span');
    label.className = 'usage';
    label.textContent = 'Fetch every file again, past every cache, and reload.';
    row.appendChild(label);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'refresh-app';
    btn.className = 'secbtn';
    btn.textContent = 'Refresh';
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Refreshing…';
      const own = performance
        .getEntriesByType('resource')
        .map((r) => r.name)
        .filter((u) => u.startsWith(location.origin));
      // The page itself as well: a stale index.html would put the old asset
      // list right back on the next load.
      own.push(location.origin + location.pathname);
      const results = await Promise.allSettled(own.map((u) => fetch(u, { cache: 'reload' })));
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed) {
        // Offline, or the daemon is gone: reloading now would trade a stale
        // interface for none at all.
        btn.disabled = false;
        btn.textContent = 'Refresh';
        this.note.textContent = `Could not refetch ${failed} of ${own.length} files — is the connection up?`;
        return;
      }
      location.reload();
    };
    row.appendChild(btn);
    return row;
  }

  // ------------------------------------------------------------------ update

  /// The answer to a release check, from the daemon.
  setRelease(msg) {
    this.release = msg;
    if (this.open) this.paint();
  }

  /// The interface half of the Update panel.
  ///
  /// Kept apart from the daemon half because the two cost completely different
  /// things. Installing an interface writes a third of a megabyte into
  /// `~/.sessionhub/web/` and asks you to reload the page. Installing a daemon
  /// swaps eight megabytes and kills every terminal you have open. Most releases
  /// change only the first, and a panel that offered them together would make
  /// every CSS fix cost a restart.
  webSection(pane, r) {
    // Something is installed that this daemon cannot serve. It is already being
    // ignored in favour of the built-in copy; saying so is the difference
    // between a puzzle and a sentence.
    if (r.web_note && !r.web_newer) {
      pane.appendChild(Settings.stat('warn', r.web_note));
    }
    if (!r.web_newer) return;

    pane.appendChild(
      Settings.stat('warn', `Interface ${r.web_latest} is available — no restart, nothing closes.`),
    );
    if (r.web_note) pane.appendChild(Settings.stat('muted', r.web_note));

    const bar = document.createElement('div');
    bar.className = 'usagebar';
    const go = document.createElement('button');
    go.type = 'button';
    go.id = 'update-web';
    go.className = 'secbtn';
    go.textContent = `Update interface to ${r.web_latest}`;
    // One click, unlike the daemon button. Nothing is lost by pressing it: no
    // process dies, and the previous interface is the one baked into the binary,
    // which is always still there to fall back to.
    go.onclick = () => {
      go.disabled = true;
      go.textContent = 'Downloading…';
      this.onUpdate('apply_web');
    };
    bar.appendChild(go);
    pane.appendChild(bar);
    pane.appendChild(
      Settings.stat('muted', 'Reload the page afterwards to pick it up.'),
    );
  }

  updatePane() {
    const pane = document.createElement('div');
    pane.className = 'sec update';
    const who = this.machine.via ? this.machine.label : 'this computer';
    pane.appendChild(
      this.head('Update', `Install a newer sessionhub on ${who}, straight from its releases.`),
    );

    const now = document.createElement('div');
    now.className = 'usagebar';
    const ver = document.createElement('span');
    ver.className = 'usage';
    const r = this.release;
    ver.textContent = r ? `Running ${r.current}` : 'Running this build';
    now.appendChild(ver);
    if (r && r.web_current) {
      const web = document.createElement('span');
      web.className = 'usage';
      web.id = 'web-version';
      web.textContent = `Interface ${r.web_current}${r.web_builtin ? ' (built in)' : ''}`;
      now.appendChild(web);
    }

    const check = document.createElement('button');
    check.type = 'button';
    check.id = 'update-check';
    check.className = 'secbtn';
    check.textContent = 'Check for updates';
    check.onclick = () => {
      check.disabled = true;
      check.textContent = 'Checking…';
      this.onUpdate('check');
    };
    now.appendChild(check);
    pane.appendChild(now);

    // Directly under the versions it concerns, and before every early return
    // below: this is the one thing on this pane that works when the daemon has
    // nothing to say.
    pane.appendChild(this.refreshRow());

    if (!r) return pane;

    if (r.applying) {
      pane.appendChild(
        Settings.stat('muted', `Installing ${r.latest} — the daemon restarts and this page reconnects itself.`),
      );
      return pane;
    }
    // The interface first, and on its own. Installing it costs no restart and
    // kills no terminal, so burying it under the expensive button — or worse,
    // behind it — would charge the wrong price for the common change.
    this.webSection(pane, r);

    if (!r.newer) {
      pane.appendChild(Settings.stat('ok', `${r.current} is the newest release.`));
      return pane;
    }
    if (!r.installable) {
      // Never offer a button that would install the wrong architecture: the
      // daemon would be replaced by something that cannot start, and the UI
      // that could undo it is gone with it.
      pane.appendChild(
        Settings.stat('warn', `${r.latest} is out, but it has no build for this machine's platform.`),
      );
      return pane;
    }

    pane.appendChild(Settings.stat('warn', `${r.latest} is available.`));

    if (r.notes) {
      const notes = document.createElement('div');
      notes.className = 'unotes';
      notes.textContent = r.notes;
      pane.appendChild(notes);
    }

    // The cost, before the button rather than after it.
    const live = this.liveTerminals;
    pane.appendChild(
      Settings.stat(
        live ? 'bad' : 'muted',
        live
          ? `Updating restarts the daemon, and ${live} live terminal${live > 1 ? 's' : ''} will be `
            + 'killed with it. Agent sessions can be resumed afterwards; a plain shell cannot.'
          : 'Updating restarts the daemon. Nothing is running right now, so nothing is lost.',
      ),
    );

    const bar = document.createElement('div');
    bar.className = 'usagebar';
    const go = document.createElement('button');
    go.type = 'button';
    go.id = 'update-apply';
    go.className = 'secbtn primary';
    go.textContent = `Update to ${r.latest}`;
    // Two clicks, like removing an agent or forgetting a machine — every
    // irreversible thing in this panel asks twice.
    go.onclick = () => {
      if (go.dataset.armed) {
        go.disabled = true;
        go.textContent = 'Downloading…';
        this.onUpdate('apply');
        return;
      }
      go.dataset.armed = '1';
      go.classList.add('armed');
      go.textContent = live ? `Click again — ${live} terminal${live > 1 ? 's' : ''} will close` : 'Click again to install';
      setTimeout(() => {
        if (!go.isConnected) return;
        delete go.dataset.armed;
        go.classList.remove('armed');
        go.textContent = `Update to ${r.latest}`;
      }, 5000);
    };
    bar.appendChild(go);
    pane.appendChild(bar);
    return pane;
  }

  // ------------------------------------------------------------------- files

  filesPane() {
    const pane = document.createElement('div');
    pane.className = 'sec drops';
    const d = this.drops;
    if (!d) {
      pane.appendChild(this.head('Dropped files', 'Waiting for the daemon…'));
      return pane;
    }

    pane.appendChild(
      this.head('Dropped files', 'Where files you drop onto a terminal land before the agent reads them.'),
    );

    const bar = document.createElement('div');
    bar.className = 'usagebar';
    const used = document.createElement('span');
    used.className = 'usage';
    used.textContent = d.files
      ? `${d.files} file${d.files > 1 ? 's' : ''} · ${mb(d.bytes)}`
      : 'empty';
    bar.appendChild(used);
    const clean = document.createElement('button');
    clean.type = 'button';
    clean.className = 'secbtn';
    clean.textContent = 'Clean up now';
    clean.disabled = !d.files;
    clean.onclick = () => {
      this.note.textContent = 'Cleaning up…';
      this.onDrops(null);
    };
    bar.appendChild(clean);
    pane.appendChild(bar);

    const path = document.createElement('div');
    path.className = 'secpath';
    path.textContent = d.dir;
    pane.appendChild(path);

    const fields = document.createElement('div');
    fields.className = 'dfields';
    const num = (label, value, suffix, hint) => {
      const wrap = document.createElement('label');
      wrap.className = 'dfield';
      const cap = document.createElement('span');
      cap.className = 'dcap';
      cap.textContent = label;
      wrap.appendChild(cap);
      const line = document.createElement('span');
      line.className = 'dline';
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.value = String(value);
      input.title = hint;
      line.appendChild(input);
      const unit = document.createElement('em');
      unit.textContent = suffix;
      line.appendChild(unit);
      wrap.appendChild(line);
      fields.appendChild(wrap);
      return input;
    };
    const age = num('Delete after', d.max_age_hours, 'hours', '0 = never delete by age');
    const total = num('Folder limit', d.max_total_mb, 'MB', '0 = no limit');
    const file = num('Max per file', d.max_file_mb, 'MB', '0 = no limit');
    pane.appendChild(fields);

    const hint = document.createElement('div');
    hint.className = 'sechint';
    hint.textContent =
      'Age is the main rule. The folder limit only removes files older than 10 minutes, ' +
      'so a file you just dropped is never taken away. 0 turns a limit off.';
    pane.appendChild(hint);

    const save = () => {
      this.note.textContent = 'Saving…';
      this.onDrops({
        max_age_hours: Math.max(0, Number(age.value) || 0),
        max_total_mb: Math.max(0, Number(total.value) || 0),
        max_file_mb: Math.max(0, Number(file.value) || 0),
      });
    };
    for (const i of [age, total, file]) i.onchange = save;
    return pane;
  }

  // ---------------------------------------------------------------- machines

  machinesPane() {
    const pane = document.createElement('div');
    pane.className = 'sec machines';
    pane.appendChild(
      this.head(
        'Machines',
        'Computers this one can reach. Each keeps its own settings — switch to its ' +
          'tab above the terminal to edit them.',
      ),
    );

    if (!this.remotes.length) {
      pane.appendChild(
        Settings.stat(
          'muted',
          'No machines paired yet. On the other computer, open Settings → Network, ' +
            'copy its pairing link, then paste it into the ＋ box above the terminal.',
        ),
      );
      return pane;
    }

    const list = document.createElement('div');
    list.className = 'alist';
    for (const r of this.remotes) {
      const row = document.createElement('div');
      row.className = 'agent';

      const head = document.createElement('div');
      head.className = 'ahead';
      const dot = document.createElement('span');
      dot.className = 'adot ok';
      head.appendChild(dot);

      const name = document.createElement('span');
      name.className = 'aname';
      name.textContent = r.name;
      head.appendChild(name);

      const where = document.createElement('span');
      where.className = 'awhere' + (this.canMove ? ' editable' : '');
      setPath(where, r.version ? `${r.addr} · ${r.version}` : r.addr);
      if (this.canMove) {
        where.title = `Click to change where ${r.name} is. Its name and its token are kept.`;
        where.onclick = () => this.moveRow(where, r);
      }
      head.appendChild(where);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = 'Forget';
      del.title = `Stop showing ${r.name} here. Terminals over there keep running.`;
      del.onclick = () => this.confirmForget(r, del);
      head.appendChild(del);

      row.appendChild(head);
      list.appendChild(row);
    }
    pane.appendChild(list);

    pane.appendChild(
      Settings.stat(
        'muted',
        'Forgetting a machine only removes it from here — its terminals keep running, ' +
          'and its own settings are untouched.',
      ),
    );
    return pane;
  }

  /// The same as removing an agent: two clicks, with no dialog covering things up.
  /// Change where a machine is, in place.
  ///
  /// A machine whose address moved — a new DHCP lease, a different network — is
  /// the same machine, and forgetting it to pair again throws away its name and
  /// needs a fresh link fetched from the other side. Here its name and its token
  /// stay put; only the address changes, and the daemon proves the new one
  /// answers before it is written down.
  moveRow(where, r) {
    if (where.dataset.editing) return;
    where.dataset.editing = '1';
    where.textContent = '';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'amove';
    input.value = r.addr;
    input.spellcheck = false;
    input.autocapitalize = 'off';
    input.title = 'host:port — the port can be left off to keep the one it has';
    where.appendChild(input);
    input.focus();
    input.select();

    let sent = false;
    const stop = () => {
      // A repaint is coming either way; letting the blur that follows it undo
      // the request would put the old address back on screen.
      if (sent) return;
      delete where.dataset.editing;
      this.paint();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        stop();
        return;
      }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const addr = input.value.trim();
      if (!addr || addr === r.addr) {
        stop();
        return;
      }
      sent = true;
      input.disabled = true;
      this.note.textContent = `Asking ${addr} whether it is ${r.name}…`;
      this.onMoveRemote(r.name, addr);
    };
    input.onblur = stop;
  }

  /// The daemon refused the new address. The row is drawn again so it can be
  /// tried once more, with what went wrong left on the line below.
  moveFailed(message) {
    // After the repaint, not before: `paint` writes its own line into the note
    // and would wipe this one out.
    if (this.open) this.paint();
    this.note.textContent = message;
    this.note.className = 'note bad';
  }

  confirmForget(r, btn) {
    if (btn.dataset.armed) {
      this.note.textContent = 'Forgetting…';
      this.onForget(r.name);
      return;
    }
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    btn.textContent = 'Click again to forget';
    setTimeout(() => {
      if (!btn.isConnected) return;
      delete btn.dataset.armed;
      btn.classList.remove('armed');
      btn.textContent = 'Forget';
    }, 4000);
  }

  // -------------------------------------------------------------- cloudflare

  /// Reaching something on this machine — or on your network — from outside.
  ///
  /// Its own pane rather than a row under Network: there is a credential, a
  /// domain, a tunnel and a list of addresses, and Network is one switch and one
  /// address.
  cloudflarePane() {
    const pane = document.createElement('div');
    pane.className = 'sec cloudflare';
    const cf = this.cf || {};
    pane.appendChild(
      this.head(
        'Cloudflare',
        'Give something a way in from outside — a dev server here, or a machine ' +
          'on your network that cannot run a tunnel of its own.',
      ),
    );

    pane.appendChild(this.cfAccount(cf));
    pane.appendChild(this.cfForwards(cf));
    pane.appendChild(
      Settings.stat(
        'warn',
        'Anyone holding one of these addresses and its token reaches what is behind ' +
          'it. A dev server is not built to sit on the internet — Vite will hand out ' +
          'files from outside the project.',
      ),
    );
    return pane;
  }

  /// The token, and then what it turned out to reach.
  ///
  /// The token only ever travels one way: what comes back says whether one is
  /// stored, never what it is.
  cfAccount(cf) {
    const wrap = document.createElement('div');
    wrap.className = 'abody cfconnect';

    if (!cf.connected) {
      const note = document.createElement('div');
      note.className = 'cfspan';
      note.appendChild(
        Settings.stat(
          'muted',
          'Without a token every address gets a throwaway trycloudflare name, which ' +
            'works the same and changes every time it starts. Paste a token that may ' +
            'edit Cloudflare Tunnel on your account and DNS on the zone, and the names ' +
            'become yours and stay put.',
        ),
      );
      wrap.appendChild(note);
    }

    const tokenLabel = document.createElement('label');
    tokenLabel.textContent = 'API token';
    const token = document.createElement('input');
    token.type = 'password';
    token.spellcheck = false;
    token.autocomplete = 'off';
    token.placeholder = cf.connected ? 'stored — type a new one to replace it' : 'optional';
    wrap.appendChild(tokenLabel);
    wrap.appendChild(token);

    const bar = document.createElement('div');
    bar.className = 'usagebar cfbar';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'secbtn';
    go.textContent = cf.connected ? 'Check again' : 'Connect';
    go.onclick = () => {
      const t = token.value.trim();
      if (!t && !cf.connected) {
        this.note.textContent = 'Paste a token first, or leave this and add an address — ' +
          'those get throwaway names.';
        return;
      }
      go.disabled = true;
      go.textContent = 'Asking Cloudflare…';
      this.note.textContent = 'Looking for the account, the domains and the tunnels…';
      this.onCloudflare(t, '', '');
    };
    bar.appendChild(go);

    if (cf.connected) {
      const off = document.createElement('button');
      off.type = 'button';
      off.className = 'del';
      off.textContent = 'Forget token';
      off.title = 'Back to throwaway names. Addresses already arranged are left as they are.';
      off.onclick = () => {
        this.note.textContent = 'Forgetting…';
        this.onCloudflare('', '', '');
      };
      bar.appendChild(off);
    }
    wrap.appendChild(document.createElement('span'));
    wrap.appendChild(bar);

    // Chosen from what the token can see, rather than typed from memory.
    if (cf.zones?.length || cf.tunnels?.length) {
      wrap.appendChild(this.cfChoice('Domain', cf.zones || [], cf.zone_name, (id) =>
        this.onCloudflare('', id, ''),
      ));
      wrap.appendChild(this.cfChoice('Tunnel', cf.tunnels || [], cf.tunnel_name, (id) =>
        this.onCloudflare('', '', id),
      ));
    } else if (cf.connected && cf.ready) {
      const found = document.createElement('div');
      found.className = 'cfspan';
      found.appendChild(
        Settings.stat('ok', `${cf.zone_name} · tunnel ${cf.tunnel_name} · ${cf.account_name}`),
      );
      wrap.appendChild(found);
    }
    return wrap;
  }

  cfChoice(label, options, chosen, pick) {
    const l = document.createElement('label');
    l.textContent = label;
    const sel = document.createElement('select');
    if (!options.some((o) => o.name === chosen)) {
      const blank = document.createElement('option');
      blank.textContent = 'Select…';
      blank.value = '';
      sel.appendChild(blank);
    }
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.name;
      if (o.name === chosen) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.onchange = () => {
      if (!sel.value) return;
      this.note.textContent = 'Saving…';
      pick(sel.value);
    };
    const row = document.createDocumentFragment();
    row.appendChild(l);
    row.appendChild(sel);
    return row;
  }

  cfForwards(cf) {
    const wrap = document.createElement('div');
    wrap.className = 'cfports';

    for (const f of cf.forwards || []) {
      if (f.url) {
        // The same closed row a pairing link gets: the address carries a token,
        // and a token on screen is a token in the next screenshot.
        wrap.appendChild(
          this.secretRow(f.url, {
            label: f.target,
            hint: 'Open it once with the token; the cookie carries it after that.',
          }),
        );
      } else {
        wrap.appendChild(
          Settings.stat('muted', `${f.target} — waiting for a tunnel to come up…`),
        );
      }

      const bar = document.createElement('div');
      bar.className = 'usagebar';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = 'Close';
      del.title = `Take the way in away. Whatever runs on ${f.target} is untouched.`;
      del.onclick = () => {
        del.disabled = true;
        this.note.textContent = `Closing ${f.target}…`;
        this.onRemoveForward(f.name);
      };
      bar.appendChild(del);
      wrap.appendChild(bar);
    }

    const add = document.createElement('div');
    add.className = 'usagebar cfadd';
    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'amove';
    field.placeholder = 'localhost:5173, or 192.168.0.104:3100';
    field.spellcheck = false;
    field.title =
      'Something on this machine, or on your own network. A bare number is a port here.';
    add.appendChild(field);

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'secbtn';
    go.textContent = 'Give it a way in';
    const send = () => {
      const url = field.value.trim();
      if (!url) {
        this.note.textContent = 'An address is needed, like localhost:5173.';
        return;
      }
      go.disabled = true;
      this.note.textContent = cf.ready
        ? 'Arranging a hostname with Cloudflare…'
        : 'Starting a throwaway tunnel — this takes a few seconds…';
      this.onAddForward(url);
    };
    field.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        send();
      }
    };
    go.onclick = send;
    add.appendChild(go);
    wrap.appendChild(add);
    return wrap;
  }

  // ------------------------------------------------------------------ agents

  agentsPane() {
    const pane = document.createElement('div');
    pane.className = 'sec agents';
    pane.appendChild(
      this.head('Agents', 'Any CLI that runs in a terminal. Click one to edit how it starts.'),
    );

    const list = document.createElement('div');
    list.className = 'alist';
    for (const a of this.agents) list.appendChild(this.agentRow(a));
    pane.appendChild(list);

    if (this.adding) {
      pane.appendChild(this.addForm());
    } else {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'addbtn';
      add.textContent = '＋ Add an agent';
      add.onclick = () => {
        this.adding = true;
        this.openAgent = null;
        this.paint();
      };
      pane.appendChild(add);
    }
    return pane;
  }

  /// One agent: a compact row that opens. Closed, four agents fit in the height
  /// that one used to take.
  agentRow(a) {
    const open = this.openAgent === a.name;
    const box = document.createElement('div');
    box.className = 'agent' + (a.enabled ? '' : ' off') + (open ? ' open' : '');

    const head = document.createElement('div');
    head.className = 'ahead';
    head.onclick = (e) => {
      // A click on the switch or a button is not a request to open the row.
      if (e.target.closest('label, button')) return;
      this.openAgent = open ? null : a.name;
      this.adding = false;
      this.paint();
    };

    const twist = document.createElement('span');
    twist.className = 'atwist';
    twist.textContent = open ? '▾' : '▸';
    head.appendChild(twist);

    const dot = document.createElement('span');
    const state = !a.enabled ? 'off' : a.resolved ? 'ok' : 'bad';
    dot.className = `adot ${state}`;
    dot.title = !a.enabled ? 'disabled' : a.resolved ? a.resolved : 'command not found';
    head.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'aname';
    name.textContent = a.name;
    head.appendChild(name);

    // The summary on a closed row: what is most useful is whether the command
    // was actually found, and where.
    const where = document.createElement('span');
    where.className = 'awhere' + (a.enabled && !a.resolved ? ' bad' : '');
    // Through setPath rather than textContent: this row is trimmed from the left
    // too, and without isolation `/bin/zsh` shows as `bin/zsh/`.
    setPath(
      where,
      !a.enabled ? 'disabled' : a.resolved || `\`${a.command}\` not found on PATH`,
    );
    head.appendChild(where);

    // What is installed, beside where it is. An Update button with no version
    // next to it asks you to press it to find out what you already have.
    if (a.enabled && a.resolved && a.version) {
      const ver = document.createElement('span');
      ver.className = 'aver';
      ver.textContent = a.version;
      ver.title = `${a.command} --version`;
      head.appendChild(ver);
    }

    // Offered only for an agent that has an updater and is actually installed.
    // What it runs is the agent's own command — `claude update` is documented as
    // "check for updates and install if available" — so nothing here pretends to
    // know in advance whether there is one.
    if (a.enabled && a.resolved && a.update_args && a.update_args.length) {
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'abtn aupdate';
      up.dataset.agent = a.name;
      up.textContent = 'Update';
      up.title = `Run \`${a.command} ${a.update_args.join(' ')}\` in a terminal`;
      up.onclick = (e) => {
        e.stopPropagation();
        this.onUpdateAgent?.(a.name);
      };
      head.appendChild(up);
    }

    const toggle = document.createElement('label');
    toggle.className = 'switch small';
    toggle.title = a.enabled ? `Stop offering ${a.name}` : `Offer ${a.name} again`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = a.enabled;
    toggle.appendChild(cb);
    const track = document.createElement('span');
    track.className = 'track';
    toggle.appendChild(track);
    head.appendChild(toggle);

    box.appendChild(head);

    let pick = null;
    let cmd = null;
    let args = null;
    let forks = null;

    if (open) {
      const body = document.createElement('div');
      body.className = 'abody';

      const field = (label, title) => {
        const l = document.createElement('label');
        l.className = 'flabel';
        l.textContent = label;
        if (title) l.title = title;
        body.appendChild(l);
      };

      // A terminal-type agent gets a list of choices: picking "Command Prompt" is
      // clearer than having to know it is called `cmd.exe`.
      if (a.is_terminal && this.shells.length) {
        field('Shell');
        pick = document.createElement('select');
        for (const s of this.shells) {
          const o = document.createElement('option');
          o.value = s.command;
          o.textContent = `${s.label} — ${s.command}`;
          pick.appendChild(o);
        }
        const known = this.shells.some((s) => s.command.toLowerCase() === a.command.toLowerCase());
        if (!known) {
          // A command that is not in the list must not be quietly replaced.
          const o = document.createElement('option');
          o.value = a.command;
          o.textContent = `Other — ${a.command}`;
          pick.appendChild(o);
        }
        pick.value = a.command;
        body.appendChild(pick);
      }

      field('Command');
      cmd = document.createElement('input');
      cmd.type = 'text';
      cmd.value = a.command;
      cmd.spellcheck = false;
      cmd.placeholder = 'name on PATH, or full path';
      body.appendChild(cmd);

      // A plain shell has no session to resume, so the field is not offered —
      // filling it in is what makes "New terminal" fail.
      if (!a.is_terminal) {
        field('Resume args', 'Use {session_id} where the agent expects the session to continue.');
        args = document.createElement('input');
        args.type = 'text';
        args.value = a.resume_args.join(' ');
        args.spellcheck = false;
        args.placeholder = '--resume {session_id}';
        body.appendChild(args);

        field(
          'Fork args',
          'How this agent continues a conversation into a NEW session. Leave empty if it cannot.',
        );
        forks = document.createElement('input');
        forks.type = 'text';
        forks.value = (a.fork_args || []).join(' ');
        forks.spellcheck = false;
        forks.placeholder = 'empty = this agent cannot fork';
        body.appendChild(forks);
      }

      if (a.enabled && !a.resolved) {
        const bad = Settings.stat(
          'bad',
          `\`${a.command}\` not found on PATH — enter its full path, or disable this agent.`,
        );
        bad.classList.add('span2');
        body.appendChild(bad);
      }

      if (a.removable) {
        const foot = document.createElement('div');
        foot.className = 'afoot span2';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'del';
        del.textContent = 'Remove';
        del.title = `Remove ${a.name} from config.toml`;
        del.onclick = () => this.confirmRemove(a, del);
        foot.appendChild(del);
        body.appendChild(foot);
      }

      box.appendChild(body);
    }

    const save = () => {
      this.note.textContent = 'Saving…';
      this.onSave({
        name: a.name,
        command: cmd ? cmd.value : a.command,
        resume_args: args ? split(args.value) : a.resume_args,
        fork_args: forks ? split(forks.value) : a.fork_args || [],
        enabled: cb.checked,
      });
    };
    cb.onchange = save;
    if (cmd) cmd.onchange = save;
    if (args) args.onchange = save;
    if (forks) forks.onchange = save;
    if (pick) {
      pick.onchange = () => {
        cmd.value = pick.value;
        save();
      };
    }
    return box;
  }

  /// Removing an agent cannot be undone, so the button turns into an in-place
  /// confirmation — without a dialog covering what is being looked at, and
  /// without deleting because of one stray click.
  confirmRemove(a, btn) {
    if (btn.dataset.armed) {
      this.note.textContent = 'Removing…';
      this.onRemove(a.name);
      return;
    }
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    btn.textContent = a.live ? `Remove anyway (${a.live} running)` : 'Click again to remove';
    btn.title = a.live
      ? `${a.live} terminal(s) are still running ${a.name}. They keep running; only new ones stop being offered.`
      : `Removes ${a.name} from config.toml.`;
    setTimeout(() => {
      if (!btn.isConnected) return;
      delete btn.dataset.armed;
      btn.classList.remove('armed');
      btn.textContent = 'Remove';
    }, 4000);
  }

  /// Add your own harness. Only a name and a command are required — the rest can
  /// follow later through the agent's own row.
  addForm() {
    const box = document.createElement('div');
    box.className = 'agent addrow open';

    const head = document.createElement('div');
    head.className = 'ahead';
    const name = document.createElement('span');
    name.className = 'aname';
    name.textContent = 'Add an agent';
    head.appendChild(name);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secbtn';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => {
      this.adding = false;
      this.paint();
    };
    head.appendChild(cancel);
    box.appendChild(head);

    const body = document.createElement('div');
    body.className = 'abody';
    const field = (label, placeholder, title) => {
      const l = document.createElement('label');
      l.className = 'flabel';
      l.textContent = label;
      if (title) l.title = title;
      body.appendChild(l);
      const i = document.createElement('input');
      i.type = 'text';
      i.spellcheck = false;
      i.placeholder = placeholder;
      body.appendChild(i);
      return i;
    };
    const key = field('Name', 'aider', 'Lowercase letters, digits, - and _');
    const cmd = field('Command', 'name on PATH, or full path');
    const args = field(
      'Resume args',
      'empty = no saved sessions, just opens a shell',
      'Use {session_id} where the agent expects the session to continue.',
    );
    const forks = field(
      'Fork args',
      'empty = this agent cannot fork',
      'Use {session_id}, and {name} if the agent accepts a session name.',
    );

    const foot = Settings.stat(
      'muted',
      'The command is looked up on PATH once you add it, so a typo shows up here rather than at spawn time.',
    );
    foot.classList.add('span2');
    body.appendChild(foot);

    const actions = document.createElement('div');
    actions.className = 'afoot span2';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'addbtn primary';
    add.textContent = 'Add agent';
    add.onclick = () => {
      const n = key.value.trim().toLowerCase();
      if (!n || !cmd.value.trim()) {
        foot.className = 'sstat bad span2';
        foot.textContent = 'Both a name and a command are needed.';
        return;
      }
      if (this.agents.some((a) => a.name === n)) {
        foot.className = 'sstat bad span2';
        foot.textContent = `There is already an agent called \`${n}\`.`;
        return;
      }
      this.note.textContent = 'Adding…';
      this.onSave({
        name: n,
        command: cmd.value.trim(),
        resume_args: split(args.value),
        fork_args: split(forks.value),
        enabled: true,
      });
      for (const i of [key, cmd, args, forks]) i.value = '';
      this.adding = false;
    };
    actions.appendChild(add);
    body.appendChild(actions);

    box.appendChild(body);
    return box;
  }
}
