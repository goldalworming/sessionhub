// The WS connection: one per tab, with reconnects on a rising backoff.
// This module knows nothing about the DOM.

const RECONNECT_MIN = 500;
const RECONNECT_MAX = 8000;

/// Whether this browser can inflate raw DEFLATE (`DecompressionStream`), and so
/// may ask for a packed replay: a full ring buffer is 2 MB, a tenth of that
/// packed, which over a tunnel is the difference between opening a terminal at
/// once and waiting seconds for it.
const CAN_INFLATE = (() => {
  try {
    new DecompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
})();

function inflate(bytes) {
  const out = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(out).arrayBuffer().then((b) => new Uint8Array(b));
}

/// How often to prove the link is alive.
///
/// A WebSocket does not always die loudly. A tunnel that idles it out, a phone
/// that changes network, a laptop that sleeps — any of these can leave the
/// socket with `readyState === OPEN` on this side while nothing crosses it any
/// more. `send()` then succeeds into a void and no message ever arrives: the
/// terminal looks frozen, typing does nothing, and only reloading the page
/// helps. `onclose` never fires, so nothing here would ever have noticed.
///
/// This does both halves of the job. The traffic itself keeps an intermediary
/// from deciding the connection is idle, and the silence that follows a lost
/// link is what gives it away.
const PING_MS = 15000;

/// Give up on the link after this long with nothing at all from the other side —
/// about three missed pings. Long enough that a slow moment is not mistaken for
/// a dead socket, short enough that a phone coming out of a tunnel does not sit
/// there frozen.
const SILENT_MS = 50000;

/// Give up on a handshake that has not completed after this long.
///
/// A browser lets a WebSocket sit in `CONNECTING` for minutes when the network
/// is bad — the SYN goes unanswered, or the daemon is relaying to a machine
/// that is slow to reply — and nothing fires in the meantime. Closing it here
/// makes `onclose` run, and with it the same reconnect as for any other loss.
const DIAL_MS = 15000;

/// How long a probe waits for any sign of life before calling the link dead.
///
/// A socket can sit `OPEN` over a line that died — a tablet woke from sleep, the
/// network changed, the tunnel blinked — and `SILENT_MS` alone took up to a
/// minute to notice, while every key pressed went nowhere. A probe asks the
/// moment there is reason to doubt (back in view, back online, typed with no
/// answer). Generous rather than tight: a big replay arriving over a slow link
/// is one frame that takes seconds, and a false alarm reconnects for nothing.
const PROBE_MS = 10000;

/// This page, for as long as it is open: sent with every socket, so a daemon
/// can tell this page reconnecting from a second viewer and drop the socket it
/// replaces at once rather than minutes later (`Cmd::ClientUp`).
const PAGE = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

export class Conn {
  /// `via` is the name of another paired machine; empty means this machine.
  /// `owner` is carried into every handler, so one set of handlers can serve
  /// many connections without needing to know their order.
  constructor(token, { via = '', owner = null, handlers = null } = {}) {
    this.token = token;
    this.via = via;
    this.owner = owner;
    this.ws = null;
    this.delay = RECONNECT_MIN;
    this.closedByUs = false;
    /// When anything last arrived. Any frame counts as proof of life — a busy
    /// terminal keeps the link proven without a single ping being sent.
    this.lastSeen = 0;
    this.beat = null;
    /// The pending reconnect, so a retry by hand can cancel it rather than
    /// end up with two sockets racing.
    this.timer = null;
    /// The handshake deadline for the socket now connecting.
    this.dial = null;
    /// Has the other end ever answered a ping?
    ///
    /// Silence only means a dead link if the peer would have spoken. A daemon
    /// older than this feature never answers, and treating that as death would
    /// tear down a perfectly good connection every fifty seconds — which is
    /// worse than the freeze this fixes, and would hit a paired machine that has
    /// not been updated yet, over the relay, where the version is not ours to
    /// choose. So the timeout arms itself only once a pong has been seen.
    this.answers = false;
    /// The pending probe (see `probe`), so only one runs at a time.
    this.probing = null;
    /// Why the link was last declared lost, for the telemetry: 'closed' (the
    /// socket ended), 'silent' (nothing heard for SILENT_MS), 'probe' (a probe
    /// went unanswered) or 'dial' (the handshake never completed).
    this.lostWhy = null;
    /// Whether to ask for packed replays. Turned off for good on this
    /// connection if one ever fails to inflate; the replay is then asked for
    /// again, unpacked.
    this.inflate = CAN_INFLATE;
    /// The terminal whose next binary frame is packed (`replay` said so).
    this.packedFor = null;
    /// Frames that arrived while a packed one was inflating, held so nothing
    /// overtakes it: the replay has to be on the screen before `attached` and
    /// the live output that follow it.
    this.backlog = null;
    // handlers: onState, onAttached, onSize, onExit, onError, onMem,
    //           onOutput(id, bytes), onStatus(kind) — all of them take
    //           `owner` as their last argument.
    this.on = handlers || {};
  }

  connect() {
    clearTimeout(this.timer);
    this.timer = null;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const via = this.via ? `&via=${encodeURIComponent(this.via)}` : '';
    const ws = new WebSocket(
      `${proto}//${location.host}/ws?token=${encodeURIComponent(this.token)}${via}&page=${PAGE}${document.hidden ? '&hidden=1' : ''}`,
    );
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.packedFor = null;
    this.backlog = null;
    this.emit('onStatus', 'connecting');

    clearTimeout(this.dial);
    this.dial = setTimeout(() => {
      if (ws.readyState !== WebSocket.CONNECTING) return;
      this.lostWhy = 'dial';
      try {
        ws.close();
      } catch {
        // onclose still runs
      }
    }, DIAL_MS);

    ws.onopen = () => {
      clearTimeout(this.dial);
      this.delay = RECONNECT_MIN;
      this.lastSeen = Date.now();
      // Re-proved per connection: the machine on the other end may have changed
      // version between one socket and the next.
      this.answers = false;
      this.lostWhy = null;
      this.startBeat();
      // A page off screen is sent less (`visibility`); a fresh socket starts
      // out assumed visible, so say so when it is not.
      if (document.hidden) this.send({ t: 'visibility', visible: false });
      this.emit('onStatus', 'open');
    };

    ws.onmessage = (ev) => {
      this.lastSeen = Date.now();
      if (this.ws !== ws) return;
      if (this.backlog) this.backlog.push(ev.data);
      else this.receive(ev.data, ws);
    };

    ws.onclose = () => {
      clearTimeout(this.dial);
      this.stopBeat();
      if (this.closedByUs) return;
      this.lostWhy ||= 'closed';
      this.emit('onStatus', 'lost');
      // A phone with the page out of sight: the system ends the socket, and a
      // reconnect from there lives a few seconds, fetches a replay nobody
      // sees, and is ended again — some 80 times a day. It waits for the page
      // to be looked at (`probe`, which the page calls on its return). A
      // desktop tab keeps reconnecting: it is what rings when an agent is done.
      if (document.hidden && !window.matchMedia('(any-pointer: fine)').matches) {
        this.parked = true;
        return;
      }
      // Backoff from 0.5 s to 8 s. The user has to do nothing.
      this.timer = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, RECONNECT_MAX);
    };

    // onerror is always followed by onclose; handling it in one place is enough.
    ws.onerror = () => {};
  }

  /// One frame from the daemon, in the order they came.
  receive(data, ws) {
    if (typeof data !== 'string') {
      const view = new DataView(data);
      const id = view.getUint32(0, true);
      const bytes = new Uint8Array(data, 4);
      if (this.packedFor !== id) {
        this.emit('onOutput', id, bytes);
        return;
      }
      // A packed replay. Everything behind it waits until it is on screen.
      this.packedFor = null;
      this.backlog = [];
      inflate(bytes)
        .then(
          (out) => {
            if (this.ws === ws) this.emit('onOutput', id, out);
          },
          () => {
            // Never asked again on this connection; the screen is put right
            // by an unpacked replay instead.
            this.inflate = false;
            if (this.ws === ws) this.emit('onResync', {});
          },
        )
        .finally(() => {
          if (this.ws !== ws) return;
          const held = this.backlog;
          this.backlog = null;
          while (held.length) {
            // Another packed replay among them holds the rest back again.
            if (this.backlog) {
              this.backlog.push(...held);
              return;
            }
            this.receive(held.shift(), ws);
          }
        });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.t === 'pong') {
      // Arriving is the whole message; what it proves is that this peer
      // answers at all, which is what lets the timeout below arm.
      this.answers = true;
      // And how long the round trip took — the network's share of a slow
      // echo, for the typing telemetry.
      if (this.pingAt) this.rtt = Math.round(performance.now() - this.pingAt);
      this.pingAt = 0;
      return;
    }
    const map = {
      state: 'onState',
      terminals: 'onTerminals',
      attached: 'onAttached',
      size: 'onSize',
      exit: 'onExit',
      error: 'onError',
      mem: 'onMem',
      load: 'onLoad',
      config: 'onConfig',
      agent_version: 'onAgentVersion',
      dropped: 'onDropped',
      dir: 'onDir',
      tree: 'onTree',
      changes: 'onChanges',
      change_diff: 'onChangeDiff',
      change_record: 'onChangeRecord',
      show: 'onShow',
      shortcuts: 'onShortcuts',
      made: 'onMade',
      file: 'onFile',
      saved: 'onSaved',
      last_command: 'onLastCommand',
      remotes: 'onRemotes',
      token_rotated: 'onTokenRotated',
      cloudflare: 'onCloudflare',
      local_https: 'onLocalHttps',
      update: 'onUpdate',
      resync: 'onResync',
      replay: 'onReplay',
    };
    // The bytes right behind a packed replay are DEFLATE; noted before the
    // handler runs, so the frame is recognised whatever the handler does.
    if (msg.t === 'replay' && msg.deflate) this.packedFor = msg.id;
    const fn = map[msg.t];
    if (fn) this.emit(fn, msg);
  }

  /// Send a ping on a timer, and give up on a link that has gone quiet.
  ///
  /// Closing the socket ourselves is what makes this work: `onclose` then fires
  /// for real, and the reconnect below runs exactly as it does for a link that
  /// died loudly. There is no second recovery path to keep working.
  startBeat() {
    this.stopBeat();
    this.beat = setInterval(() => {
      if (!this.ready) return;
      if (this.answers && Date.now() - this.lastSeen > SILENT_MS) {
        this.lostWhy = 'silent';
        this.emit('onStatus', 'lost');
        try {
          this.ws.close();
        } catch {
          // already gone; onclose still runs
        }
        return;
      }
      this.pingAt = performance.now();
      this.send({ t: 'ping' });
    }, PING_MS);
  }

  stopBeat() {
    clearInterval(this.beat);
    this.beat = null;
    clearTimeout(this.probing);
    this.probing = null;
  }

  /// Is this link really alive? Asked when there is reason to doubt it: the page
  /// came back into view or back online, or keys were sent into a link that has
  /// said nothing for a while.
  ///
  /// Waiting out a backoff, it reconnects now. Open, it pings, and with nothing
  /// at all back within `PROBE_MS` it is treated as the dead line it is. Only for
  /// a peer known to answer pings — silence from one that never does proves
  /// nothing, the same rule `startBeat` follows.
  probe() {
    if (this.closedByUs) return;
    if (!this.ready) {
      // Parked stays parked while the page is still out of sight: the network
      // coming back, or a focus event, on a phone in a pocket is not someone
      // looking.
      if (this.parked && document.hidden) return;
      if (this.timer || this.parked) this.retry();
      return;
    }
    if (!this.answers || this.probing) return;
    const asked = Date.now();
    this.probing = setTimeout(() => {
      this.probing = null;
      if (this.ready && this.lastSeen < asked) {
        this.lostWhy = 'probe';
        this.emit('onStatus', 'lost');
        this.retry();
      }
    }, PROBE_MS);
    this.pingAt = performance.now();
    this.send({ t: 'ping' });
  }

  /// Connect again right now, by hand.
  ///
  /// The backoff waits up to 8 s between attempts, and a handshake can sit
  /// for `DIAL_MS` before it is given up on. Someone watching a tab that says
  /// "reconnecting…" while their Wi-Fi has just come back should not have to
  /// wait out either. The old socket is let go without a word — its `onclose`
  /// would otherwise start a second reconnect of its own.
  retry() {
    if (this.closedByUs) return;
    this.parked = false;
    clearTimeout(this.timer);
    this.timer = null;
    clearTimeout(this.dial);
    this.stopBeat();
    const old = this.ws;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try {
        old.close();
      } catch {
        // already gone
      }
    }
    this.delay = RECONNECT_MIN;
    this.connect();
  }

  /// Close for good — no reconnect. Used when the machine is forgotten.
  close() {
    this.closedByUs = true;
    clearTimeout(this.timer);
    clearTimeout(this.dial);
    this.stopBeat();
    try {
      this.ws?.close();
    } catch {
      // no point complaining about an already dead socket
    }
  }

  emit(name, ...args) {
    const fn = this.on[name];
    // `owner` is always the last argument: a handler that does not care which
    // machine can simply ignore it.
    if (fn) fn(...args, this.owner);
  }

  get ready() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  send(obj) {
    if (this.ready) this.ws.send(JSON.stringify(obj));
  }

  /// Keyboard input: the terminal id as 4 little-endian bytes, then raw bytes.
  sendInput(id, text) {
    // Typing into a link that has gone quiet is exactly when a dead one shows:
    // the keys go nowhere and nothing comes back. Probe it rather than leave
    // the screen silent until the minute-long timeout notices.
    if (Date.now() - this.lastSeen > 5000) this.probe();
    if (!this.ready) return;
    const body = new TextEncoder().encode(text);
    const frame = new Uint8Array(4 + body.length);
    new DataView(frame.buffer).setUint32(0, id, true);
    frame.set(body, 4);
    this.ws.send(frame);
  }

  /// Send one file to the daemon. Binary on purpose, not JSON+base64: a 3 MB
  /// screenshot would become 4 MB once encoded.
  ///
  /// 0xFFFFFFFF + terminal id + name length (u16 LE) + name + file contents.
  sendDrop(id, name, bytes) {
    if (!this.ready) return false;
    const label = new TextEncoder().encode(name);
    const frame = new Uint8Array(10 + label.length + bytes.length);
    const view = new DataView(frame.buffer);
    view.setUint32(0, 0xffffffff, true);
    view.setUint32(4, id, true);
    view.setUint16(8, label.length, true);
    frame.set(label, 10);
    frame.set(bytes, 10 + label.length);
    this.ws.send(frame);
    return true;
  }
}
