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
 * (#2567) and S5's schedule-proposal producer (#2569).
 *
 * `schedule_proposal_render` mints a PROPOSAL, and a proposal writes nothing —
 * the ref it produces IS the whole proposal (a signed, opaque, expiring token;
 * see `src/lib/trigger-schedule-proposal-token.ts`). That is what keeps it in
 * this per-viewType allowlist rather than needing a different kind of entry:
 * the tool is as read-only as the two `*_render` primitives beside it, and the
 * ACT of scheduling happens later, in a human session action carrying that
 * token. A model holding this tool can draw a card and nothing else.
 */
export const LIFECYCLE_PRODUCER_TOOLS: Record<
  LifecycleViewType,
  readonly string[]
> = {
  artifact_review_gate: ["artifact_review_gates_list", "artifact_review_gate_render"],
  verification_summary: ["verification_record_render"],
  trigger_schedule_proposal: ["schedule_proposal_render"],
};

/**
 * The ONE result every lifecycle primitive returns when the caller may not have
 * what they asked for — whether it does not exist, is out of scope, or is
 * policy-denied. All three are indistinguishable by construction.
 */
export const LIFECYCLE_REFUSAL_RESULT = "Not available to you.";

// ---------------------------------------------------------------------------
// THE PLATFORM PRODUCER (cinatra#2930, epic #2926 W3)
// ---------------------------------------------------------------------------

/**
 * THE SECOND PRODUCER, AND THE FIRST-CLASS ONE.
 *
 * Until this wave the only way a lifecycle card could reach a conversation was
 * a model calling a tool for it, so a run could park at a moment and the person
 * would see a sentence about a card, a link to another page, or nothing. The
 * plan makes the platform the producer — "the platform itself writes the card
 * into the run's own turn, from an outbox the coordinator feeds when a moment
 * opens" — and keeps the tools: "The 'show me' tools the model can call stay as
 * a second way to bring a card back into view, recorded as exactly that."
 *
 * SO RECOGNITION GAINS A TUPLE, NOT A HOLE — AND THE TUPLE IS NOT ENOUGH ON ITS
 * OWN (a convergence review, finding 4). These are two public strings, and a tool
 * result is model-visible and model-influenced: a recognizer that minted
 * `platform_injected` for whoever presented them would be relying on an MCP
 * INGRESS rule (a server label may not carry a colon) to protect a property of
 * THIS boundary. That is an assumption about somebody else's code, and the whole
 * reason the producer bind exists is not to make assumptions like it.
 *
 * So the platform arm is gated on `admitPlatformProducer`, an explicit argument
 * the caller must pass. The sink — the ONE caller that handles tool results —
 * never passes it, so no tool result can be recognized as an injection however
 * it is labelled. The outbox passes it, because the outbox is not a tool result:
 * it is server code the model cannot reach. The property is now local and total
 * rather than inherited.
 *
 * MIRRORED, NOT IMPORTED, like the viewType list above and for the same reason
 * (this module is pure by design). Pinned to `@cinatra-ai/agents/lifecycle-part-outbox`
 * by the drift test in __tests__/lifecycle-view-envelope.test.ts.
 */
export const LIFECYCLE_PLATFORM_PRODUCER_LABEL = "cinatra:platform";

/** The platform producer's one act. Deliberately not a tool name. */
export const LIFECYCLE_PLATFORM_PRODUCER_ACT = "lifecycle_moment_opened";

/**
 * The viewTypes the PLATFORM may produce.
 *
 * Every DATA_PART-represented kind whose truth is the run's own row. The
 * schedule is here because a CONFIRMED schedule is carried by the run; the held
 * schedule reaches the assistant's own turn through `schedule_proposal_render`
 * and never through the outbox — "it never enters the run outbox, because there
 * is no run".
 */
export const LIFECYCLE_PLATFORM_VIEW_TYPES = [
  "artifact_review_gate",
  "verification_summary",
  "trigger_schedule_proposal",
] as const;

/**
 * WHO DELIVERED A CARD. Recorded on the recognition, never on the payload.
 *
 *   `platform_injected` — the run reached the moment and the platform wrote it.
 *   `tool_represented`  — a "show me" tool brought it back into view.
 *
 * The payload stays the byte-identical strict `{ viewType, schemaVersion, ref }`
 * a `.strict()` parser accepts on re-read, so provenance rides BESIDE it — the
 * same separation `dataPartSlots` already makes for the producing slot.
 */
export type LifecyclePartProvenance = "platform_injected" | "tool_represented";

/** The DATA_PART payload minted from a recognized envelope, and WHO minted it. */
export type LifecycleViewDataPart = {
  viewType: LifecycleViewType;
  schemaVersion: number;
  ref: string;
  /**
   * NOT PART OF THE PAYLOAD. A caller writes `{ viewType, schemaVersion, ref }`
   * to the wire and the durable row, and carries this beside it.
   */
  provenance: LifecyclePartProvenance;
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

/**
 * Which producer minted this, or `null` for one outside every tuple.
 *
 * TWO TUPLES, CHECKED THE SAME WAY. The platform's is checked FIRST and its
 * label can never be an MCP server label, so the two sets cannot overlap and a
 * tool result can never be read as a platform injection.
 */
function producerOf(
  viewType: LifecycleViewType,
  serverLabel: unknown,
  toolName: unknown,
  admitPlatformProducer: boolean,
): LifecyclePartProvenance | null {
  if (typeof serverLabel !== "string" || typeof toolName !== "string") {
    return null;
  }
  if (
    admitPlatformProducer &&
    serverLabel === LIFECYCLE_PLATFORM_PRODUCER_LABEL &&
    toolName === LIFECYCLE_PLATFORM_PRODUCER_ACT &&
    (LIFECYCLE_PLATFORM_VIEW_TYPES as readonly string[]).includes(viewType)
  ) {
    return "platform_injected";
  }
  return isAllowedProducer(viewType, serverLabel, toolName)
    ? "tool_represented"
    : null;
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
 * unknown viewType, or an envelope from a server/tool outside BOTH producer
 * tuples. NEVER throws: an adversarial payload degrades to "no card".
 *
 * The answer carries WHICH producer minted it (cinatra#2930): the platform's
 * injection and a tool's re-presentation are the same card and two different
 * facts, and the durable row records which one it was.
 */
export function recognizeLifecycleViewEnvelope(params: {
  serverLabel?: unknown;
  toolName?: unknown;
  result?: unknown;
  /**
   * Admit the PLATFORM tuple as well (cinatra#2930). Defaults to `false`, which
   * is what the sink relies on: a tool result can never be recognized as an
   * injection, whatever it is labelled. Only server code the model cannot reach
   * passes `true` — see the platform producer note above.
   */
  admitPlatformProducer?: boolean;
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
  const provenance = producerOf(
    typed,
    serverLabel,
    toolName,
    params.admitPlatformProducer === true,
  );
  if (provenance === null) return null;
  return {
    viewType: typed,
    schemaVersion: LIFECYCLE_ENVELOPE_VERSION,
    ref,
    provenance,
  };
}
