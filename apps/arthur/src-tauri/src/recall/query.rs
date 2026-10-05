//! Query interpretation: normalisation, content terms, light Bulgarian/English stem-prefixes, intent cue WEIGHTS, and the safe
//! FTS5 expression.
//!
//! Intent never decides whether an object is retrievable. It is metadata (and, for `decision`/`task`, a bounded kind prior). With
//! no intent, or the wrong one, retrieval is identical.
//!
//! Language handling is by SCRIPT, never by guess: a term containing any Cyrillic letter gets the Bulgarian rules only; any other
//! term gets the English rules only. English stemming is never applied to Bulgarian text.
//!
//! Normalisation: NFC (so a decomposed `й` matches), no stress marks, full Unicode lower-casing (`str::to_lowercase`, unlike
//! SQLite's ASCII-only `lower()`), and each emitted token also in NFD form so text stored decomposed is still found.

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

/// Mirrors the architecture's `MAX_QUERY_CHARS`.
pub const MAX_QUERY_CHARS: usize = 500;
/// Content terms kept (the rest are dropped, in order), bounding the FTS expression.
pub const MAX_TERMS: usize = 12;

const STOPWORDS_BG: &[&str] = &[
    "и", "на", "в", "във", "за", "с", "със", "да", "е", "са", "се", "че", "как", "какво", "какви", "какъв", "каква", "кои", "кой", "коя", "кога", "къде", "защо", "ли", "от", "до", "по", "при", "над", "под", "като", "или", "но", "а", "не", "ще", "съм", "си", "ми", "ти", "му", "ѝ", "го", "ги", "то", "тя", "той", "те", "ние", "вие", "аз", "този", "тази", "това", "тези", "има", "беше", "бях", "били", "моя", "моята", "моето", "моите", "мои",
];
const STOPWORDS_EN: &[&str] = &[
    "a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "but", "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these", "those", "how", "what", "which", "who", "whom", "when", "where", "why", "did", "do", "does", "my", "me", "i", "we", "our", "with", "about", "from", "by", "as", "at", "so", "if", "then", "than", "into", "have", "has", "had", "can", "could", "should", "would", "tell",
];

/// Prefixes of cue words that carry intent rather than subject matter. They are removed from the content terms (so they do not
/// dominate ranking) unless that would leave nothing to search for.
const CUE_PREFIXES: &[&str] = &[
    "evolv", "histor", "chang", "develop", "depend", "requir", "prerequisit", "contradict", "conflict", "decid", "decision", "rational", "provenance", "origin", "sourc", "task", "todo", "action",
    "еволюц", "промен", "развит", "развив", "истори", "завис", "изиск", "противореч", "конфликт", "реши", "решени", "причин", "откъде", "оригинал", "източник", "задач", "действ",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QueryLanguage {
    Bulgarian,
    English,
    Mixed,
}

/// Each weight is 0.0 or 1.0 (a cue family either fired or not); `exploratory` is the residual. Several may fire.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IntentWeights {
    pub factual: f64,
    pub decision: f64,
    pub dependency: f64,
    pub contradiction: f64,
    pub evolution: f64,
    pub provenance: f64,
    pub task: f64,
    pub exploratory: f64,
}

impl IntentWeights {
    pub fn max_non_exploratory(&self) -> f64 {
        [self.factual, self.decision, self.dependency, self.contradiction, self.evolution, self.provenance, self.task].into_iter().fold(0.0, f64::max)
    }
}

/// One content term and how it matches text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Term {
    /// Normalised, lower-cased, NFC.
    pub text: String,
    /// When set, any token starting with this matches (the stem-prefix); otherwise only the exact term matches.
    pub prefix: Option<String>,
}

