// ---------------------------------------------------------------------------
// The lifecycle typed-view PRODUCER (cinatra#2565, epic #2564 S1).
//
// A lifecycle card must be able to appear mid-turn without the model ever
// holding the thing it shows. The mechanism is a two-step with a hard boundary
// in the middle:
//
//   1. a first-party lifecycle primitive returns a RESERVED, VERSIONED envelope
//      whose entire payload is an opaque `ref` (this module builds it);
//   2. the tool_result arm of the AG-UI sink RECOGNIZES that envelope and mints
//      a `DATA_PART { viewType, schemaVersion, ref }` (this module recognizes
//      it); the card then resolves the AUTHORITATIVE state server-side from the
//      ref, re-checking access per row.
//
// PRODUCER-BOUND. Recognition is bound to the (server, tool) TUPLE of the
// cinatra self-MCP surface. An external MCP server can return bytes that look
// exactly like an envelope and it mints nothing — the label and the tool name
// must both be first-party. This matters because tool results are model-visible
// and model-influenced: without the tuple bind, "print this JSON" would be a
// card-forging primitive for any connector in the org.
//
// TRUNCATION-SAFE BY CONSTRUCTION. `runtime.ts` clips a tool result to 2,000
// characters BEFORE the sink sees it (`slice(0, 2000) + "..."`). An envelope is
// therefore accepted only when the whole result is at most
// LIFECYCLE_ENVELOPE_MAX_LENGTH — strictly below that cap — so a clipped result
// can never parse as an envelope. The failure mode is "no card", never "a card
// pointing at the wrong row".
//
// GENERIC REFUSAL. Every denial path returns exactly LIFECYCLE_REFUSAL_RESULT:
// one fixed sentence, no ids, no counts, no policy detail. The sink-visible
// result is persisted to `assistant_turns.content` and re-fed to the model, so
// a refusal that named what was refused would be a durable enumeration oracle.
// A refusal is not an envelope, so no DATA_PART is minted for it.
//
// PURE MODULE — no imports, by design. The three viewType literals are a LOCAL
// MIRROR of `LIFECYCLE_DATA_PART_VIEW_TYPES` in
// @cinatra-ai/agent-ui-protocol/renderable-views, mirrored rather than imported
// because that subpath resolves the full zod schema registry and this module is
// reachable from routes whose first-party graph is a locked dev-perf budget
// (the same reason the reducer mirrors `renderableViewType`). The mirror is
// PINNED to the real registry by a drift test — see
// __tests__/lifecycle-view-envelope.test.ts.
// ---------------------------------------------------------------------------

/** The reserved envelope key. Namespaced so no ordinary tool result collides. */
export const LIFECYCLE_ENVELOPE_KEY = "$cinatraLifecycleView";

/** Envelope version — bumped only for a breaking envelope-shape change. */
export const LIFECYCLE_ENVELOPE_VERSION = 1;

/**
 * Maximum accepted length of a lifecycle tool result, in characters.
 *
 * MUST stay strictly below the runtime's tool-result cap (2,000) — the
 * truncation invariant above depends on it, and a test pins the relationship.
 */
export const LIFECYCLE_ENVELOPE_MAX_LENGTH = 1024;

/** Maximum accepted `ref` length. Mirrors LIFECYCLE_VIEW_REF_MAX_LENGTH. */
export const LIFECYCLE_REF_MAX_LENGTH = 512;

/** The serverLabel of the cinatra self-MCP surface (`buildCinatraMcpServerTool`). */
export const LIFECYCLE_PRODUCER_SERVER_LABEL = "cinatra";

/**
 * The lifecycle viewTypes carried as a DATA_PART. LOCAL MIRROR — drift-pinned
 * against the protocol registry. `recommendation_hold` is deliberately absent:
 * it is carried as a typed INTERRUPT (the run is blocked on it), landing in S4.
 */
export const LIFECYCLE_VIEW_TYPES = [
  "artifact_review_gate",
  "verification_summary",
  "trigger_schedule_proposal",
] as const;

export type LifecycleViewType = (typeof LIFECYCLE_VIEW_TYPES)[number];

/**
 * The self-MCP tools allowed to mint a lifecycle view, per viewType.
 *
 * This is the second half of the producer tuple, and it is deliberately a
 * per-viewType allowlist rather than one flat set: a tool that may render a
 * verification record must not be able to mint a REVIEW GATE card, even though
 * both are first-party. The named tools are S3's read-only pull primitives
 * (#2567). `trigger_schedule_proposal` has NO producer tool yet — S5 (#2569)
 * owns the proposal token and adds its entry here; until then the viewType is
 * registered on the wire and unmintable, which is the correct fail-closed
 * posture rather than a placeholder that accepts anything.
 */
