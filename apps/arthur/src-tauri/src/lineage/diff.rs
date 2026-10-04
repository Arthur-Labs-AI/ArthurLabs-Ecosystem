//! The canonical, deterministic revision diff. No model is involved: the same two revisions always give
//! the same result.
//!
//! Word-level diff by longest common subsequence over tokens. The TypeScript twin in
//! `packages/contracts/lineage.ts` (used by the preview client) implements the identical algorithm, and both
//! are checked against one shared fixture file, `tests/fixtures/revision_diff_cases.json`.
//!
//! Tokens: a run of letters/digits, a run of white space, or a single other code point (punctuation, an emoji, a
//! combining piece). Ties are broken the same way everywhere: at a mismatch, DELETE the old token when that loses
//! nothing, otherwise INSERT the new one, so a replacement reads "delete old, insert new". The common prefix and
//! suffix tokens are trimmed first. Consecutive segments with the same op are merged.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    Equal,
    Insert,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Segment {
    pub op: Op,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TextDiff {
    pub changed: bool,
    pub segments: Vec<Segment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KindDiff {
    pub changed: bool,
    pub from: String,
    pub to: String,
}

/// Mirrors `RevisionDiff` in `packages/contracts/lineage.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDiff {
    pub old_revision_id: String,
    pub new_revision_id: String,
    pub kind: KindDiff,
    pub title: TextDiff,
    pub body: TextDiff,
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Class {
    Word,
    Space,
    Other,
}

fn class_of(c: char) -> Class {
    if c.is_alphabetic() || c.is_numeric() {
        Class::Word
    } else if c.is_whitespace() {
        Class::Space
    } else {
        Class::Other
    }
}

fn tokenize(text: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut start = 0;
    let mut current: Option<Class> = None;
    for (index, c) in text.char_indices() {
        let class = class_of(c);
        match current {
            // A run continues only for words and white space; every other code point is its own token.
            Some(previous) if previous == class && class != Class::Other => {}
            Some(_) => {
                tokens.push(&text[start..index]);
                start = index;
                current = Some(class);
            }
            None => current = Some(class),
        }
    }
    if current.is_some() {
        tokens.push(&text[start..]);
    }
    tokens
}

fn push(segments: &mut Vec<Segment>, op: Op, text: &str) {
    match segments.last_mut() {
        Some(last) if last.op == op => last.text.push_str(text),
        _ => segments.push(Segment { op, text: text.to_string() }),
    }
}

pub fn diff_text(old_text: &str, new_text: &str) -> TextDiff {
    if old_text == new_text {
        let segments = if old_text.is_empty() { vec![] } else { vec![Segment { op: Op::Equal, text: old_text.to_string() }] };
        return TextDiff { changed: false, segments };
    }
    let a = tokenize(old_text);
    let b = tokenize(new_text);
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let (mut end_a, mut end_b) = (a.len(), b.len());
    while end_a > start && end_b > start && a[end_a - 1] == b[end_b - 1] {
        end_a -= 1;
        end_b -= 1;
    }
    let (middle_a, middle_b) = (&a[start..end_a], &b[start..end_b]);
    let (n, m) = (middle_a.len(), middle_b.len());
    let width = m + 1;
    // lcs[i * width + j] = LCS length of middle_a[i..] and middle_b[j..]. Texts are bounded (a body is at most
    // 2,000 characters), so this is at most about 8 MB.
    let mut lcs = vec![0u16; (n + 1) * width];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i * width + j] = if middle_a[i] == middle_b[j] { lcs[(i + 1) * width + j + 1] + 1 } else { lcs[(i + 1) * width + j].max(lcs[i * width + j + 1]) };
        }
    }

    let mut segments = Vec::new();
    if start > 0 {
        push(&mut segments, Op::Equal, &a[..start].concat());
    }
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && middle_a[i] == middle_b[j] {
            push(&mut segments, Op::Equal, middle_a[i]);
            i += 1;
            j += 1;
        } else if j >= m || (i < n && lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
            push(&mut segments, Op::Delete, middle_a[i]);
            i += 1;
        } else {
            push(&mut segments, Op::Insert, middle_b[j]);
            j += 1;
        }
    }
    if end_a < a.len() {
        push(&mut segments, Op::Equal, &a[end_a..].concat());
    }
    TextDiff { changed: true, segments }
}

