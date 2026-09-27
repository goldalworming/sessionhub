//! Strip ANSI/VT100 control sequences out of raw terminal bytes, for `capture`.
//!
//! This is linear scrollback, not a rendered screen: a `\r`-based progress-bar
//! redraw leaves every intermediate frame in the output, not just the last
//! one — the same trade-off `src/ring.rs` already makes for the same reason.
//! A real terminal-grid emulator would fix that; it is not a dependency this
//! project carries, and nothing here needs it yet.

/// Strip ANSI/VT100 control sequences from raw terminal bytes, leaving plain,
/// readable text. `\r` and `\n` are kept — they are real line structure, not
/// decoration — everything else that starts with ESC (0x1b) or is a C0/C1
/// control byte is dropped.
pub fn strip_ansi(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        match input[i] {
            0x1b if input.get(i + 1) == Some(&b'[') => {
                // CSI: ESC [ <params 0x30-0x3F>* <intermediates 0x20-0x2F>* <final 0x40-0x7E>
                // Covers cursor moves and every SGR colour code alike — the
                // whole sequence is dropped uniformly, so a colour code needs
                // no special case of its own.
                i += 2;
                while i < input.len() && (0x30..=0x3f).contains(&input[i]) {
                    i += 1;
                }
                while i < input.len() && (0x20..=0x2f).contains(&input[i]) {
                    i += 1;
                }
                if i < input.len() {
                    i += 1; // the final byte
                }
            }
            0x1b if input.get(i + 1) == Some(&b']') => {
                i += 2;
                i = skip_string_sequence(input, i);
            }
            0x1b if matches!(input.get(i + 1), Some(b'P') | Some(b'^') | Some(b'_')) => {
                // DCS / PM / APC — same ST-or-BEL-terminated shape as OSC.
                i += 2;
                i = skip_string_sequence(input, i);
            }
            0x1b => i += 2, // a two-byte escape (ESC =, ESC >, ...) — skip both
            0x08 => {
                out.pop();
                i += 1;
            }
            0x00..=0x06 | 0x0e..=0x1a | 0x1c..=0x1f | 0x7f => i += 1,
            _ => {
                let (ch, len) = next_char(&input[i..]);
                out.push(ch);
                i += len;
            }
        }
    }
    out
}

/// `OSC`/`DCS`/`PM`/`APC` all end the same way: `BEL` (0x07), or `ESC \` (the
/// "string terminator"). Returns the index just past whichever ended it, or
/// past the end of `input` if neither ever shows up.
fn skip_string_sequence(input: &[u8], mut i: usize) -> usize {
    while i < input.len() {
        if input[i] == 0x07 {
            return i + 1;
        }
        if input[i] == 0x1b && input.get(i + 1) == Some(&b'\\') {
            return i + 2;
        }
        i += 1;
    }
    i
}

/// One UTF-8 character starting at the front of `bytes`, and how many bytes it
/// took — the replacement character for anything that does not decode, so one
/// bad byte in a stream never loses the rest of it.
fn next_char(bytes: &[u8]) -> (char, usize) {
    match std::str::from_utf8(bytes) {
        Ok(s) => {
            let ch = s.chars().next().expect("bytes is non-empty");
            (ch, ch.len_utf8())
        }
        Err(e) if e.valid_up_to() > 0 => {
            let s = std::str::from_utf8(&bytes[..e.valid_up_to()]).expect("checked valid");
            let ch = s.chars().next().expect("valid_up_to is non-empty");
            (ch, ch.len_utf8())
        }
        Err(_) => ('\u{fffd}', 1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_untouched() {
        assert_eq!(strip_ansi(b"hello\nworld\r\n"), "hello\nworld\r\n");
    }

    #[test]
    fn a_bare_csi_sequence_is_dropped() {
        assert_eq!(strip_ansi(b"a\x1b[2Jb"), "ab");
    }

    #[test]
    fn sgr_colour_codes_are_dropped() {
        assert_eq!(strip_ansi(b"\x1b[31mred\x1b[0m plain"), "red plain");
        assert_eq!(strip_ansi(b"\x1b[1;32;40mstyled\x1b[m"), "styled");
    }

    #[test]
    fn osc_terminated_by_bel_is_dropped() {
        // A hyperlink: title set, then a hyperlink around some text, then closed.
        assert_eq!(strip_ansi(b"\x1b]0;title\x07visible"), "visible");
        assert_eq!(
            strip_ansi(b"\x1b]8;;http://x\x07text\x1b]8;;\x07"),
            "text"
        );
    }

    #[test]
    fn osc_terminated_by_st_is_dropped() {
        assert_eq!(strip_ansi(b"\x1b]0;title\x1b\\visible"), "visible");
    }

    #[test]
    fn dcs_sequence_is_dropped() {
        assert_eq!(strip_ansi(b"a\x1bPsome dcs stuff\x1b\\b"), "ab");
    }

    #[test]
    fn backspace_erases_the_previous_character() {
        assert_eq!(strip_ansi(b"abc\x08\x08d"), "ad");
    }

    #[test]
    fn backspace_on_an_empty_line_does_not_panic() {
        assert_eq!(strip_ansi(b"\x08\x08a"), "a");
    }

    #[test]
    fn truncated_utf8_at_the_end_is_replaced_not_dropped_silently() {
        // A 2-byte sequence's lead byte with nothing after it.
        let got = strip_ansi(&[b'a', 0xC3]);
        assert_eq!(got, "a\u{fffd}");
    }

    #[test]
    fn an_unterminated_escape_at_end_of_input_does_not_hang_or_panic() {
        assert_eq!(strip_ansi(b"a\x1b["), "a");
        assert_eq!(strip_ansi(b"a\x1b]0;no terminator"), "a");
    }

    #[test]
    fn carriage_returns_and_newlines_survive() {
        assert_eq!(strip_ansi(b"line1\r\nline2\rline3\n"), "line1\r\nline2\rline3\n");
    }
}
