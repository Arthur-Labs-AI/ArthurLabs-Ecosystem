//! The facts a person must be shown before they authorize OpenAI to write or check a proposed revision (M04.7B Phase 5).
//!
//! Two SEPARATE authorizations, each tied to the disclosure version below: if the text or the data sent changes, the version is bumped
//! (a test pins the text to it) and an older grant stops counting. Neither is implied by the OpenAI key, by AI & Voice setup, by
//! TypeSafe consent, or by each other. They state only what Arthur does; they do not promise anything about OpenAI's retention.

pub const SYNTHESIS_DISCLOSURE_VERSION: &str = "openai-synthesis-2026-10-v1";
pub const VERIFICATION_DISCLOSURE_VERSION: &str = "openai-verification-samefamily-2026-10-v1";

pub const SYNTHESIS_DISCLOSURE: [&str; 5] = [
    "To suggest an updated version of an idea, Arthur sends OpenAI (GPT-6 Luna, through your own OpenAI key) the current text of that one idea, short quotes from the notes that support it, and the exact words of your new note.",
    "Nothing else is sent: not your other ideas, other projects, or other captures.",
    "What comes back is only a suggestion. Nothing about your ideas changes until you approve it.",
    "Turning this off, or withdrawing permission, stops future requests. It does not delete anything OpenAI may already hold under your account and its terms.",
    "This is off until you turn it on, and having an OpenAI key does not turn it on.",
];

pub const VERIFICATION_DISCLOSURE: [&str; 5] = [
    "Before showing you a suggestion, Arthur asks OpenAI to check it. The idea's text, your new note and the suggested text are sent again for that check.",
    "The checker is the same model family (GPT-6 Luna) that wrote the suggestion. It is a self-check, not an independent review, and it can miss the same mistakes. Read every suggestion before you approve it.",
    "A check that passes never changes anything by itself. You approve every change, and you can edit or reject it.",
    "Turning this off, or withdrawing permission, stops future checks, and then no suggestions are produced. It does not delete anything OpenAI may already hold.",
    "This is off until you turn it on, and it is separate from the permission to write suggestions.",
];

/// FNV-1a over a disclosure: pins the text to its version.
pub fn checksum(points: &[&str]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in points.join("\n").bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    /// If this fails the disclosure text changed: bump the matching `*_VERSION` (so older grants stop counting) and update the pinned value.
    #[test]
    fn the_disclosure_text_is_pinned_to_its_version() {
        assert_eq!((SYNTHESIS_DISCLOSURE_VERSION, checksum(&SYNTHESIS_DISCLOSURE)), ("openai-synthesis-2026-10-v1", PIN_SYNTHESIS));
        assert_eq!((VERIFICATION_DISCLOSURE_VERSION, checksum(&VERIFICATION_DISCLOSURE)), ("openai-verification-samefamily-2026-10-v1", PIN_VERIFICATION));
    }

    #[test]
    fn the_verification_disclosure_says_it_is_not_independent() {
        let text = VERIFICATION_DISCLOSURE.join(" ").to_lowercase();
        assert!(text.contains("same model family") && text.contains("not an independent review") && text.contains("approve every change"));
    }

    const PIN_SYNTHESIS: u64 = 15959226179711550454;
    const PIN_VERIFICATION: u64 = 4601048538881263593;
}
