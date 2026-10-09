//! Selective Thought Lineage enrichment (M04A pipeline.md §6). Pure: one object's revisions go in, a bounded, explained selection of
//! HISTORICAL revisions comes out. The object's current revision is never in the selection (it is the evidence entry itself), and a
//! selected revision is never presented as current: every pick says `historical` or `branch_not_current`.
//!
//! ```text
//! default factual question     nothing (current revision only)
//! matched old wording (M04B)   always: the revision that made the object discoverable
//! decision / why               + the immediate parent(s) of the current revision
//! evolution / history          + the parent path (<= 6 revisions) + branch points, merges, root and new-capture revisions on that path
//!                              + the non-current heads (<= 2)
//! total                        <= 12 historical entries per question; over the cap the lowest priority goes first
//! ```

use std::collections::{HashMap, HashSet};

use crate::storage::recall_store::RevisionRow;

pub const MAX_PATH: usize = 6;
pub const MAX_HEADS: usize = 2;
pub const MAX_MERGE_PARENTS: usize = 3;
pub const MAX_HISTORY_TOTAL: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Only the revision that the lexical search matched (no intent asked for history).
    MatchedOnly,
    /// "Why" and decision questions: the immediate parents too.
    Why,
    /// Evolution and history questions: the full selective policy.
    Evolution,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pick {
    pub object_id: String,
    pub revision_id: String,
    /// `historical` (an ancestor of the current revision) or `branch_not_current` (a line that was never adopted).
    pub status: &'static str,
    pub marks: Vec<&'static str>,
    pub leads_to_current: bool,
    /// Lower is kept first when the total cap bites: matched 0, parent 1, root 2, merge 3, new capture 4, branch point 5, head 6, path 7.
    pub priority: u8,
    /// Position in creation order, for chronological presentation.
    pub seq: usize,
}

/// `revisions` are one object's, oldest first (as `recall_revisions_of` returns them).
pub fn select(revisions: &[RevisionRow], current_revision_id: &str, matched_revision_id: Option<&str>, mode: Mode) -> Vec<Pick> {
    let index: HashMap<&str, usize> = revisions.iter().enumerate().map(|(i, r)| (r.id.as_str(), i)).collect();
    let Some(&current_at) = index.get(current_revision_id) else { return Vec::new() };
    let object_id = revisions[current_at].object_id.clone();

    // children count per revision
    let mut children: HashMap<&str, usize> = HashMap::new();
    for revision in revisions {
        for parent in &revision.parents {
            *children.entry(parent.as_str()).or_insert(0) += 1;
        }
    }

    // ancestry of the current revision: every ancestor, for `leadsToCurrent`
    let mut ancestors: HashSet<&str> = HashSet::new();
    let mut stack = vec![current_revision_id];
    while let Some(id) = stack.pop() {
        if let Some(&i) = index.get(id) {
            for parent in &revisions[i].parents {
                if ancestors.insert(parent.as_str()) {
                    stack.push(parent.as_str());
                }
            }
        }
    }

    let mut picks: HashMap<String, Pick> = HashMap::new();
    let mut add = |revision: &RevisionRow, mark: &'static str, priority: u8| {
        if revision.id == current_revision_id {
            return;
        }
        let leads = ancestors.contains(revision.id.as_str());
        let seq = index[revision.id.as_str()];
        let pick = picks.entry(revision.id.clone()).or_insert_with(|| Pick {
            object_id: object_id.clone(),
            revision_id: revision.id.clone(),
            status: if leads { "historical" } else { "branch_not_current" },
            marks: Vec::new(),
            leads_to_current: leads,
            priority,
            seq,
        });
        if !pick.marks.contains(&mark) {
            pick.marks.push(mark);
        }
        pick.priority = pick.priority.min(priority);
    };

    if let Some(matched) = matched_revision_id.and_then(|id| index.get(id)) {
        add(&revisions[*matched], "matched_query", 0);
    }

    if matches!(mode, Mode::Why | Mode::Evolution) {
        for parent in revisions[current_at].parents.iter().take(MAX_MERGE_PARENTS) {
            if let Some(&i) = index.get(parent.as_str()) {
                add(&revisions[i], "parent", 1);
            }
        }
    }

    if mode == Mode::Evolution {
        // The parent path: follow the most recent parent, taking every parent of a merge (at most 3) along the way.
        let mut walked: Vec<usize> = Vec::new();
        let mut cursor = current_at;
        while walked.len() < MAX_PATH {
            let parents: Vec<usize> = revisions[cursor].parents.iter().filter_map(|p| index.get(p.as_str()).copied()).collect();
            let Some(&next) = parents.iter().max() else { break };
            for &p in parents.iter().rev().take(MAX_MERGE_PARENTS) {
                if !walked.contains(&p) && walked.len() < MAX_PATH {
                    walked.push(p);
                }
            }
            cursor = next;
        }
        for &i in &walked {
            let revision = &revisions[i];
            add(revision, "path", 7);
            if revision.origin == "initial" {
                add(revision, "root", 2);
            }
            if revision.parents.len() >= 2 {
                add(revision, "merge", 3);
            }
            if revision.origin == "distillation" && revision.source.is_some() {
                add(revision, "new_capture", 4);
            }
            if children.get(revision.id.as_str()).copied().unwrap_or(0) >= 2 {
                add(revision, "branch_point", 5);
            }
        }
        // Lines that were never adopted: revisions with no children that are not the current one, most recent first.
        let mut heads: Vec<usize> = (0..revisions.len()).filter(|&i| revisions[i].id != current_revision_id && !children.contains_key(revisions[i].id.as_str())).collect();
        heads.sort_by(|a, b| b.cmp(a));
        for i in heads.into_iter().take(MAX_HEADS) {
            add(&revisions[i], "non_current_head", 6);
        }
    }

    let mut out: Vec<Pick> = picks.into_values().collect();
    out.sort_by_key(|p| p.seq);
    out
}