impl Term {
    pub fn matches_token(&self, token: &str) -> bool {
        token == self.text || self.prefix.as_deref().is_some_and(|prefix| token.starts_with(prefix))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct InterpretedQuery {
    pub raw: String,
    pub language: QueryLanguage,
    pub terms: Vec<Term>,
    /// The entity phrase for the title bonus: the content terms in order, joined by one space. `None` when too short.
    pub phrase: Option<String>,
    pub intent: IntentWeights,
}

/// Why a query was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryProblem {
    Empty,
    TooLong,
}

pub fn is_cyrillic(c: char) -> bool {
    ('\u{0400}'..='\u{052F}').contains(&c)
}

/// NFC, no stress marks, lower-cased, NFC again (lower-casing can in principle denormalise).
pub fn normalize_text(text: &str) -> String {
    let without_stress: String = text.nfd().filter(|c| *c != '\u{0301}').collect::<String>().nfc().collect();
    without_stress.to_lowercase().nfc().collect()
}

/// Folded word tokens of arbitrary text (letters and digits; everything else separates).
pub fn tokens(text: &str) -> Vec<String> {
    normalize_text(text).split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).map(str::to_string).collect()
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn intent_of(folded: &str) -> IntentWeights {
    let fired = |cues: &[&str]| if contains_any(folded, cues) { 1.0 } else { 0.0 };
    let mut intent = IntentWeights {
        evolution: fired(&["evolv", "evolution", "change", "changed", "history", "over time", "develop", "earlier", "previously", "еволюц", "промен", "развит", "развив", "истори", "по-рано", "преди", "как се е "]),
        dependency: fired(&["depend", "require", "need", "prerequisite", "blocked by", "relies on", "builds on", "завис", "изиска", "трябва", "нужд", "блокир", "разчита"]),
        contradiction: fired(&["contradict", "conflict", "disagree", "inconsisten", "incompatible", "противореч", "конфликт", "несъвмест", "не съвпада"]),
        decision: fired(&["decide", "decision", "chose", "why did", "rationale", "reason for", "реши", "решени", "избр", "причина"]),
        provenance: fired(&["come from", "came from", "original", "source", "who said", "when did i first", "откъде", "оригинал", "източник", "кога за пръв"]),
        task: fired(&["task", "todo", "to do", "action item", "next step", "задач", "да направя", "следващ", "действ"]),
        factual: fired(&["what is", "what do i know", "what are", "tell me about", "какво е", "какво знам", "разкажи"]),
        exploratory: 0.0,
    };
    intent.exploratory = 1.0 - intent.max_non_exploratory();
    intent
}

const BG_SUFFIXES: &[&str] = &["ите", "ата", "ото", "ето", "ият", "ята", "ове", "ища", "ния", "ия", "ът", "ят", "ци", "та", "то", "те", "ов", "ев", "и", "а", "я", "о", "е"];
const EN_SUFFIXES: &[&str] = &["ing", "ed", "es", "s", "ly"];
const BG_VOWELS: &[char] = &['а', 'е', 'и', 'о', 'у', 'ъ', 'я', 'ю'];

/// The stem-prefix of a term, if the rules produce one that is safe to match by prefix.
///
/// Bulgarian (Cyrillic term of >= 5 letters): strip the longest listed ending that leaves >= 4 letters, then drop one trailing
/// vowel (so `идея`, `идеи`, `идеята`, `идеите` all give `иде`). English (other term of >= 5 letters): strip one of
/// `ing ed es s ly` leaving >= 4 letters. Shorter terms match exactly only.
pub fn stem_prefix(term: &str) -> Option<String> {
    let chars: Vec<char> = term.chars().collect();
    if chars.len() < 5 {
        return None;
    }
    if chars.iter().any(|c| is_cyrillic(*c)) {
        let mut stem: Vec<char> = chars.clone();
        let mut best: Option<usize> = None;
        for suffix in BG_SUFFIXES {
            let suffix_chars: Vec<char> = suffix.chars().collect();
            if chars.len() >= suffix_chars.len() + 4 && chars.ends_with(&suffix_chars) && best.is_none_or(|b| suffix_chars.len() > b) {
                best = Some(suffix_chars.len());
            }
        }
        if let Some(len) = best {
            stem.truncate(chars.len() - len);
        }
        if stem.len() >= 4 && stem.last().is_some_and(|c| BG_VOWELS.contains(c)) {
            stem.pop();
        }
        let prefix: String = stem.into_iter().collect();
        return (prefix.chars().count() >= 3 && prefix != term).then_some(prefix);
    }
    let mut best: Option<usize> = None;
    for suffix in EN_SUFFIXES {
        let suffix_chars: Vec<char> = suffix.chars().collect();
        if chars.len() >= suffix_chars.len() + 4 && chars.ends_with(&suffix_chars) && best.is_none_or(|b| suffix_chars.len() > b) {
            best = Some(suffix_chars.len());
        }
    }
    best.map(|len| chars[..chars.len() - len].iter().collect::<String>()).filter(|prefix| prefix != term)
}

pub fn interpret(raw: &str) -> Result<InterpretedQuery, QueryProblem> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(QueryProblem::Empty);
    }
    if trimmed.chars().count() > MAX_QUERY_CHARS {
        return Err(QueryProblem::TooLong);
    }
    let folded = normalize_text(trimmed);
    let words: Vec<String> = folded.split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).map(str::to_string).collect();

    let cyrillic_letters = folded.chars().filter(|c| is_cyrillic(*c)).count();
    let latin_letters = folded.chars().filter(|c| c.is_alphabetic() && !is_cyrillic(*c)).count();
    let language = match (cyrillic_letters > 0, latin_letters > 0) {
        (true, true) => QueryLanguage::Mixed,
        (true, false) => QueryLanguage::Bulgarian,
        _ => QueryLanguage::English,
    };

    let is_stopword = |word: &str| STOPWORDS_BG.contains(&word) || STOPWORDS_EN.contains(&word);
    let content: Vec<&String> = words.iter().filter(|w| !is_stopword(w)).collect();
    // Cue words are dropped from the terms, but never at the price of an empty search.
    let without_cues: Vec<&String> = content.iter().copied().filter(|w| !CUE_PREFIXES.iter().any(|cue| w.starts_with(cue))).collect();
    let chosen = if without_cues.is_empty() { content } else { without_cues };

    let mut terms: Vec<Term> = Vec::new();
    for word in chosen {
        if terms.iter().any(|t| t.text == *word) {
            continue;
        }
        terms.push(Term { text: word.clone(), prefix: stem_prefix(word) });
        if terms.len() == MAX_TERMS {
            break;
        }
    }

    let phrase_text = terms.iter().map(|t| t.text.as_str()).collect::<Vec<_>>().join(" ");
    let phrase = (terms.len() >= 2 || phrase_text.chars().count() >= 6).then_some(phrase_text);

    Ok(InterpretedQuery { raw: trimmed.to_string(), language, terms, phrase, intent: intent_of(&folded) })
}

