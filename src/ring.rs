//! Per-terminal output ring buffer. It holds raw bytes, not grid state —
//! enough to replay on attach, and far simpler. If identical grids across
//! clients are ever needed, an authoritative parser replaces this module
//! rather than patching it here.

use std::collections::VecDeque;

pub struct Ring {
    buf: VecDeque<u8>,
    cap: usize,
}

impl Ring {
    pub fn new(cap: usize) -> Ring {
        Ring { buf: VecDeque::new(), cap }
    }

    /// Store a chunk of output. Past capacity, the oldest bytes are dropped.
    pub fn push(&mut self, data: &[u8]) {
        if self.cap == 0 {
            return;
        }
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
    fn zero_capacity_stores_nothing() {
        let mut r = Ring::new(0);
        r.push(b"apapun");
        assert!(r.snapshot().is_empty());
    }
}
