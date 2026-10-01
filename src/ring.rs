//! Per-terminal output ring buffer. It holds raw bytes, not grid state —
//! enough to replay on attach, and far simpler. If identical grids across
//! clients are ever needed, an authoritative parser replaces this module
//! rather than patching it here.

use std::collections::VecDeque;

pub struct Ring {
    buf: VecDeque<u8>,
    cap: usize,
    /// Every byte ever pushed, kept or not: the stream position just past the
    /// newest byte. A client that counts what it received names a position in
    /// the same terms, which is what lets it resume rather than replay.
    total: u64,
}

/// How much of what a resuming client already has is compared before it is
/// believed (see `resume`).
pub const RESUME_TAIL: u64 = 256;

/// FNV-1a, 32 bit — the same few lines in the page, so both ends can name a
/// stretch of output without sending it.
pub fn fnv1a(bytes: impl IntoIterator<Item = u8>) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

impl Ring {
    pub fn new(cap: usize) -> Ring {
        Ring { buf: VecDeque::new(), cap, total: 0 }
    }

    /// The stream position just past the newest byte.
    pub fn end(&self) -> u64 {
        self.total
    }

    /// What came after `since`, for a client that already has everything up to
    /// it — `None` when it must have the whole buffer replayed instead.
    ///
    /// The client's word is not taken for it: `tail` is its hash of the
    /// `RESUME_TAIL` bytes it holds just before `since`, and they must match
    /// what is here. A client that missed a chunk on the way (a full queue
    /// drops the oldest) counts fewer bytes than were sent, so its position
    /// points at other bytes than it holds — and a resume from there would
    /// write the stream onto its screen out of step for good.
    pub fn resume(&self, since: u64, tail: u32) -> Option<Vec<u8>> {
        if since > self.total {
            return None;
        }
        let n = since.min(RESUME_TAIL);
        let start = self.total - self.buf.len() as u64;
        if since - n < start {
            return None;
        }
        let from = (since - start) as usize;
        if fnv1a(self.buf.range(from - n as usize..from).copied()) != tail {
            return None;
        }
        Some(self.buf.range(from..).copied().collect())
    }

    /// Store a chunk of output. Past capacity, the oldest bytes are dropped.
    pub fn push(&mut self, data: &[u8]) {
        if self.cap == 0 {
            return;
        }
        self.total += data.len() as u64;
        // A chunk larger than the whole buffer: its tail is all that fits.
        let data = if data.len() > self.cap { &data[data.len() - self.cap..] } else { data };

        let overflow = (self.buf.len() + data.len()).saturating_sub(self.cap);
        if overflow > 0 {
            self.buf.drain(..overflow);
        }
        self.buf.extend(data.iter().copied());
    }

    /// A copy of the buffer, oldest first.
    pub fn snapshot(&self) -> Vec<u8> {
        let (a, b) = self.buf.as_slices();
        let mut out = Vec::with_capacity(a.len() + b.len());
        out.extend_from_slice(a);
        out.extend_from_slice(b);
        out
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_everything_below_capacity() {
        let mut r = Ring::new(16);
        r.push(b"halo ");
        r.push(b"dunia");
        assert_eq!(r.snapshot(), b"halo dunia");
        assert_eq!(r.len(), 10);
    }

    #[test]
    fn drops_oldest_bytes_past_capacity() {
        let mut r = Ring::new(8);
        r.push(b"abcdef");
        r.push(b"ghij");
        assert_eq!(r.snapshot(), b"cdefghij", "yang tersisa adalah 8 byte terakhir");
        assert_eq!(r.len(), 8);
    }

    #[test]
    fn single_push_larger_than_capacity_keeps_tail() {
        let mut r = Ring::new(4);
        r.push(b"abcdefghij");
        assert_eq!(r.snapshot(), b"ghij");
        assert_eq!(r.len(), 4);
    }

    #[test]
    fn never_exceeds_capacity_across_many_pushes() {
        let mut r = Ring::new(100);
        for i in 0..1000u32 {
            r.push(&i.to_le_bytes());
        }
        assert_eq!(r.len(), 100);
        // The last 100 bytes = the last 25 u32s (975..1000).
        let expected: Vec<u8> = (975..1000u32).flat_map(|i| i.to_le_bytes()).collect();
        assert_eq!(r.snapshot(), expected);
    }

    #[test]
    fn snapshot_is_contiguous_after_wraparound() {
        let mut r = Ring::new(5);
        r.push(b"12345");
        r.push(b"67");
        assert_eq!(r.snapshot(), b"34567");
        r.push(b"89");
        assert_eq!(r.snapshot(), b"56789");
    }

    #[test]
    fn empty_ring_snapshots_empty() {
        let r = Ring::new(2 * 1024 * 1024);
        assert!(r.is_empty());
        assert!(r.snapshot().is_empty());
    }

    #[test]
    fn a_client_that_has_everything_up_to_a_point_gets_the_rest() {
        let mut r = Ring::new(1024);
        r.push(b"hello ");
        let since = r.end();
        let tail = fnv1a(b"hello ".iter().copied());
        r.push(b"world");
        assert_eq!(r.resume(since, tail).as_deref(), Some(&b"world"[..]));
        assert_eq!(r.resume(r.end(), fnv1a(b"hello world".iter().copied())).as_deref(), Some(&b""[..]));
    }

    #[test]
    fn a_resume_whose_bytes_do_not_match_is_refused() {
        let mut r = Ring::new(1024);
        r.push(b"abcdefgh");
        // Claims 4 bytes, but holds "abce" — it missed one, and counts short.
        assert!(r.resume(4, fnv1a(b"abce".iter().copied())).is_none());
        assert!(r.resume(4, fnv1a(b"abcd".iter().copied())).is_some());
    }

    #[test]
    fn a_resume_from_before_what_is_kept_is_refused() {
        let stream: Vec<u8> = (0..600u32).map(|i| (i % 251) as u8).collect();
        let mut r = Ring::new(300);
        r.push(&stream); // only the last 300 kept: positions 300..600
        assert_eq!(r.end(), 600);
        let tail_at = |since: usize| fnv1a(stream[since - RESUME_TAIL as usize..since].iter().copied());
        assert!(r.resume(400, tail_at(400)).is_none(), "the tail it vouches with is already gone");
        assert!(r.resume(700, 0).is_none(), "beyond the end — another terminal, or a restart");
        assert_eq!(r.resume(580, tail_at(580)).as_deref(), Some(&stream[580..]));
    }

    #[test]
    fn the_hash_matches_the_page() {
        // web/app.js computes the same thing; a pinned value keeps them in step.
        assert_eq!(fnv1a(b"sessionhub".iter().copied()), 0x3c24_ca7e);
    }

    #[test]
    fn zero_capacity_stores_nothing() {
        let mut r = Ring::new(0);
        r.push(b"apapun");
        assert!(r.snapshot().is_empty());
    }
}
