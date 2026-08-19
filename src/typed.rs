//! What is being typed at a shell prompt, tracked from the bytes going in.
//!
//! Naming a terminal is only half of remembering it — the other half is the
//! command it was running, and asking the user to type that a second time is
//! asking them to remember exactly the thing they wanted written down. So the
//! input stream is watched and the last command offered as the default.
//!
//! The rule that matters most here is knowing when NOT to answer. This tracker
//! sees keystrokes, not the shell's own line editor: press ↑ and the shell
//! replaces the line with one from its history that was never typed through
//! here; press Tab and it completes a word we never saw. In both cases what we
//! hold stops matching what is on screen. Guessing then would put a command
//! into a saved terminal that the user never ran — so instead the line is
//! marked untrustworthy and `last()` says nothing. An empty box the user fills
//! in is a small annoyance; a wrong command that runs on every open is a bug
//! they would have to hunt.

/// Longest line worth following. A paste bigger than this is not somebody
/// typing a command, and holding on to it only grows the terminal's memory.
const MAX_LINE: usize = 4096;

/// How much of a command is kept. Long enough for a real invocation with
/// arguments, short enough that config.toml stays readable.
pub const MAX_COMMAND: usize = 2000;

#[derive(Debug, Default)]
pub struct TypedLine {
    /// The line as it has been typed so far. Bytes, not text: a UTF-8 character
    /// arrives across several keystrokes and only becomes one when read.
    line: Vec<u8>,
    /// The last line submitted with Enter, when it can be trusted.
    last: String,
    /// Set when something happened that the shell handled and we did not see —
    /// history recall, tab completion, an editing key. Cleared at the next
    /// Enter, because the line after it starts fresh.
    dirty: bool,
    /// Escape-sequence parser state: 0 outside one, 1 just after ESC, 2 inside
    /// the parameters of a CSI or SS3 sequence.
    esc: u8,
    /// The sequence being parsed, kept so bracketed paste can be recognised.
    seq: String,
    /// Inside a bracketed paste, where the bytes really do land in the line.
    pasting: bool,
}

impl TypedLine {
    /// The last command, or empty when there is nothing we can honestly claim
    /// was run.
    pub fn last(&self) -> &str {
        &self.last
    }

    pub fn feed(&mut self, data: &[u8]) {
        for &b in data {
            self.byte(b);
        }
    }

    fn byte(&mut self, b: u8) {
        match self.esc {
            1 => {
                self.seq.push(b as char);
                // A CSI (`ESC [`) or SS3 (`ESC O`) has parameters to come;
                // anything else is a two-byte sequence, already complete.
                match b {
                    b'[' | b'O' => self.esc = 2,
                    b']' => self.esc = 3,
                    _ => {
                        self.esc = 0;
                        self.dirty = true;
                    }
                }
                return;
            }
            2 => {
                self.seq.push(b as char);
                // A CSI ends at its first byte in 0x40..=0x7E.
                if !(0x40..=0x7e).contains(&b) {
                    return;
                }
                self.esc = 0;
                match self.seq.as_str() {
                    // Bracketed paste. The text between the markers is genuinely
                    // inserted into the line, so following it keeps the tracker
                    // right for anyone who pastes a command instead of typing it
                    // — which is exactly what the Paste button does on a phone.
                    "[200~" => self.pasting = true,
                    "[201~" => self.pasting = false,
                    _ if is_report(&self.seq) => {}
                    _ => self.dirty = true,
                }
                return;
            }
            // An OSC runs until BEL or ST and can carry arbitrary text — a colour
            // query answer, for one. Letting its body fall through would paste
            // that text into the line we are tracking.
            3 => {
                if b == 0x07 {
                    self.esc = 0;
                } else if b == 0x1b {
                    self.esc = 4;
                }
                return;
            }
            4 => {
                self.esc = 0;
                return;
            }
            _ => {}
        }

        match b {
            0x1b => {
                self.esc = 1;
                self.seq.clear();
            }
            // Enter. A shell may send either, and CRLF must not count twice —
            // the second one lands on an empty line and is ignored anyway.
            b'\r' | b'\n' => {
                if self.pasting {
                    // Inside a paste this inserts a line break rather than
                    // running anything. Several lines are not one command, so
                    // there is nothing here worth naming.
                    self.dirty = true;
                    return;
                }
                let text = String::from_utf8_lossy(&self.line);
                let line = text.trim();
                if self.dirty {
                    // Something ran and we could not see what. The tracked line
                    // being empty is no comfort here — that is exactly what ↑
                    // and Enter looks like from this side, and the command that
                    // ran was a different one from whatever we still hold.
                    // Saying nothing is the only honest answer.
                    self.last.clear();
                } else if !line.is_empty() {
                    self.last = line.chars().take(MAX_COMMAND).collect();
                }
                // A bare Enter on a clean line runs nothing, and leaves the last
                // command as it was.
                self.line.clear();
                self.dirty = false;
            }
            // Backspace, in both the shapes terminals send it. A whole character
            // goes, not one byte of one.
            0x08 | 0x7f => {
                while self.line.last().is_some_and(|b| b & 0xc0 == 0x80) {
                    self.line.pop();
                }
                self.line.pop();
            }
            // Ctrl-C and Ctrl-U throw the line away; so does Ctrl-W, roughly
            // enough that following it is not worth the guesswork.
            0x03 | 0x15 | 0x17 => {
                self.line.clear();
                self.dirty = false;
            }
            // Tab: the shell completes a word we never saw.
            b'\t' => self.dirty = true,
            _ => {
                // Any other control byte is an editing key whose effect happens
                // inside the shell, out of our sight.
                if b < 0x20 {
                    self.dirty = true;
                    return;
                }
                if self.line.len() >= MAX_LINE {
                    self.line.clear();
                    self.dirty = true;
                    return;
                }
                self.line.push(b);
            }
        }
    }
}

