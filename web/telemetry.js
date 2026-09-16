// What is done on this page, batched and handed to the daemon for its local
// behaviour log. Nothing here is content — no paths, no titles, no keystrokes —
// only the shape of use: which action, by what means, how long it took.
//
// Cheap on purpose. An event is one small object pushed onto an array; the
// array goes out over the socket that is open anyway, every few seconds or
// when it has grown enough, and when the page is put away. Nothing is
// awaited, nothing is stored, and a daemon that never gets the batch — the
// link is down, the tab is closed first — loses a few lines of statistics,
// which is the right trade.

/// How long a batch waits for company before it is sent.
const FLUSH_MS = 15000;

/// Or how many events send it sooner.
const FLUSH_AT = 40;

/// Kept while the link is down. Past this the oldest go.
const QUEUE_MAX = 200;

export class Telemetry {
  /// `send(events)` hands a batch to the daemon and returns whether it could;
  /// a batch it could not take stays queued for the next try.
  constructor(send) {
    this.send = send;
    this.q = [];
    this.timer = null;
    // The page going away is the one moment the queue must not wait for a
    // timer. `pagehide` is the reliable signal on phones; `visibilitychange`
    // catches a tab put in the background and kept there.
    addEventListener('pagehide', () => this.flush());
    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush();
    });
  }

  /// Note that `e` happened, with a few scalar `fields`.
  track(e, fields = null) {
    const ev = { e, ts: Date.now() };
    if (fields) Object.assign(ev, fields);
    this.q.push(ev);
    if (this.q.length > QUEUE_MAX) this.q.splice(0, this.q.length - QUEUE_MAX);
    if (this.q.length >= FLUSH_AT) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.q.length) return;
    if (this.send(this.q)) this.q = [];
    // Not sent: the batch stays, and the next event or the next flush tries
    // again. No timer is armed for it — the next event arms one.
  }
}