fn quote(token: &str) -> String {
    // Tokens only ever contain letters and digits, so this is belt and braces: an embedded quote is doubled per FTS5 rules.
    format!("\"{}\"", token.replace('"', "\"\""))
}

fn push_variants(parts: &mut Vec<String>, token: &str, prefix: bool) {
    let star = if prefix { "*" } else { "" };
    parts.push(format!("{}{star}", quote(token)));
    let decomposed: String = token.nfd().collect();
    if decomposed != token {
        parts.push(format!("{}{star}", quote(&decomposed)));
    }
}

/// The FTS5 `MATCH` expression, or `None` when there is nothing to search for. Every token is quoted, so no query text can be
/// interpreted as FTS5 syntax (`NEAR`, `-`, `*`, column filters, parentheses). Restricted to title and body.
pub fn match_expression(query: &InterpretedQuery) -> Option<String> {
    if query.terms.is_empty() {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    for term in &query.terms {
        push_variants(&mut parts, &term.text, false);
        if let Some(prefix) = &term.prefix {
            push_variants(&mut parts, prefix, true);
        }
    }
    Some(format!("{{title body}}: ({})", parts.join(" OR ")))
}

/// Fraction of the query's content terms that some token of `text` matches (exact, or by stem-prefix).
pub fn term_coverage(query: &InterpretedQuery, text: &str) -> f64 {
    if query.terms.is_empty() {
        return 0.0;
    }
    let text_tokens = tokens(text);
    let matched = query.terms.iter().filter(|term| text_tokens.iter().any(|token| term.matches_token(token))).count();
    matched as f64 / query.terms.len() as f64
}

/// Whether the folded title contains the query's entity phrase.
pub fn title_has_phrase(query: &InterpretedQuery, title: &str) -> bool {
    let Some(phrase) = &query.phrase else { return false };
    let folded_title = tokens(title).join(" ");
    folded_title.contains(phrase.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(text: &str) -> InterpretedQuery {
        interpret(text).unwrap()
    }

    fn texts(query: &InterpretedQuery) -> Vec<&str> {
        query.terms.iter().map(|t| t.text.as_str()).collect()
    }

    #[test]
    fn empty_and_oversized_queries_are_refused() {
        assert_eq!(interpret("   \n"), Err(QueryProblem::Empty));
        assert_eq!(interpret(&"а".repeat(MAX_QUERY_CHARS + 1)), Err(QueryProblem::TooLong));
        assert!(interpret(&"а".repeat(MAX_QUERY_CHARS)).is_ok());
    }

    #[test]
    fn bulgarian_inflections_share_one_stem_prefix_and_english_stemming_is_never_applied_to_them() {
        for word in ["идея", "идеи", "идеята", "идеите"] {
            let stem = stem_prefix(word);
            // Short forms match exactly; the long ones give `иде`.
            if word.chars().count() >= 5 {
                assert_eq!(stem.as_deref(), Some("иде"), "{word}");
            }
        }
        assert_eq!(stem_prefix("мобилното").as_deref(), Some("мобилн"));
        assert_eq!(stem_prefix("приложенията").as_deref(), Some("приложен"));
        // `ing`/`ed`/`s` are English rules: a Cyrillic word that happens to end like them is not touched by them.
        assert_eq!(stem_prefix("работещи").as_deref(), Some("работещ"));
        assert_eq!(stem_prefix("ideas").as_deref(), Some("idea"));
        assert_eq!(stem_prefix("capturing").as_deref(), Some("captur"));
        assert_eq!(stem_prefix("mobile"), None);
        assert_eq!(stem_prefix("app"), None);
    }

    #[test]
    fn terms_are_content_words_without_stopwords_and_intent_cues_unless_nothing_else_remains() {
        let query = q("How did my idea for Arthur mobile evolve, and what does it depend on?");
        assert_eq!(texts(&query), ["idea", "arthur", "mobile"]);
        assert_eq!(query.intent.evolution, 1.0);
        assert_eq!(query.intent.dependency, 1.0);
        // Only cue words: the search must not become empty.
        assert_eq!(texts(&q("decision history")), ["decision", "history"]);
        assert_eq!(texts(&q("как се е променила идеята за мобилното приложение")), ["идеята", "мобилното", "приложение"]);
    }

    #[test]
    fn language_follows_script() {
        assert_eq!(q("offline first").language, QueryLanguage::English);
        assert_eq!(q("мобилно приложение").language, QueryLanguage::Bulgarian);
        assert_eq!(q("мобилно app").language, QueryLanguage::Mixed);
    }

    #[test]
    fn nfc_and_nfd_input_normalise_to_the_same_terms_and_the_expression_carries_both_forms() {
        let composed = "край";
        let decomposed: String = composed.nfd().collect();
        assert_ne!(composed, decomposed);
        assert_eq!(texts(&q(composed)), texts(&q(&decomposed)));
        let expression = match_expression(&q(composed)).unwrap();
        assert!(expression.contains(&format!("\"{composed}\"")), "{expression}");
        assert!(expression.contains(&format!("\"{decomposed}\"")), "{expression}");
        // A stress mark is dropped.
        assert_eq!(texts(&q("ва\u{0301}жно")), ["важно"]);
    }

    #[test]
    fn the_expression_is_injection_safe() {
        for hostile in ["NEAR(a b) OR title:x", "\"quote\" AND -excluded*", "a) OR (b", "title:secret", "* ^ { } :"] {
            if let Ok(query) = interpret(hostile) {
                if let Some(expression) = match_expression(&query) {
                    let body = expression.strip_prefix("{title body}: (").and_then(|e| e.strip_suffix(')')).unwrap();
                    for part in body.split(" OR ") {
                        let part = part.trim_end_matches('*');
                        assert!(part.starts_with('"') && part.ends_with('"') && part.len() >= 2, "{expression}");
                        assert!(part[1..part.len() - 1].chars().all(|c| c.is_alphanumeric() || c == '"'), "{expression}");
                    }
                }
            }
        }
        assert_eq!(match_expression(&q("the of and")), None, "stopwords only: the lexical channel is skipped");
    }

    #[test]
    fn coverage_counts_exact_and_stem_matches() {
        let query = q("мобилното приложение идеята");
        assert!((term_coverage(&query, "Мобилни приложения за идеите") - 1.0).abs() < 1e-9);
        assert!((term_coverage(&query, "Нещо за идеи") - 1.0 / 3.0).abs() < 1e-9);
        assert_eq!(term_coverage(&query, "няма нищо"), 0.0);
    }

    #[test]
    fn the_phrase_bonus_needs_the_whole_phrase_in_the_title() {
        let query = q("Arthur mobile capture");
        assert!(title_has_phrase(&query, "Arthur Mobile capture-first"));
        assert!(!title_has_phrase(&query, "Mobile Arthur capture"));
        assert!(q("x y").phrase.is_some() && q("short").phrase.is_none());
    }

    #[test]
    fn intent_is_a_set_of_weights_not_a_route() {
        let plain = q("offline sync");
        assert_eq!(plain.intent.exploratory, 1.0);
        assert_eq!(q("why did I decide to use SQLite").intent.decision, 1.0);
        assert_eq!(q("защо реших да използвам SQLite").intent.decision, 1.0);
        assert_eq!(q("what contradicts the offline plan").intent.contradiction, 1.0);
        assert_eq!(q("where did this idea come from").intent.provenance, 1.0);
    }
}
