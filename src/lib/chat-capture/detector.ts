// Chat-capture stage 1: the LEXICAL PRE-FILTER (cinatra#1367).
//
// Pure module (no imports, no server deps) — the cheap gate in the two-stage
// detection design: only turns that pass this filter ever reach the LLM
// classifier, so ordinary chat turns cost ZERO classifier calls (acceptance
// criterion; provable from the ledger's classifier_called=false rows).
//
// The filter looks for durable-instruction SHAPES: standing imperatives
// ("always", "never", "from now on"), corrections ("no, actually", "that's
// wrong, use"), and preference statements ("I prefer", "call me", "remember
// that"). It is deliberately recall-biased — false positives are cheap (the
// classifier rejects them), false negatives are lost captures.
//
// Pasted-content exclusion is a HEURISTIC here by design: message text
// carries no server-stamped provenance distinguishing typed from pasted
// content (#1367 design note), so we use shape signals — very long messages
// and fenced-code-heavy messages are treated as pasted material, not durable
// instructions addressed to the assistant.

/** Messages longer than this are treated as pasted content, not instructions. */
export const CHAT_CAPTURE_MAX_MESSAGE_LENGTH = 4000;

/** Two or more fenced code blocks ⇒ pasted material. */
const CODE_FENCE_RE = /```/g;

// Standing-instruction / correction / preference shapes. Word-boundary
// anchored; case-insensitive. Kept as an exported list so tests (and future
// tuning) see exactly what the gate matches.
export const CHAT_CAPTURE_LEXICAL_PATTERNS: readonly RegExp[] = [
  /\balways\b/i,
  /\bnever\b/i,
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\bin (?:the )?future\b/i,
  /\bfor future reference\b/i,
  /\bremember (?:to|that|this)\b/i,
  /\bkeep in mind\b/i,
  /\bmake sure (?:to|that|you)\b/i,
  /\bplease (?:always|never|stop|start|use|avoid|don'?t)\b/i,
  /\bdon'?t (?:ever|use|do|include|add)\b/i,
  /\bstop (?:doing|using|adding|including)\b/i,
  /\bI (?:prefer|want you to|need you to|expect|like it when)\b/i,
  /\binstead of\b.*\buse\b/i,
  /\buse\b.*\binstead\b/i,
  /\bno,? (?:actually|that'?s wrong|use|do)\b/i,
  /\bthat'?s (?:wrong|not right|incorrect)\b/i,
  /\bcall me\b/i,
  /\brefer to me\b/i,
  /\baddress me\b/i,
  /\bmy (?:preference|preferred)\b/i,
  /\bas a rule\b/i,
  /\bevery time\b/i,
  /\bwhenever you\b/i,
  /\bby default\b/i,
];

export type ChatCapturePrefilterResult =
  | { pass: true }
  | { pass: false; reason: "empty" | "pasted-content" | "no-instruction-shape" };

/**
 * Stage-1 gate. `pass: false` means the turn NEVER reaches the classifier.
 */
export function runChatCaptureLexicalPrefilter(text: string): ChatCapturePrefilterResult {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length === 0) return { pass: false, reason: "empty" };

  // Pasted-content heuristics first: a huge message that happens to contain
  // "always" somewhere is pasted material, not an instruction to the
  // assistant.
  if (trimmed.length > CHAT_CAPTURE_MAX_MESSAGE_LENGTH) {
    return { pass: false, reason: "pasted-content" };
  }
  const fenceCount = (trimmed.match(CODE_FENCE_RE) ?? []).length;
  if (fenceCount >= 4) {
    // 4 backtick-fences = 2+ complete code blocks.
    return { pass: false, reason: "pasted-content" };
  }

  for (const pattern of CHAT_CAPTURE_LEXICAL_PATTERNS) {
    if (pattern.test(trimmed)) return { pass: true };
  }
  return { pass: false, reason: "no-instruction-shape" };
}
