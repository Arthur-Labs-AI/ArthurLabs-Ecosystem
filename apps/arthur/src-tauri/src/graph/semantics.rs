//! The meaning of each relation kind, written once.
//!
//! Both model prompts (proposal and verification) render their kind definitions from this table, so
//! the two stages can never disagree about what a kind means. Mirrors the semantics documented in
//! `packages/contracts/cognitive.ts`. Prose only: nothing here decides anything; the deterministic
//! gates live in `verify.rs` and `validate.rs`.

use crate::storage::relation_store::is_symmetric;

pub struct KindRule {
    pub kind: &'static str,
    /// What `A kind B` means.
    pub meaning: &'static str,
    pub accept_when: &'static str,
    pub reject_when: &'static str,
    /// The operational question that decides the kind (M04.7A.1). Answered from the two objects' own text.
    pub test: &'static str,
    /// The nearest kinds it is confused with, and how to tell them apart.
    pub not_instead: &'static str,
}

/// In the same order as `relation_store::KINDS` (a test asserts it).
pub const RULES: [KindRule; 7] = [
    KindRule {
        kind: "related_to",
        meaning: "A and B have a specific, meaningful conceptual link. Symmetric.",
        accept_when: "the objects' own text states or clearly implies a specific link that would genuinely help someone recalling A to also see B, and no stronger kind below applies",
        reject_when: "they merely share a project, product, topic, theme or vocabulary; being about the same thing is not a link. related_to is never a fallback",
        test: "Is there a concrete, specific link between A and B that none of the stronger tests below establishes? If you can name the stronger kind, use that kind instead; if you cannot name the link in one concrete sentence, there is no relation.",
        not_instead: "Prefer duplicates, supersedes, contradicts, depends_on, extends or derived_from whenever their test passes. Never use related_to for shared topic, product or vocabulary.",
    },
    KindRule {
        kind: "extends",
        meaning: "A adds detail, scope, refinement or additional information to B. Directional: A is the richer, more specific one.",
        accept_when: "A clearly enriches B: B is the general statement and A develops it",
        reject_when: "both merely discuss similar things, or B is actually the richer one (then the direction is reversed)",
        test: "Does A keep the core meaning and purpose of B and add scope, capability, detail or specialization to it? Could A be read as \"B, plus more\"?",
        not_instead: "Not depends_on: extends does not say A needs B in order to work. Not duplicates: A adds something B lacks. Not derived_from: A is not a consequence of B, it enriches it.",
    },
    KindRule {
        kind: "depends_on",
        meaning: "A requires B to exist, happen, be valid, or provide necessary context. Directional: A is the one that needs B.",
        accept_when: "A could not work, be true or be carried out without B (a precondition), and B does not equally need A",
        reject_when: "B merely helps or relates to A, or each needs the other (ambiguous direction). Ask both questions: could A hold without B? could B hold without A? A note saying that X must happen or exist before Y is about X; it is Y that depends on X, not the note",
        test: "Is B genuinely required by A: a prerequisite, a supporting piece of infrastructure, or something A is carried out on? Would A stop working, stop being true or stop making sense if B were absent or did not happen first?",
        not_instead: "Not extends: an addition or refinement of B does not require B to be absent-proof. Not related_to: association is not requirement. Not derived_from: being enabled by B is not being produced from B. If B would also need A, the direction is ambiguous: reject.",
    },
    KindRule {
        kind: "contradicts",
        meaning: "A and B make incompatible claims, decisions, constraints or states, so both cannot hold. Symmetric.",
        accept_when: "they make incompatible assertions, decisions or constraints about the same subject under a compatible time and context, so accepting one means rejecting the other",
        reject_when: "they simply differ, emphasise different things, or cover different parts of the same subject; or one only makes the other unnecessary, obsolete, cancelled or lower priority (a cancelled plan does not contradict a task that used to be a prerequisite for it, and a changed priority does not contradict the old priority unless they assert incompatible orderings at the same time)",
        test: "Under a compatible time and context, do A and B assert incompatible things about the same subject, so that believing or following A would force you to reject B as false or unworkable? A cancelled, obsolete, unnecessary or reprioritised B is not a conflict.",
        not_instead: "Not supersedes: if the text shows A is a newer replacement or update of B, supersedes; contradicts is for two statements that simply cannot both stand. Not 'makes unnecessary': if A cancels, drops or obsoletes the need for B, B has not been contradicted; there is no relation of this kind (use supersedes only if A replaces B as the current position, otherwise nothing). Not related_to: a difference of emphasis is not a conflict.",
    },
    KindRule {
        kind: "derived_from",
        meaning: "Knowledge object A was conceptually derived from knowledge object B (it follows from, builds on the conclusion of, or is a consequence of B). Directional: A is the derived one. This relates two objects; it is NOT where an object came from in a capture.",
        accept_when: "A's content is a real conceptual consequence or derivation of B's content",
        reject_when: "they share a topic or are similar, or they merely came from related captures",
        test: "Was A produced, inferred or concluded from B (A is a consequence of what B says) rather than merely made possible by B?",
        not_instead: "Not depends_on: depends_on is about requirement to function, derived_from is about origin of the idea. Not extends: extends enriches, derived_from concludes.",
    },
    KindRule {
        kind: "duplicates",
        meaning: "A and B express effectively the same thought. Symmetric.",
        accept_when: "their meaning and intent are near-equivalent",
        reject_when: "one adds detail or scope the other lacks (that is extends), or they are only similar",
        test: "Do A and B express materially the same knowledge and intent, so that keeping both adds nothing? The wording or the language may differ.",
        not_instead: "Not extends: if one adds detail or scope the other lacks, that is extends. Not related_to: overlap in topic is not sameness.",
    },
    KindRule {
        kind: "supersedes",
        meaning: "A replaces B as the newer, current knowledge or state. Directional: A is the replacement.",
        accept_when: "the objects' text shows A replaces, updates or reverses B",
        reject_when: "A is merely newer, or merely about the same thing. Recency alone is not evidence",
        test: "Does the text of A present it as the newer replacement, update or reversal of B, so that B should no longer stand as the current position?",
        not_instead: "Not contradicts: if both could stay true at once, or A does not say it replaces B, use contradicts or nothing. Recency alone is never replacement.",
    },
];

