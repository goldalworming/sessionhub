// The WS connection: one per tab, with reconnects on a rising backoff.
// This module knows nothing about the DOM.

const RECONNECT_MIN = 500;
const RECONNECT_MAX = 8000;

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
      this.emit('onStatus', 'open');
    };

    ws.onmessage = (ev) => {
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
      if (this.closedByUs) return;
      this.emit('onStatus', 'lost');
      // Backoff from 0.5 s to 8 s. The user has to do nothing.
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, RECONNECT_MAX);
    };

    // onerror is always followed by onclose; handling it in one place is enough.
    ws.onerror = () => {};
  }

  /// Close for good — no reconnect. Used when the machine is forgotten.
  close() {
    this.closedByUs = true;
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