pub struct Content<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub title: &'a str,
    pub body: &'a str,
}

pub fn diff_revisions(old: &Content, new: &Content) -> RevisionDiff {
    RevisionDiff {
        old_revision_id: old.id.to_string(),
        new_revision_id: new.id.to_string(),
        kind: KindDiff { changed: old.kind != new.kind, from: old.kind.to_string(), to: new.kind.to_string() },
        title: diff_text(old.title, new.title),
        body: diff_text(old.body, new.body),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        old: String,
        new: String,
        expected: serde_json::Value,
    }

    /// The same cases the TypeScript twin is tested against.
    const FIXTURES: &str = include_str!("../../../../../tests/fixtures/revision_diff_cases.json");

    #[test]
    fn matches_every_shared_fixture_case() {
        let cases: Vec<Case> = serde_json::from_str(FIXTURES).unwrap();
        assert!(cases.len() >= 10);
        for case in cases {
            let actual = serde_json::to_value(diff_text(&case.old, &case.new)).unwrap();
            assert_eq!(actual, case.expected, "{}", case.name);
        }
    }

    #[test]
    fn a_diff_reconstructs_both_texts_is_repeatable_and_merges_consecutive_segments() {
        let cases: Vec<Case> = serde_json::from_str(FIXTURES).unwrap();
        let mut pairs: Vec<(String, String)> = cases.into_iter().map(|c| (c.old, c.new)).collect();
        pairs.push(("The quick brown fox".into(), "A quick red fox jumps".into()));
        pairs.push(("a b c d e f g".into(), "g f e d c b a".into()));
        pairs.push(("Здравей, свят 😀!".into(), "Здравей свят 😀😀?".into()));
        for (old, new) in pairs {
            let diff = diff_text(&old, &new);
            assert_eq!(diff_text(&old, &new), diff, "repeatable");
            let rebuild = |skip: Op| diff.segments.iter().filter(|s| s.op != skip).map(|s| s.text.as_str()).collect::<String>();
            assert_eq!(rebuild(Op::Insert), old);
            assert_eq!(rebuild(Op::Delete), new);
            for pair in diff.segments.windows(2) {
                assert_ne!(pair[0].op, pair[1].op, "consecutive segments with one op are merged");
            }
            assert!(diff.segments.iter().all(|s| !s.text.is_empty()));
            assert_eq!(diff.changed, old != new);
        }
    }

    #[test]
    fn tokens_group_words_and_white_space_but_split_everything_else() {
        assert_eq!(tokenize("Hello,  мир! 😀😀 a1_b"), ["Hello", ",", "  ", "мир", "!", " ", "😀", "😀", " ", "a1", "_", "b"]);
        assert_eq!(tokenize(""), Vec::<&str>::new());
    }

    #[test]
    fn a_revision_diff_reports_kind_title_and_body_independently() {
        let old = Content { id: "r1", kind: "idea", title: "Same", body: "Old body" };
        let new = Content { id: "r2", kind: "decision", title: "Same", body: "New body" };
        let diff = diff_revisions(&old, &new);
        assert_eq!(diff.kind, KindDiff { changed: true, from: "idea".into(), to: "decision".into() });
        assert!(!diff.title.changed && diff.body.changed);
        let same = diff_revisions(&old, &Content { id: "r3", ..old_copy(&old) });
        assert!(!same.kind.changed && !same.title.changed && !same.body.changed);
        let value = serde_json::to_value(&diff).unwrap();
        let mut keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["body", "kind", "newRevisionId", "oldRevisionId", "title"]);
    }

    fn old_copy<'a>(c: &Content<'a>) -> Content<'a> {
        Content { id: c.id, kind: c.kind, title: c.title, body: c.body }
    }
}
