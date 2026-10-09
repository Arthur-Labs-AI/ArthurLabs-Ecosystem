//! Deterministic splitting of text into speakable pieces.
//!
//! One provider request is kept small (fast first audio, bounded cost), so long text is cut at paragraph and sentence boundaries,
//! preserving order. The whole job is bounded too: text past `MAX_TOTAL_CHARS` is not spoken, and the caller is told it was cut.

pub const MAX_CHUNK_CHARS: usize = 900;
/// The first chunk is small so the first words are audible quickly (synthesis time grows with length); later chunks are fetched while
/// it plays, so they can be larger.
pub const FIRST_CHUNK_CHARS: usize = 280;
pub const MAX_TOTAL_CHARS: usize = 6000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub chunks: Vec<String>,
    /// Text beyond the bound was left out.
    pub truncated: bool,
}

fn is_terminator(c: char) -> bool {
    matches!(c, '.' | '!' | '?' | '…' | ';' | '。' | '！' | '？')
}

/// Sentences of a paragraph, each keeping its own punctuation. A terminator ends a sentence only when whitespace (or the end) follows,
/// so "3.5" and "e.g.x" stay whole. Works the same for Latin and Cyrillic.
fn sentences(paragraph: &str) -> Vec<String> {
    let chars: Vec<char> = paragraph.chars().collect();
    let mut out = Vec::new();
    let mut current = String::new();
    for (i, &c) in chars.iter().enumerate() {
        current.push(c);
        let ends = is_terminator(c) && chars.get(i + 1).is_none_or(|next| next.is_whitespace());
        if ends {
            let sentence = current.trim().to_string();
            if !sentence.is_empty() {
                out.push(sentence);
            }
            current.clear();
        }
    }
    let rest = current.trim();
    if !rest.is_empty() {
        out.push(rest.to_string());
    }
    out
}

/// A single sentence longer than the limit is cut at the last space before it, or hard at the limit if it has none.
fn split_long(sentence: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest: Vec<char> = sentence.chars().collect();
    while rest.len() > max {
        let window = &rest[..max];
        let cut = window.iter().rposition(|c| c.is_whitespace()).filter(|&at| at > 0).unwrap_or(max);
        let head: String = rest[..cut].iter().collect();
        out.push(head.trim().to_string());
        rest = rest[cut..].iter().copied().skip_while(|c| c.is_whitespace()).collect();
    }
    let tail: String = rest.iter().collect();
    if !tail.trim().is_empty() {
        out.push(tail.trim().to_string());
    }
    out
}

pub fn plan(text: &str, max_chunk: usize, max_total: usize) -> Plan {
    plan_with_first(text, max_chunk, max_chunk, max_total)
}

/// Like `plan`, with a smaller limit for the first chunk only.
pub fn plan_with_first(text: &str, first_chunk: usize, max_chunk: usize, max_total: usize) -> Plan {
    let mut pieces: Vec<String> = Vec::new();
    for paragraph in text.split("\n\n").flat_map(|block| block.split('\n')).map(str::trim).filter(|p| !p.is_empty()) {
        for sentence in sentences(paragraph) {
            if sentence.chars().count() > first_chunk.min(max_chunk) {
                pieces.extend(split_long(&sentence, first_chunk.min(max_chunk)));
            } else {
                pieces.push(sentence);
            }
        }
    }

    let mut chunks: Vec<String> = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;
    for piece in pieces {
        let chunks_len = chunks.len();
        let len = piece.chars().count();
        if total + len > max_total {
            truncated = true;
            break;
        }
        total += len + 1;
        match chunks.last_mut() {
            Some(last) if last.chars().count() + 1 + len <= if chunks_len == 1 { first_chunk } else { max_chunk } => {
                last.push(' ');
                last.push_str(&piece);
            }
            _ => chunks.push(piece),
        }
    }
    Plan { chunks, truncated }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BG: &str = "Трябва да изпратя имейл на Игнатов утре. Срокът за състезанието е в петък! Батерията трябва да издържа цял ден?";

    #[test]
    fn short_text_is_one_chunk_in_order() {
        let plan = plan("Hello, I'm Arthur. This is a test.", 900, 6000);
        assert_eq!(plan.chunks, vec!["Hello, I'm Arthur. This is a test."]);
        assert!(!plan.truncated);
    }

    #[test]
    fn bulgarian_and_mixed_scripts_are_split_at_sentence_boundaries_untouched() {
        let plan = plan(BG, 60, 6000);
        assert_eq!(plan.chunks.len(), 3);
        assert_eq!(plan.chunks.join(" "), BG, "nothing is transliterated, dropped or reordered");
        let mixed = super::plan("Купих EMG wristband. Battery life е важен.", 25, 6000);
        assert_eq!(mixed.chunks.join(" "), "Купих EMG wristband. Battery life е важен.");
    }

    #[test]
    fn decimals_and_abbreviations_without_a_following_space_are_not_sentence_ends() {
        assert_eq!(sentences("It costs 3.5 euros. Fine."), vec!["It costs 3.5 euros.", "Fine."]);
    }

    #[test]
    fn a_sentence_longer_than_the_limit_is_cut_at_words_and_every_chunk_fits() {
        let long = "word ".repeat(500);
        let plan = plan(long.trim(), 100, 6000);
        assert!(plan.chunks.len() > 20);
        assert!(plan.chunks.iter().all(|c| c.chars().count() <= 100 && !c.starts_with(' ')));
        assert_eq!(plan.chunks.join(" "), long.trim());
        let unbroken = super::plan(&"я".repeat(250), 100, 6000);
        assert_eq!(unbroken.chunks.iter().map(|c| c.chars().count()).collect::<Vec<_>>(), vec![100, 100, 50]);
    }

    #[test]
    fn the_whole_job_is_bounded_and_says_when_text_was_left_out() {
        let text = "This is a sentence. ".repeat(100);
        let plan = plan(&text, 200, 500);
        assert!(plan.truncated);
        assert!(plan.chunks.iter().map(|c| c.chars().count()).sum::<usize>() <= 500);
        assert!(plan.chunks.last().unwrap().ends_with('.'), "cut at a sentence boundary, never mid-sentence");
    }

    #[test]
    fn the_first_chunk_is_small_so_speech_starts_quickly_and_order_is_kept() {
        let text = "This is an ordinary sentence for the first chunk test. ".repeat(40);
        let plan = plan_with_first(text.trim(), 120, 600, 6000);
        assert!(plan.chunks[0].chars().count() <= 120, "{}", plan.chunks[0].chars().count());
        assert!(plan.chunks[1].chars().count() > 120 && plan.chunks.iter().all(|c| c.chars().count() <= 600));
        assert_eq!(plan.chunks.join(" "), text.trim());
        let single = plan_with_first(&"я".repeat(500), 100, 400, 6000);
        assert_eq!(single.chunks[0].chars().count(), 100);
    }

    #[test]
    fn paragraphs_and_empty_input() {
        assert_eq!(plan("One.\n\nTwo.\nThree.", 900, 6000).chunks, vec!["One. Two. Three."]);
        assert!(plan("  \n\n ", 900, 6000).chunks.is_empty());
    }
}
