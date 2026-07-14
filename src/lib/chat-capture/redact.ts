// Chat-capture input redaction (cinatra#1367).
//
// Pure module. Scrubs secret- and PII-shaped content from chat text BEFORE it
// reaches the capture pipeline's LLM calls. Scope note from the issue design:
// the PRIMARY chat model necessarily already saw the raw message — this
// guarantee is scoped to the CAPTURE pipeline (classifier AND distiller
// inputs), which must never re-transmit secrets to an LLM provider or embed
// them in a persisted skill body.
//
// Distinct from src/lib/redact-sensitive.ts (structural key-based LOG
// redaction): chat text is free-form, so this scrubber is entirely
// pattern-based. Patterns are deliberately narrow-but-covering; like
// STRING_PATTERN_SCRUBS, extend by ADDING entries rather than broadening
// existing ones. The seeded-secret test (redact.test.ts) is the acceptance
// gate: seeded secrets never reach classifier/distiller inputs.

const REPLACEMENT = "[REDACTED]";

const SCRUB_PATTERNS: readonly RegExp[] = [
  // PEM key/certificate blocks (multiline).
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
  // JWTs: three dot-separated base64url segments starting with eyJ.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // "Authorization: Bearer <token>" and bare "Bearer <token>".
  /(\bauthorization\s*:\s*bearer\s+)\S+/gi,
  /(\bbearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
  // Well-known token prefixes: OpenAI/Anthropic (sk-…), GitHub (ghp_/gho_/
  // ghu_/ghs_/ghr_/github_pat_), Slack (xox…), Stripe (sk_live_/rk_live_),
  // npm (npm_), AWS access key ids (AKIA/ASIA…).
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\brk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // key=value style assignments for credential-named keys. Captures the key +
  // separator, scrubs the value (quoted or bare).
  /((?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|connection[_-]?string)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
  // Credentialed URLs: scheme://user:pass@host.
  /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+(@)/gi,
  // Email addresses (PII).
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  // Long card-shaped digit runs (13–19 digits, optional space/dash groups).
  /\b(?:\d[ -]?){13,19}\b/g,
];

/**
 * Scrub secret/PII-shaped content from text destined for the chat-capture
 * classifier or distiller. Group-based patterns keep their non-secret prefix
 * (e.g. `password: `) so the redacted text stays readable.
 */
export function redactChatCaptureText(text: string): string {
  let out = String(text ?? "");
  for (const pattern of SCRUB_PATTERNS) {
    out = out.replace(pattern, (match, ...groups) => {
      // Patterns with capture groups keep group 1 (and a trailing group 2 for
      // the credentialed-URL '@'); groupless patterns replace wholesale.
      // replace() appends (offset, fullString) after the group args — slice
      // them off before filtering, or the full input would count as a group.
      const captured = groups.slice(0, -2).filter((g) => typeof g === "string") as string[];
      if (captured.length >= 2 && match.includes("@")) {
        return `${captured[0]}${REPLACEMENT}${captured[1]}`;
      }
      if (captured.length >= 1) {
        return `${captured[0]}${REPLACEMENT}`;
      }
      return REPLACEMENT;
    });
  }
  return out;
}
