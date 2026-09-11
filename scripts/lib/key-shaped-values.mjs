// ONE definition of "this string looks like a credential", shared by everything
// in `scripts/` that must refuse to persist one.
//
// WHY IT IS SHARED. The app already carries this rule set three times over —
// `src/lib/chat-capture/redact.ts`, `src/lib/setup-readiness-saga.ts` and
// `src/lib/assistant-runtime/ports.ts` all strip key-shaped text before it
// reaches a log, a persisted failure record or a UI. Those are RUNTIME
// redactors and they cannot be imported here: this module is read by
// dependency-free node scripts (a CI gate that runs before any install, and a
// container-env generator that must not drag the app's module graph in). So the
// patterns are mirrored, deliberately and in one place, instead of being
// re-invented per script. A prefix added there belongs here too.
//
// The set is the union of the prefixes the repo's own redactors and test
// fixtures use: OpenAI/Anthropic `sk-`/`sk-ant-`, Stripe `sk_live_`/`rk_live_`,
// GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`, Slack `xox…`, npm
// `npm_`, AWS `AKIA`/`ASIA`, Google `AIza`/`ya29.`, and bare JWTs.
//
// LENGTH FLOORS ARE THE FALSE-POSITIVE CONTROL. `sk-` alone appears in prose;
// `sk-` followed by sixteen or more key characters does not. Each floor is the
// floor the app's own redactor uses for that shape, so a value that is scrubbed
// at runtime is also refused at rest and neither is stricter than the other by
// accident. Where a redactor uses NO floor because the prefix is already
// unambiguous — `sk-ant-`, `AIza`, `ya29.` in `src/lib/setup-readiness-saga.ts`
// and `src/lib/assistant-runtime/ports.ts` — this module carries no floor
// either: a floor here that the redactor does not have would let a short
// credential be refused at runtime and accepted at rest, which is the wrong way
// round for a gate.
//
// This module NEVER reports the matched text. Callers get the pattern's LABEL
// and a position, because a gate that prints the credential it found has
// published it — into CI logs, which are broadly readable.

/**
 * @typedef {{ label: string, pattern: RegExp }} KeyShapePattern
 */

/**
 * Every shape treated as a credential. Each `pattern` is global so a scan can
 * count occurrences; callers must not rely on `lastIndex` across calls (the
 * helpers below reset it).
 *
 * @type {KeyShapePattern[]}
 */
export const KEY_SHAPED_PATTERNS = [
  // Anthropic first: `sk-ant-…` also satisfies the generic `sk-` rule, and
  // reporting the more specific label is more useful to whoever has to fix it.
  { label: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]+/g },
  { label: "openai-api-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { label: "stripe-secret-key", pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { label: "stripe-restricted-key", pattern: /\brk_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { label: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { label: "github-fine-grained-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { label: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  { label: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { label: "google-api-key", pattern: /\b(?:AIza|ya29\.)[A-Za-z0-9_.-]+/g },
  {
    label: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
];

/**
 * Every key shape found in `text`, as `{ label, index, length }` — never the
 * matched text itself. Line numbers are the caller's business; `index` is a
 * character offset into `text`.
 *
 * @param {string} text
 * @returns {{ label: string, index: number, length: number }[]}
 */
export function findKeyShapedMatches(text) {
  if (typeof text !== "string" || text === "") return [];
  const found = [];
  for (const { label, pattern } of KEY_SHAPED_PATTERNS) {
    // Fresh regex per call: the exported patterns are global, and a shared
    // `lastIndex` across calls silently skips matches.
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      found.push({ label, index: match.index, length: match[0].length });
      // A zero-length match cannot happen with these patterns, but a future
      // one must not spin this loop forever.
      if (match[0].length === 0) re.lastIndex += 1;
    }
  }
  return found.sort((a, b) => a.index - b.index || a.label.localeCompare(b.label));
}

/**
 * Does `text` carry anything key-shaped? The cheap question, for a write guard.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function containsKeyShapedValue(text) {
  return findKeyShapedMatches(text).length > 0;
}

/**
 * 1-indexed line numbers carrying a key shape, with the pattern label. Used by
 * the gate to point at a file's line without quoting it.
 *
 * @param {string} text
 * @returns {{ label: string, line: number }[]}
 */
export function findKeyShapedLines(text) {
  const matches = findKeyShapedMatches(text);
  if (matches.length === 0) return [];
  // Offsets of every line start, so a match index maps to a line by binary-free
  // forward scan (files here are small; clarity beats cleverness).
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  const seen = new Set();
  const out = [];
  for (const { label, index } of matches) {
    let line = 1;
    for (let i = 0; i < lineStarts.length; i += 1) {
      if (lineStarts[i] <= index) line = i + 1;
      else break;
    }
    const key = `${label}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, line });
  }
  return out;
}
