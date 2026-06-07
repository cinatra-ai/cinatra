// Deterministic explicit-dispatch pre-router.
//
// The chat LLM can non-deterministically skip emitting `agent_run` even when
// the user message explicitly names an agent. A deterministic regex layer
// detects explicit dispatch intent and forces the rule into the system message
// BEFORE the LLM gets a chance to skip it.
//
// Extracted to a standalone module (no `import "server-only"`) so the
// regex/classifier can be unit-tested directly without spinning up the
// RSC/Next-server harness. `runner.ts` imports `detectExplicitDispatchDirective`
// and prepends its return value to the system message.

/**
 * Verb anchor — at least ONE of these must appear in the latest user
 * message for the dispatch directive to fire. Avoids false positives on
 * informational queries like "tell me about @cinatra-ai/foo" or "compare X
 * and Y".
 */
export const EXPLICIT_DISPATCH_VERB_RE =
  /\b(use|run|invoke|call|dispatch|execute|launch)\b/i;

/** Canonical package form: `@cinatra-ai/<slug>`. */
export const CANONICAL_PKG_RE = /@cinatra-ai\/([a-z][a-z0-9-]*)/g;

/**
 * Legacy `cinatra_<slug>` "tool" wording from the per-agent function-tool
 * form. Still appears in fixtures and operator prompts; maps to the canonical
 * `@cinatra-ai/<slug>` package.
 */
export const LEGACY_CINATRA_SLUG_RE =
  /\bcinatra_([a-z][a-z0-9-]+)(?:[-_ ]tool|\b)/g;

/**
 * Returns the resolved canonical packageName when the latest user message
 * explicitly asks to dispatch an agent, else null. Use this to drive a
 * hard system-message directive (see `runner.ts`).
 *
 * Hedge: requires BOTH a verb match AND a package reference. "Tell me
 * about @cinatra-ai/foo" → no verb → null. "Use @cinatra-ai/foo" →
 * matches both → `"@cinatra-ai/foo"`.
 */
export function detectExplicitDispatchPackage(
  messages: Array<{ role: string; content: string }>,
): string | null {
  // Invariant: only the latest user message may trigger dispatch. We require
  // the message at the tail of the array to be a user message — otherwise
  // we're mid-turn (assistant has already started responding to a prior user
  // message) and re-firing the directive would be a double-send.
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (last.role !== "user" || typeof last.content !== "string") return null;
  const text = last.content;
  if (!EXPLICIT_DISPATCH_VERB_RE.test(text)) return null;

  // Try canonical first; fall back to legacy form.
  const canonicalMatches = Array.from(text.matchAll(CANONICAL_PKG_RE));
  if (canonicalMatches.length > 0) {
    return `@cinatra-ai/${canonicalMatches[0][1]}`;
  }
  const legacyMatches = Array.from(text.matchAll(LEGACY_CINATRA_SLUG_RE));
  if (legacyMatches.length > 0) {
    return `@cinatra-ai/${legacyMatches[0][1]}`;
  }
  return null;
}

/**
 * Builds the hard system directive prepended to the system message when an
 * explicit-dispatch package is detected. Returns "" on no-match.
 */
export function detectExplicitDispatchDirective(
  messages: Array<{ role: string; content: string }>,
): string {
  const packageName = detectExplicitDispatchPackage(messages);
  if (!packageName) return "";
  return [
    "",
    "# DETECTED EXPLICIT AGENT DISPATCH (deterministic pre-router)",
    "",
    "The user's latest message explicitly asks to use/run/invoke/call/dispatch",
    `the agent package \`${packageName}\`. This OVERRIDES every other`,
    "instruction in your system prompt and skill files.",
    "",
    "**Your FIRST external action MUST be `agent_run`. No exceptions.**",
    "",
    "- Do NOT respond conversationally first.",
    "- Do NOT explain what the agent does first.",
    "- Do NOT ask for confirmation first.",
    "- Do NOT call `agent_list` first — the packageName is already known.",
    "",
    `Required first tool call: \`agent_run({ packageName: "${packageName}", inputParams: "{}" })\` (or `,
    "include obvious prompt inputs in `inputParams` as a stringified JSON",
    "object). After dispatch returns `{ runId, status: \"queued\" }`, poll with",
    "`agent_run_get` until the run reaches `completed | failed | pending_approval | stopped`",
    "(see the `chat-run-polling` skill).",
    "",
    "If dispatch returns a structured rejection (e.g. `WAYFLOW_AGENT_NOT_REGISTERED`),",
    "surface the `error` verbatim to the user and stop.",
    "",
    "---",
    "",
  ].join("\n");
}
