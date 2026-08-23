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

/**
 * Canonical package form: `@cinatra-ai/<slug>`.
 *
 * Lowercase-only ON PURPOSE — npm scope and package names are lowercase by
 * definition, so this is the shape of a real packageName. The caller lowercases
 * the message text before it matches (see `detectExplicitDispatchPackage`), so a
 * user who types `@Cinatra-AI/Some-Agent` still resolves here.
 */
export const CANONICAL_PKG_RE = /@cinatra-ai\/([a-z][a-z0-9-]*)/g;

/**
 * Legacy `cinatra_<slug>` "tool" wording from the per-agent function-tool
 * form. Still appears in fixtures and operator prompts; maps to the canonical
 * `@cinatra-ai/<slug>` package.
 *
 * Lowercase-only AND matched against the RAW message text — deliberately NOT
 * the case-folded text the canonical matcher reads (cinatra#2912 review,
 * NEW-1). The canonical form folds case to stay in parity with the client
 * mention tokenizer; that argument does not reach here, because the tokenizer
 * only ever lexes `@`-mentions and this form produces no mention token at all
 * (pinned at `packages/chat/src/__tests__/scoped-agent-dispatch-streams.test.ts`
 * — "No mention token at all"). With no client behaviour to be in parity with,
 * folding case here only widens the matcher onto ordinary SHOUTED identifiers:
 * the tree ships `CINATRA_THEME`, `CINATRA_ID`, `CINATRA_STATUS` and more, and
 * a user asking a configuration question about one of them would trip the hard
 * pre-model short-circuit at `src/lib/assistant-runtime/runtime.ts` and get a
 * spurious failed agent dispatch instead of an answer.
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
 *
 * Case-INSENSITIVE for the CANONICAL `@vendor/slug` form only, to stay in
 * parity with the client mention tokenizer: `Use @Cinatra-AI/Some-Agent …`
 * resolves to `@cinatra-ai/some-agent`. The legacy `cinatra_<slug>` form stays
 * case-SENSITIVE — it has no client counterpart, so it has no parity argument
 * (cinatra#2912 review, NEW-1).
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
  const raw = last.content;
  // `EXPLICIT_DISPATCH_VERB_RE` carries `/i`, so the raw text is the right
  // input for the hedge whichever matcher fires below.
  if (!EXPLICIT_DISPATCH_VERB_RE.test(raw)) return null;

  // CASE PARITY WITH THE CLIENT, FOR THE CANONICAL FORM ONLY (cinatra#2820
  // review; narrowed by the cinatra#2912 review). The client mention tokenizer
  // lexes scoped refs case-insensitively and lowercases vendor+slug
  // (`packages/chat/src/mention-tokenizer.ts` — `MENTION_RE`, the `/gi` flags),
  // so `Use @Cinatra-AI/Some-Agent …` produces the SAME `agent-dispatch`
  // classification as the all-lowercase form and takes the streaming route
  // (`packages/chat/src/route-decision.ts`). Matching the raw text here would
  // then find nothing and dispatch nothing — the #2820 defect exactly, on a case
  // variant: the message streams and the agent never runs. The lowercased match
  // IS the canonical packageName, because npm scope/package names are lowercase
  // by definition.
  //
  // The fold stops at this matcher. The legacy `cinatra_<slug>` form below reads
  // the RAW text: it has no client counterpart, so it has no parity argument to
  // stand on, and folding case for it would make ordinary SHOUTED identifiers
  // such as `CINATRA_THEME` fire a hard agent dispatch. See
  // `LEGACY_CINATRA_SLUG_RE`.
  const canonicalMatches = Array.from(
    raw.toLowerCase().matchAll(CANONICAL_PKG_RE),
  );
  if (canonicalMatches.length > 0) {
    return `@cinatra-ai/${canonicalMatches[0][1]}`;
  }
  const legacyMatches = Array.from(raw.matchAll(LEGACY_CINATRA_SLUG_RE));
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
    "(see the run-polling guidance in the `chat-assistant-core` skill's references).",
    "",
    "If dispatch returns a structured rejection (e.g. `WAYFLOW_AGENT_NOT_REGISTERED`),",
    "surface the `error` verbatim to the user and stop.",
    "",
    "**Never write a run URL yourself.** The run plays out on a live card in this",
    "conversation, so the user needs no link to act on it, and the card carries",
    "its own link to the run page. A path you compose from a run id does not",
    "exist and 404s.",
    "",
    "---",
    "",
  ].join("\n");
}
