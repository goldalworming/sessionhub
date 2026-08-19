//! Per-terminal memory usage.
//!
//! What is measured is not one process but its whole tree: running `claude`
//! means a shim, a Node runtime, and their children. Reporting only the root
//! would mislead — it is usually the smallest of them.
//!

use std::collections::HashMap;

use sysinfo::{ProcessesToUpdate, System};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalMem {
    pub id: u32,
    pub rss_bytes: u64,
    pub processes: usize,
}

/// Sample a set of (terminal id, root pid) pairs.
///
/// Runs on a short-lived thread, not on the state actor: loading the process
/// table takes tens of milliseconds and the actor must never stall that long.
///
pub fn sample(roots: &[(u32, u32)]) -> Vec<TerminalMem> {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut rss: HashMap<u32, u64> = HashMap::new();
    for (pid, proc_) in sys.processes() {
        let pid = pid.as_u32();
        rss.insert(pid, proc_.memory());
        if let Some(parent) = proc_.parent() {
            children.entry(parent.as_u32()).or_default().push(pid);
        }
    }

    roots
        .iter()
        .map(|&(id, root)| {
            let tree = collect_tree(&children, root);
            TerminalMem {
                id,
                rss_bytes: tree.iter().filter_map(|p| rss.get(p)).sum(),
                processes: tree.iter().filter(|p| rss.contains_key(p)).count(),
            }
        })
        .collect()
}

/// Every pid under `root`, including root itself.
///
/// The system reuses pids, so the walk is guarded against visiting the same
/// pid twice — a single cycle would hang this thread forever.
///
pub fn collect_tree(children: &HashMap<u32, Vec<u32>>, root: u32) -> Vec<u32> {
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if out.contains(&pid) {
            continue;
        }
        out.push(pid);
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(pairs: &[(u32, &[u32])]) -> HashMap<u32, Vec<u32>> {
        pairs.iter().map(|(p, kids)| (*p, kids.to_vec())).collect()
    }

    #[test]
    fn lone_process_is_its_own_tree() {
        assert_eq!(collect_tree(&tree(&[]), 42), vec![42]);
    }

    #[test]
    fn collects_children_and_grandchildren() {
        // shim -> node -> two children: the usual shape of a CLI agent on Windows.
        let t = tree(&[(1, &[2]), (2, &[3, 4])]);
        let mut got = collect_tree(&t, 1);
        got.sort();
        assert_eq!(got, vec![1, 2, 3, 4]);
    }

    #[test]
    fn ignores_branches_outside_the_root() {
        let t = tree(&[(1, &[2]), (9, &[10])]);
        assert_eq!(collect_tree(&t, 1), vec![1, 2]);
    }

    #[test]
    fn cycles_do_not_hang_the_walk() {
        // Can happen when the system reuses a pid while the table is being read.
        let t = tree(&[(1, &[2]), (2, &[1])]);
        let mut got = collect_tree(&t, 1);
        got.sort();
        assert_eq!(got, vec![1, 2]);
    }

    #[test]
    fn repeated_child_entries_are_counted_once() {
        let t = tree(&[(1, &[2, 2, 2])]);
        assert_eq!(collect_tree(&t, 1), vec![1, 2]);
    }

    #[test]
    fn samples_this_process_tree() {
        let me = std::process::id();
        let got = sample(&[(1, me)]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, 1);
        assert!(got[0].rss_bytes > 0, "proses uji ini jelas memakai memori");
        assert!(got[0].processes >= 1);
    }

    #[test]
    fn unknown_pid_reports_zero_rather_than_failing() {
        let got = sample(&[(7, 0xFFFF_FFF0)]);
        assert_eq!(got[0].rss_bytes, 0);
        assert_eq!(got[0].processes, 0);
    }
}