/// Is this CSI the terminal reporting about itself rather than the user editing
/// the line?
///
/// The distinction is the whole reliability of this tracker. An arrow key or a
/// Delete changes the line where we cannot see it, and must poison what we hold.
/// A focus report does not: the browser tab sends `ESC[I` and `ESC[O` every time
/// it gains or loses focus, and a phone switching apps sends a stream of them.
/// Treating those as edits meant the command was almost never captured in a real
/// browser — found by watching a real terminal, not by reasoning about it.
fn is_report(seq: &str) -> bool {
    match seq {
        // Focus in / focus out.
        "[I" | "[O" => true,
        _ => match seq.as_bytes().last() {
            // Mouse position and button reports.
            Some(b'M') | Some(b'm') => true,
            // Cursor position report, the answer to `ESC[6n`.
            Some(b'R') => true,
            // Device attributes, the answer to `ESC[c`.
            Some(b'c') => seq.starts_with("[?") || seq.starts_with("[>"),
            _ => false,
        },
    }
}

/// Make a bare filename runnable from the folder it sits in.
///
/// Neither PowerShell nor sh will run `thing.bat` from the current directory —
/// the current directory is deliberately not on the path, and you have to write
/// `.\thing.bat`. At a prompt the shell tells you so. Stored as a saved
/// terminal's command it says nothing: the shell opens, the command fails into a
/// terminal nobody is watching, and the service you thought you started is not
/// running. That happened for real, to two services, and the only clue was an
/// error scrolled off a panel that was never opened.
///
/// So: if the first word names a file that exists in the project folder and
/// carries no path of its own, it is written the way the shell needs. Everything
/// else is left exactly as typed — a name that is not a file here is meant for
/// the PATH, and rewriting it would break it.
pub fn runnable(dir: &std::path::Path, command: &str) -> String {
    let trimmed = command.trim_start();
    // Quoted, so the writer has already been explicit about what they mean.
    if trimmed.starts_with('"') || trimmed.starts_with('\'') {
        return command.to_string();
    }
    let Some(first) = trimmed.split_whitespace().next() else {
        return command.to_string();
    };
    // Already a path: relative, absolute, or with a directory in it.
    if first.starts_with('.')
        || first.starts_with('/')
        || first.starts_with('\\')
        || first.starts_with('~')
        || first.contains('/')
        || first.contains('\\')
        || first.contains(':')
    {
        return command.to_string();
    }
    if !dir.join(first).is_file() {
        return command.to_string();
    }
    let prefix = if cfg!(windows) { ".\\" } else { "./" };
    format!("{prefix}{}", trimmed)
}