/// Applies the overall cap across all selected objects: lowest priority first, then older first; chronological order is restored.
pub fn cap_total(mut picks: Vec<Pick>, limit: usize) -> Vec<Pick> {
    if picks.len() > limit {
        picks.sort_by(|a, b| a.priority.cmp(&b.priority).then_with(|| b.seq.cmp(&a.seq)).then_with(|| a.revision_id.cmp(&b.revision_id)));
        picks.truncate(limit);
    }
    picks.sort_by(|a, b| a.object_id.cmp(&b.object_id).then_with(|| a.seq.cmp(&b.seq)));
    picks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rev(id: &str, origin: &str, parents: &[&str], captured: bool) -> RevisionRow {
        RevisionRow {
            id: id.into(),
            object_id: "o".into(),
            kind: "idea".into(),
            title: id.into(),
            body: "b".into(),
            origin: origin.into(),
            created_at: "t".into(),
            source: captured.then(|| ("c".to_string(), 0, 1)),
            parents: parents.iter().map(|p| p.to_string()).collect(),
        }
    }

    fn ids(picks: &[Pick]) -> Vec<&str> {
        picks.iter().map(|p| p.revision_id.as_str()).collect()
    }

    /// r1 -> r2 -> r3 -> r4(current);  r2 -> b1 (never adopted);  r3 and b1 merge into m1 (not current)
    fn dag() -> Vec<RevisionRow> {
        vec![rev("r1", "initial", &[], true), rev("r2", "user_edit", &["r1"], false), rev("b1", "user_edit", &["r2"], false), rev("r3", "distillation", &["r2"], true), rev("m1", "merge", &["r3", "b1"], false), rev("r4", "user_edit", &["r3"], false)]
    }

    #[test]
    fn the_default_selects_nothing_and_the_current_revision_is_never_selected() {
        let revisions = dag();
        assert!(select(&revisions, "r4", None, Mode::MatchedOnly).is_empty());
        for mode in [Mode::MatchedOnly, Mode::Why, Mode::Evolution] {
            assert!(!ids(&select(&revisions, "r4", Some("r4"), mode)).contains(&"r4"));
        }
    }

    #[test]
    fn a_matched_old_revision_is_always_kept_with_its_status() {
        let picks = select(&dag(), "r4", Some("r1"), Mode::MatchedOnly);
        assert_eq!(ids(&picks), ["r1"]);
        assert_eq!((picks[0].status, picks[0].leads_to_current, picks[0].marks.clone()), ("historical", true, vec!["matched_query"]));
        let branch = select(&dag(), "r4", Some("b1"), Mode::MatchedOnly);
        assert_eq!((branch[0].status, branch[0].leads_to_current), ("branch_not_current", false), "an unadopted line is never `historical` ancestry");
    }

    #[test]
    fn why_adds_only_the_immediate_parent() {
        assert_eq!(ids(&select(&dag(), "r4", None, Mode::Why)), ["r3"]);
        assert_eq!(ids(&select(&dag(), "r4", Some("r1"), Mode::Why)), ["r1", "r3"]);
    }

    #[test]
    fn evolution_selects_the_path_the_significant_points_and_the_unadopted_heads() {
        let picks = select(&dag(), "r4", None, Mode::Evolution);
        // path r3, r2, r1; the unadopted head m1 (b1 has a child, so it is not a head and is not on the path).
        assert_eq!(ids(&picks), ["r1", "r2", "r3", "m1"]);
        let get = |id: &str| picks.iter().find(|p| p.revision_id == id).unwrap();
        assert_eq!((get("r1").status, get("r3").status, get("m1").status), ("historical", "historical", "branch_not_current"));
        assert!(get("r1").marks.contains(&"root") && !get("r1").marks.contains(&"new_capture"), "the root is the root, not a new-capture revision");
        assert!(get("r3").marks.contains(&"new_capture"), "a revision interpreted from a NEW capture is a significant point");
        assert!(get("r2").marks.contains(&"branch_point") && get("r3").marks.contains(&"branch_point"));
        assert!(get("m1").marks.contains(&"non_current_head") && !get("m1").leads_to_current);
        assert!(get("r3").leads_to_current);
    }

    #[test]
    fn the_path_is_bounded_and_the_total_cap_drops_the_lowest_priority_first() {
        // a long straight edit chain: r0 (root) ... r19 (current)
        let revisions: Vec<RevisionRow> = (0..20).map(|i| rev(&format!("r{i:02}"), if i == 0 { "initial" } else { "user_edit" }, &if i == 0 { vec![] } else { vec![format!("r{:02}", i - 1)] }.iter().map(String::as_str).collect::<Vec<_>>(), i == 0)).collect();
        let picks = select(&revisions, "r19", None, Mode::Evolution);
        assert_eq!(picks.len(), MAX_PATH, "the parent path is at most 6 revisions");
        assert_eq!(ids(&picks), ["r13", "r14", "r15", "r16", "r17", "r18"]);
        // total cap across objects: matched first, then parent, root...; the cheapest (plain path) goes first
        let many: Vec<Pick> = (0..15).map(|i| Pick { object_id: "o".into(), revision_id: format!("x{i:02}"), status: "historical", marks: vec![], leads_to_current: true, priority: if i < 3 { 0 } else { 7 }, seq: i }).collect();
        let capped = cap_total(many, MAX_HISTORY_TOTAL);
        assert_eq!(capped.len(), MAX_HISTORY_TOTAL);
        assert!(["x00", "x01", "x02"].iter().all(|k| ids(&capped).contains(k)), "high priority is never dropped for plain path entries");
    }

    #[test]
    fn merges_on_the_path_include_their_parents_and_are_marked() {
        // r1 -> a, r1 -> b, merge(a, b) = m, m -> cur
        let revisions = vec![rev("r1", "initial", &[], true), rev("a", "user_edit", &["r1"], false), rev("b", "user_edit", &["r1"], false), rev("m", "merge", &["a", "b"], false), rev("cur", "user_edit", &["m"], false)];
        let picks = select(&revisions, "cur", None, Mode::Evolution);
        let get = |id: &str| picks.iter().find(|p| p.revision_id == id).unwrap();
        assert!(get("m").marks.contains(&"merge") && get("m").marks.contains(&"parent"));
        assert!(ids(&picks).contains(&"a") && ids(&picks).contains(&"b") && ids(&picks).contains(&"r1"));
        assert!(get("r1").marks.contains(&"branch_point"));
    }
}