export const LIFECYCLE_PRODUCER_TOOLS: Record<
  LifecycleViewType,
  readonly string[]
> = {
  artifact_review_gate: ["artifact_review_gates_list", "artifact_review_gate_render"],
  verification_summary: ["verification_record_render"],
  trigger_schedule_proposal: [],
};

/**
 * The ONE result every lifecycle primitive returns when the caller may not have
 * what they asked for — whether it does not exist, is out of scope, or is
 * policy-denied. All three are indistinguishable by construction.
 */
export const LIFECYCLE_REFUSAL_RESULT = "Not available to you.";

/** The DATA_PART payload minted from a recognized envelope. */
export type LifecycleViewDataPart = {
  viewType: LifecycleViewType;
  schemaVersion: number;
  ref: string;
};

/**
 * Build the reserved tool-result envelope for a lifecycle primitive. Returns
 * `null` when the ref does not fit the bounds — a caller that cannot express
 * its ref inside the budget must refuse rather than emit an oversized envelope
 * that the sink would (correctly) drop.
 */
export function buildLifecycleViewEnvelope(params: {
  viewType: LifecycleViewType;
  ref: string;
}): string | null {
  const { viewType, ref } = params;
  if (typeof ref !== "string" || ref.length === 0) return null;
  if (ref.length > LIFECYCLE_REF_MAX_LENGTH) return null;
  if (!(LIFECYCLE_VIEW_TYPES as readonly string[]).includes(viewType)) return null;
  const serialized = JSON.stringify({
    [LIFECYCLE_ENVELOPE_KEY]: LIFECYCLE_ENVELOPE_VERSION,
    viewType,
    ref,
  });
  return serialized.length <= LIFECYCLE_ENVELOPE_MAX_LENGTH ? serialized : null;
}

function isAllowedProducer(
  viewType: LifecycleViewType,
  serverLabel: unknown,
  toolName: unknown,
): boolean {
  if (typeof serverLabel !== "string" || typeof toolName !== "string") return false;
  // EXACT match, deliberately. The injection boundary drops every label that
  // NORMALIZES to the reserved one ("Cinatra", " CINATRA ", "cinatra-"), so
  // accepting a normalized match here would only ever widen the accepted set
  // beyond what the boundary guarantees. Narrow acceptance + broad rejection
  // is the pair that cannot disagree in the dangerous direction.
  if (serverLabel !== LIFECYCLE_PRODUCER_SERVER_LABEL) return false;
  return LIFECYCLE_PRODUCER_TOOLS[viewType].includes(toolName);
}

/**
 * Recognize a lifecycle view envelope on a tool result and project the
 * DATA_PART payload. Returns `null` for everything else — a non-envelope
 * result, a refusal, a truncated/oversized result, a malformed envelope, an
 * unknown viewType, or an envelope from a server/tool outside the producer
 * tuple. NEVER throws: an adversarial payload degrades to "no card".
 */
export function recognizeLifecycleViewEnvelope(params: {
  serverLabel?: unknown;
  toolName?: unknown;
  result?: unknown;
}): LifecycleViewDataPart | null {
  const { serverLabel, toolName, result } = params;
  // A non-string result never reaches the wire as a lifecycle envelope: the
  // sink's contract is a serialized tool result.
  if (typeof result !== "string") return null;
  // Bounded BEFORE parsing — both the truncation invariant and a cheap guard
  // against a pathological JSON payload.
  if (result.length === 0 || result.length > LIFECYCLE_ENVELOPE_MAX_LENGTH) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope[LIFECYCLE_ENVELOPE_KEY] !== LIFECYCLE_ENVELOPE_VERSION) return null;
  // Strict shape: the reserved key, the viewType and the ref — nothing else.
  // "Refs only, never content" is enforced here as well as by the wire schema,
  // so a producer cannot smuggle a field past the sink and hope the client
  // ignores it.
  const keys = Object.keys(envelope);
  if (keys.length !== 3) return null;
  const viewType = envelope.viewType;
  const ref = envelope.ref;
  if (typeof viewType !== "string" || typeof ref !== "string") return null;
  if (!(LIFECYCLE_VIEW_TYPES as readonly string[]).includes(viewType)) return null;
  if (ref.length === 0 || ref.length > LIFECYCLE_REF_MAX_LENGTH) return null;
  const typed = viewType as LifecycleViewType;
  if (!isAllowedProducer(typed, serverLabel, toolName)) return null;
  return {
    viewType: typed,
    schemaVersion: LIFECYCLE_ENVELOPE_VERSION,
    ref,
  };
}
