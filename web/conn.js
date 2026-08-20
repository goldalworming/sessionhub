// The WS connection: one per tab, with reconnects on a rising backoff.
// This module knows nothing about the DOM.

const RECONNECT_MIN = 500;
const RECONNECT_MAX = 8000;

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
    /// Has the other end ever answered a ping?
    ///
    /// Silence only means a dead link if the peer would have spoken. A daemon
    /// older than this feature never answers, and treating that as death would
    /// tear down a perfectly good connection every fifty seconds — which is
    /// worse than the freeze this fixes, and would hit a paired machine that has
    /// not been updated yet, over the relay, where the version is not ours to
    /// choose. So the timeout arms itself only once a pong has been seen.
    this.answers = false;
    // handlers: onState, onAttached, onSize, onExit, onError, onMem,
    //           onOutput(id, bytes), onStatus(kind) — all of them take
    //           `owner` as their last argument.
    this.on = handlers || {};
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const via = this.via ? `&via=${encodeURIComponent(this.via)}` : '';
    const ws = new WebSocket(
      `${proto}//${location.host}/ws?token=${encodeURIComponent(this.token)}${via}`,
    );
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.delay = RECONNECT_MIN;
      this.lastSeen = Date.now();
      // Re-proved per connection: the machine on the other end may have changed
      // version between one socket and the next.
      this.answers = false;
      this.startBeat();
      this.emit('onStatus', 'open');
    };

    ws.onmessage = (ev) => {
      this.lastSeen = Date.now();
      if (typeof ev.data !== 'string') {
        const view = new DataView(ev.data);
        const id = view.getUint32(0, true);
        this.emit('onOutput', id, new Uint8Array(ev.data, 4));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        // Arriving is the whole message; what it proves is that this peer
        // answers at all, which is what lets the timeout below arm.
        this.answers = true;
        return;
      }
      const map = {
        state: 'onState',
        attached: 'onAttached',
        size: 'onSize',
        exit: 'onExit',
        error: 'onError',
        mem: 'onMem',
        config: 'onConfig',
        dropped: 'onDropped',
        dir: 'onDir',
        tree: 'onTree',
        file: 'onFile',
        saved: 'onSaved',
        last_command: 'onLastCommand',
        remotes: 'onRemotes',
        update: 'onUpdate',
      };
      const fn = map[msg.t];
      if (fn) this.emit(fn, msg);
    };

    ws.onclose = () => {
      this.stopBeat();
      if (this.closedByUs) return;
      this.emit('onStatus', 'lost');
      // Backoff from 0.5 s to 8 s. The user has to do nothing.
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, RECONNECT_MAX);
    };

    // onerror is always followed by onclose; handling it in one place is enough.
    ws.onerror = () => {};
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
        this.emit('onStatus', 'lost');
        try {
          this.ws.close();
        } catch {
          // already gone; onclose still runs
        }
        return;
      }
      this.send({ t: 'ping' });
    }, PING_MS);
  }

  stopBeat() {
    clearInterval(this.beat);
    this.beat = null;
  }

  /// Close for good — no reconnect. Used when the machine is forgotten.
  close() {
    this.closedByUs = true;
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