/// The kind definitions as prompt text.
pub fn rubric() -> String {
    RULES
        .iter()
        .map(|rule| {
            let shape = if is_symmetric(rule.kind) { "symmetric: the order of A and B does not matter" } else { "directional: A and B are NOT interchangeable" };
            format!("- {kind} = {meaning}\n  ({shape})\n  Use it only when {accept}.\n  Do NOT use it when {reject}.\n  TEST: {test}\n  NOT INSTEAD OF: {not_instead}", kind = rule.kind, meaning = rule.meaning, shape = shape, accept = rule.accept_when, reject = rule.reject_when, test = rule.test, not_instead = rule.not_instead)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::relation_store::KINDS;

    #[test]
    fn every_kind_is_defined_exactly_once_in_order() {
        assert_eq!(RULES.iter().map(|rule| rule.kind).collect::<Vec<_>>(), KINDS);
    }

    #[test]
    fn the_rubric_states_when_to_use_and_when_not_to_for_every_kind() {
        let text = rubric();
        for rule in &RULES {
            assert!(text.contains(&format!("- {} = ", rule.kind)));
            assert!(rule.accept_when.len() > 20 && rule.reject_when.len() > 20, "{} needs real criteria", rule.kind);
        }
        assert_eq!(text.matches("Do NOT use it when").count(), 7);
        assert_eq!(text.matches("TEST: ").count(), 7);
        assert_eq!(text.matches("NOT INSTEAD OF: ").count(), 7);
        assert!(text.contains("never a fallback"));
        assert!(text.contains("Recency alone is not evidence"));
        assert!(text.contains("NOT where an object came from in a capture"));
    }
}
