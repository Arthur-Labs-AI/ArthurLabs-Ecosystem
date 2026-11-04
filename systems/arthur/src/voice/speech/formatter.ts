/**
 * Speech formatter (Phase 3 spec section 14).
 *
 * Display Markdown is never sent to TTS directly. This layer produces a
 * concise, speakable rendering: strips Markdown/control syntax, code fences
 * and inline code, collapses tables into a short spoken summary, does not
 * read URLs character-by-character, and keeps numbers/dates/units intact.
 * It never alters tool approval semantics - approval flow is driven by the
 * controller, not by spoken text.
 */

export interface SpeechFormatOptions {
  /** Read code content instead of saying it is shown on screen. */
  speakCode?: boolean;
  /** Hard cap on the spoken text (chars); truncated at a sentence. */
  maxSpeechChars?: number;
}

const DEFAULT_MAX_SPEECH_CHARS = 4000;

function stripCodeFences(text: string, speakCode: boolean): string {
  const fencePattern = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
  if (speakCode) {
    return text.replace(fencePattern, (block) => {
      const body = block.replace(/^```[^\n]*\n?|^~~~[^\n]*\n?|```$|~~~$/g, "");
      return body.trim();
    });
  }
  return text.replace(fencePattern, " Code is shown on screen. ");
}

function stripInlineCode(text: string): string {
  return text.replace(/`([^`\n]+)`/g, "$1");
}

function stripMarkdownSyntax(text: string): string {
  return text
    // headings
    .replace(/^#{1,6}\s+/gm, "")
    // bold/italic/underline
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    // links: [label](url) -> label
    .replace(/\[([^\[\]]+)\]\([^)]*\)/g, "$1")
    // bullet/numbered list markers
    .replace(/^\s*([-*+]|\d+\.)\s+/gm, "")
    // blockquotes
    .replace(/^>\s*/gm, "")
    // tables: drop separator rows; render cells as a short comma list
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, (row) => row.replace(/\s*\|\s*/g, ", ").replace(/^,|,$/g, ""));
}

function stripUrlsAndNoise(text: string): string {
  return text
    // bare URLs -> "(link shown on screen)"
    .replace(/https?:\/\/[^\s<>\"']+/gi, " link shown on screen ")
    .replace(/www\.[^\s<>\"']+/gi, " link shown on screen ")
    // markdown-style citations [1], [2,3], [citation:..]
    .replace(/\[\d+(?:[,\-]\d+)*\]/g, "")
    .replace(/\[citation[^\]]*\]/gi, "")
    // JSON-ish object blobs
    .replace(/\{[^{}]*\}/g, " ")
    // raw tool payloads / ids
    .replace(/\b(?:tool_[a-z0-9]+|call_[a-z0-9]+|run_[a-z0-9]+)\b/g, "")
    // long unbroken identifiers (paths/hashes) - say nothing
    .replace(/\S{40,}/g, " ");
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim();
}

function truncateAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const lastBoundary = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "), head.lastIndexOf("; "));
  if (lastBoundary > maxChars * 0.4) return head.slice(0, lastBoundary + 1).trim();
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace > 0) return head.slice(0, lastSpace).trim();
  return head.trim();
}

/**
 * Transform display text into safe, speakable text (spec section 14).
 */
export function formatForSpeech(displayText: string, opts: SpeechFormatOptions = {}): string {
  const speakCode = opts.speakCode ?? false;
  const maxChars = opts.maxSpeechChars ?? DEFAULT_MAX_SPEECH_CHARS;
  let out = displayText ?? "";
  out = stripCodeFences(out, speakCode);
  out = stripInlineCode(out);
  out = stripMarkdownSyntax(out);
  out = stripUrlsAndNoise(out);
  out = collapseWhitespace(out);
  return truncateAtSentence(out, maxChars);
}

export class SpeechFormatter {
  private readonly opts: SpeechFormatOptions;

  constructor(opts: SpeechFormatOptions = {}) {
    this.opts = opts;
  }

  format(displayText: string): string {
    return formatForSpeech(displayText, this.opts);
  }
}