/// Strip what must never reach a shell as a stored command: the newline that
/// would make it run something on the next line, and other control bytes.
/// Returns the cleaned command, cut to `MAX_COMMAND`.
pub fn clean_command(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control())
        .take(MAX_COMMAND)
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn typed(chunks: &[&str]) -> TypedLine {
        let mut t = TypedLine::default();
        for c in chunks {
            t.feed(c.as_bytes());
        }
        t
    }

    #[test]
    fn a_typed_command_is_remembered() {
        let t = typed(&[".\\@run-telegram-bot.bat\r"]);
        assert_eq!(t.last(), ".\\@run-telegram-bot.bat");
    }

    #[test]
    fn it_arrives_one_keystroke_at_a_time() {
        // Which is how it really arrives: one WS frame per key.
        let mut t = TypedLine::default();
        for c in "npm run dev".chars() {
            t.feed(c.to_string().as_bytes());
        }
        assert_eq!(t.last(), "", "belum ditekan Enter");
        t.feed(b"\r");
        assert_eq!(t.last(), "npm run dev");
    }

    #[test]
    fn backspace_takes_a_character_back() {
        let t = typed(&["lsx\x7f\r"]);
        assert_eq!(t.last(), "ls");
    }

    #[test]
    fn backspace_removes_a_whole_character_not_one_byte_of_one() {
        // "é" is two bytes; dropping one leaves a broken character behind.
        let t = typed(&["echo é\x7f\r"]);
        assert_eq!(t.last(), "echo");
    }

    #[test]
    fn a_command_with_non_ascii_survives_intact() {
        let t = typed(&["echo héllo → dunia\r"]);
        assert_eq!(t.last(), "echo héllo → dunia");
    }

    #[test]
    fn the_newest_command_replaces_the_one_before() {
        let t = typed(&["ls\r", "cargo build\r"]);
        assert_eq!(t.last(), "cargo build");
    }

    #[test]
    fn a_command_recalled_from_history_is_not_claimed() {
        // ↑ makes the shell put a line on screen that never came through here.
        // Answering with what we happen to hold would name the wrong command.
        let t = typed(&["\x1b[A\r"]);
        assert_eq!(t.last(), "", "riwayat shell tidak terlihat dari sini");
    }

    #[test]
    fn history_recall_does_not_leave_an_older_command_behind() {
        // The dangerous shape: a real command, then a different one recalled
        // with ↑. Keeping the first would offer to run something that is not
        // what actually ran.
        let t = typed(&["cargo build\r", "\x1b[A\r"]);
        assert_eq!(t.last(), "");
    }

    #[test]
    fn tab_completion_is_not_guessed_at() {
        let t = typed(&["cd ses\t\r"]);
        assert_eq!(t.last(), "");
    }

    #[test]
    fn the_line_after_an_untrusted_one_is_trusted_again() {
        let t = typed(&["\x1b[A\r", "ls -la\r"]);
        assert_eq!(t.last(), "ls -la");
    }

    #[test]
    fn ctrl_c_abandons_the_line_without_recording_it() {
        let t = typed(&["rm -rf /\x03", "ls\r"]);
        assert_eq!(t.last(), "ls");
    }

    #[test]
    fn a_pasted_command_is_followed_through_its_markers() {
        // The Paste button sends bracketed paste. The text between the markers
        // really does land in the line, so it stays trustworthy.
        let t = typed(&["\x1b[200~npm run dev\x1b[201~\r"]);
        assert_eq!(t.last(), "npm run dev");
    }

    #[test]
    fn a_multi_line_paste_is_not_reduced_to_its_first_line() {
        let t = typed(&["\x1b[200~cd app\nnpm start\x1b[201~\r"]);
        assert_eq!(t.last(), "", "beberapa baris bukan satu perintah");
    }

    #[test]
    fn a_focus_report_does_not_count_as_editing_the_line() {
        // The one that broke this in a real browser: xterm sends ESC[I and ESC[O
        // whenever the tab gains or loses focus, so clicking anything at all put
        // one in the middle of the command being typed.
        let t = typed(&["npm ", "\x1b[O", "\x1b[I", "run dev\r"]);
        assert_eq!(t.last(), "npm run dev");
    }

    #[test]
    fn mouse_and_cursor_reports_are_ignored_too() {
        // Scrolling sends mouse reports; a shell asking where the cursor is gets
        // an answer back through this same stream.
        let t = typed(&["ls", "\x1b[<64;10;5M", "\x1b[<64;10;5m", "\x1b[12;40R", " -la\r"]);
        assert_eq!(t.last(), "ls -la");
    }

    #[test]
    fn an_osc_reply_does_not_leak_its_text_into_the_line() {
        // A colour query is answered with text; letting it through would store
        // `rgb:1e1e/1e1e/1e1e` as part of the command.
        let t = typed(&["ls", "\x1b]11;rgb:1e1e/1e1e/1e1e\x07", " -la\r"]);
        assert_eq!(t.last(), "ls -la");

        // The other terminator: ST, written as ESC backslash.
        let t = typed(&["ls", "\x1b]11;rgb:00/00/00\x1b\\", " -la\r"]);
        assert_eq!(t.last(), "ls -la");
    }

    #[test]
    fn an_arrow_key_is_still_an_edit_we_cannot_see() {
        // The reports above are ignored by shape, not by giving up on the idea —
        // real editing keys must still poison the line.
        for key in ["\x1b[A", "\x1b[D", "\x1b[3~", "\x1bOP", "\x1b[H"] {
            let t = typed(&["ls", key, " -la\r"]);
            assert_eq!(t.last(), "", "{key:?} mengubah baris di luar penglihatan kita");
        }
    }

    #[test]
    fn an_empty_enter_changes_nothing() {
        let t = typed(&["ls\r", "\r", "\r"]);
        assert_eq!(t.last(), "ls");
    }

    #[test]
    fn crlf_is_one_press_not_two() {
        let t = typed(&["ls\r\n"]);
        assert_eq!(t.last(), "ls");
    }

    #[test]
    fn arrow_keys_within_a_line_are_not_guessed_at() {
        // ← then typing inserts in the middle; our copy would say otherwise.
        let t = typed(&["ls -l\x1b[Da\r"]);
        assert_eq!(t.last(), "");
    }

    #[test]
    fn a_giant_paste_does_not_grow_without_bound() {
        let mut t = TypedLine::default();
        t.feed(&vec![b'x'; MAX_LINE * 3]);
        assert!(t.line.len() <= MAX_LINE);
        t.feed(b"\r");
        assert_eq!(t.last(), "", "isi sebesar itu bukan perintah yang diketik");
    }

    #[test]
    fn a_very_long_command_is_cut_not_refused() {
        let long = "echo ".to_string() + &"a".repeat(MAX_COMMAND * 2);
        let mut t = TypedLine::default();
        t.feed(long.as_bytes());
        t.feed(b"\r");
        assert_eq!(t.last().chars().count(), MAX_COMMAND);
        assert!(t.last().starts_with("echo aaa"));
    }

    #[test]
    fn clean_command_strips_what_would_run_a_second_line() {
        // The one that matters: a newline inside a stored command turns one
        // command into two, and the second one is invisible in the UI.
        assert_eq!(clean_command("ls\rrm -rf /"), "lsrm -rf /");
        assert_eq!(clean_command("ls\nwhoami"), "lswhoami");
        assert_eq!(clean_command("  npm run dev  "), "npm run dev");
        assert_eq!(clean_command(""), "");
    }

    #[test]
    fn a_script_in_the_project_folder_is_made_runnable() {
        // The real case: two saved terminals stored `0run-telegram-bot.bat`, the
        // shell refused to run it from the current directory, and both services
        // were quietly not running.
        let dir = std::env::temp_dir().join("sessionhub-runnable-test");
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("0run-telegram-bot.bat");
        std::fs::write(&script, b"@echo off\n").unwrap();

        let want = if cfg!(windows) {
            ".\\0run-telegram-bot.bat"
        } else {
            "./0run-telegram-bot.bat"
        };
        assert_eq!(runnable(&dir, "0run-telegram-bot.bat"), want);
        // Arguments survive.
        assert_eq!(
            runnable(&dir, "0run-telegram-bot.bat --once"),
            format!("{want} --once")
        );

        std::fs::remove_file(&script).ok();
    }

    #[test]
    fn anything_that_is_not_a_file_here_is_left_alone() {
        let dir = std::env::temp_dir().join("sessionhub-runnable-empty");
        std::fs::create_dir_all(&dir).unwrap();

        // Meant for the PATH; prefixing it would break it.
        assert_eq!(runnable(&dir, "npm run dev"), "npm run dev");
        assert_eq!(runnable(&dir, "cargo build --release"), "cargo build --release");
        assert_eq!(runnable(&dir, ""), "");
    }

    #[test]
    fn a_command_that_already_says_where_it_is_is_untouched() {
        let dir = std::env::temp_dir().join("sessionhub-runnable-test2");
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("go.bat");
        std::fs::write(&script, b"@echo off\n").unwrap();

        // Every shape that already carries a path of its own.
        for already in [
            ".\\go.bat",
            "./go.bat",
            "..\\go.bat",
            "C:\\tools\\go.bat",
            "/usr/local/bin/go.bat",
            "~/go.bat",
            "sub/go.bat",
            "\"go.bat\"",
        ] {
            assert_eq!(runnable(&dir, already), already, "{already}");
        }

        std::fs::remove_file(&script).ok();
    }

    #[test]
    fn clean_command_keeps_ordinary_shell_punctuation() {
        // Quotes, pipes and backslashes are how real commands are written; only
        // control bytes are the problem.
        let cmd = r#"pwsh -c "Get-Content .\log | Select -Last 20""#;
        assert_eq!(clean_command(cmd), cmd);
    }
}
