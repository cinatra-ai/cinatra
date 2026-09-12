import { createHash } from "node:crypto";
import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";
import type { ContextCandidate } from "./context-route-support";

// ---------------------------------------------------------------------------
// THE MANIFEST-WIDE CONTEXT ALLOCATION PLANNER (cinatra#2815 S3 part 3).
//
// Before this module the two context routes each decided ONE slot at a time:
// /api/context-resolve resolved the requested slot and pre-selected from it,
// and /api/context-finalize re-resolved that same slot and revalidated the
// submission against it. Two slots of one manifest could therefore be handed
// the SAME artifact twice, and nothing tied what the renderer was shown to
// what the finalize actually wrote.
//
// The planner answers the manifest's question ONCE: given every declared slot
// and the candidates each resolved to, WHICH refs does each slot get. Four
// rules, in this order, and the order is the contract:
//
//   1. THE ASSIGNED LAYER SITS ABOVE AMBIENT. A candidate carrying
//      `layer: "assigned"` was deliberately assigned to a scope; an ambient one
//      was merely discovered by the resolver's visibility walk. Within each
//      layer the resolver's own narrow -> broad order is preserved untouched.
//   2. OVERRIDE PICKS THE FIRST IN THE LANDED CHAIN. `resolutionMode:
//      "override"` collapses to a single ref — the first of the merged list,
//      i.e. the narrowest assigned ref, or the narrowest ambient one when the
//      slot has no assigned layer. That is the same chain the slots reader
//      documents (project -> user -> team -> organization -> workspace).
//   3. CROSS-SLOT DEDUPE, WITH minItems BEATING THE DEDUPE. A ref already
//      allocated to an earlier slot is dropped from the later ones, so the run
//      never pays for the same artifact twice — UNLESS dropping it would take
//      that slot below its declared `minItems`, in which case the declaration
//      wins and the ref is kept in both. A slot the author declared as
//      REQUIRED must not be emptied by an optimization.
//   4. maxItems APPLIES AFTER THE MERGE, ASSIGNED-FIRST. The cap trims the
//      TAIL of the merged, deduped list, and because assigned refs lead that
//      list the cap can only ever drop ambient ones first.
//
// The whole allocation is then content-addressed into a
// `ContextAllocationTokenV1`: resolve returns it, the renderer carries it, and
// finalize recomputes the identical payload and compares. A mismatch is DRIFT
// — the world moved between the gate being drawn and the human answering it —
// and it is a structured conflict, never a silent write of a different set.
//
// PURE: no IO, no database, no `server-only`. The IO half (reading every
// declared slot from the trusted OAS and resolving each) lives in
// `context-route-io.ts`, which is what the two routes call.
// ---------------------------------------------------------------------------

/** The planner's own version. It rides INSIDE the token material, so a change
 *  to any rule above invalidates every outstanding token by construction. */
export const CONTEXT_ALLOCATION_PLANNER_VERSION = "context-allocation-planner-v1";

/** The token's versioned prefix. A token is `<version>.<base64url sha256>`. */
export const CONTEXT_ALLOCATION_TOKEN_VERSION = "ContextAllocationTokenV1";

/** Which layer produced a candidate. `assigned` = deliberately assigned to a
 *  scope; anything else (including an absent field) is ambient discovery. */
export type ContextAllocationLayer = "assigned" | "ambient";

/** A resolved candidate as the planner needs it: the route's candidate plus
 *  the optional layer tag. An untagged candidate is ambient. */
export type PlannerCandidate = ContextCandidate & { layer?: ContextAllocationLayer };

/** One declared slot together with everything it resolved to. */
export type PlannerSlotInput = {
  slot: AgentContextSlot;
  candidates: PlannerCandidate[];
};

/** What one slot was allocated. */
export type ContextSlotAllocation = {
  slotId: string;
  refs: PlannerCandidate[];
};

/** ONE allocation for the whole manifest. */
export type ContextAllocation = {
  plannerVersion: string;
  manifestDigest: string;
  slots: ContextSlotAllocation[];
};

/** The canonical triple key, byte-identical to the one the selection key uses. */
function tripleKey(r: {
  artifactId: string;
  representationRevisionId: string;
  semanticAssertionId: string;
}): string {
  return `${r.artifactId}|${r.representationRevisionId}|${r.semanticAssertionId}`;
}

function isAssigned(c: PlannerCandidate): boolean {
  return c.layer === "assigned";
}

function sha256Base64Url(material: string): string {
  return createHash("sha256").update(material).digest("base64url");
}

/**
 * The digest of the DECLARED manifest shape — slot ids and every field that
 * changes what the planner may allocate. Candidates are deliberately NOT in
 * it: the digest says "this is the manifest the gate was drawn for", while the
 * allocation itself says "and this is what it resolved to". A republished
 * agent whose slot declaration changed therefore drifts even when the world's
 * artifacts did not move at all.
 */
export function computeContextManifestDigest(
  slots: ReadonlyArray<AgentContextSlot>,
): string {
  const material = JSON.stringify(
    slots.map((s) => [
      s.slotId,
      s.resolutionMode,
      s.selectionMode,
      [...s.acceptedArtifactExtensions].sort(),
      typeof s.minItems === "number" ? s.minItems : null,
      typeof s.maxItems === "number" ? s.maxItems : null,
      s.readableOnly === true,
    ]),
  );
  return sha256Base64Url(material);
}

/**
 * ONE deterministic allocation for the whole manifest.
 *
 * `inputs` arrive in the manifest's DECLARED order, which is also the dedupe
 * precedence order: the earlier a slot is declared, the stronger its claim on a
 * ref two slots could both take. The trusted loader rejects a duplicate slot id
 * before a manifest ever reaches here, so declaration order is total.
 */
export function planContextAllocation(
  inputs: ReadonlyArray<PlannerSlotInput>,
): ContextAllocation {
  const manifestDigest = computeContextManifestDigest(inputs.map((i) => i.slot));
  const claimed = new Set<string>();
  const slots: ContextSlotAllocation[] = [];

  for (const { slot, candidates } of inputs) {
    // (1) assigned above ambient, each layer in the resolver's own order.
    const merged = [
      ...candidates.filter((c) => isAssigned(c)),
      ...candidates.filter((c) => !isAssigned(c)),
    ];
    // (2) override collapses to the FIRST of that merged chain.
    const scoped = slot.resolutionMode === "override" ? merged.slice(0, 1) : merged;

    // (3) cross-slot dedupe, then re-admit only as far as minItems demands.
    const minItems = typeof slot.minItems === "number" ? slot.minItems : 0;
    const fresh = scoped.filter((c) => !claimed.has(tripleKey(c)));
    const kept = [...fresh];
    if (kept.length < minItems) {
      for (const c of scoped) {
        if (kept.length >= minItems) break;
        if (fresh.includes(c)) continue;
        kept.push(c);
      }
      // Re-admitted refs must keep the merged order, not land at the tail.
      kept.sort((a, b) => scoped.indexOf(a) - scoped.indexOf(b));
    }

    // (4) maxItems AFTER the merge — the tail goes, so ambient goes first.
    const capped =
      typeof slot.maxItems === "number" && kept.length > slot.maxItems
        ? kept.slice(0, slot.maxItems)
        : kept;

    for (const c of capped) claimed.add(tripleKey(c));
    slots.push({ slotId: slot.slotId, refs: capped });
  }

  return {
    plannerVersion: CONTEXT_ALLOCATION_PLANNER_VERSION,
    manifestDigest,
    slots,
  };
}

/** The allocation one slot received, or undefined when the manifest has no
 *  such slot. */
export function allocationForSlot(
  allocation: ContextAllocation,
  slotId: string,
): ContextSlotAllocation | undefined {
  return allocation.slots.find((s) => s.slotId === slotId);
}

/**
 * The content-addressed `ContextAllocationTokenV1`.
 *
 * Material = the token version, the planner version, the manifest digest, and
 * the ORDERED slot allocation as structured tuples (never a delimiter-joined
 * string, so the encoding is injective whatever an id contains). SHA-256,
 * base64url, prefixed with the token version so a future V2 is distinguishable
 * on sight rather than by a failed comparison.
 */
export function computeContextAllocationToken(allocation: ContextAllocation): string {
  const material = JSON.stringify({
    v: CONTEXT_ALLOCATION_TOKEN_VERSION,
    plannerVersion: allocation.plannerVersion,
    manifestDigest: allocation.manifestDigest,
    slots: allocation.slots.map((s) => [
      s.slotId,
      s.refs.map((r) => [
        r.artifactId,
        r.representationRevisionId,
        r.semanticAssertionId,
        isAssigned(r) ? "assigned" : "ambient",
      ]),
    ]),
  });
  return `${CONTEXT_ALLOCATION_TOKEN_VERSION}.${sha256Base64Url(material)}`;
}

/** The drift comparison, as a verdict rather than a boolean so the caller can
 *  report WHICH two tokens disagreed without re-deriving them. */
export function compareAllocationTokens(
  expected: string,
  actual: string,
):
  | { ok: true }
  | { ok: false; expected: string; actual: string } {
  return expected === actual ? { ok: true } : { ok: false, expected, actual };
}

/** The structured drift conflict. The routes translate it into their own
 *  stable-code rejection surface; the class carries the two tokens so the
 *  rejection can name them without a second computation. */
export class ContextAllocationDriftError extends Error {
  readonly code = "allocation_drift";
  readonly expectedToken: string;
  readonly actualToken: string;

  constructor(expectedToken: string, actualToken: string) {
    super(
      `context allocation drifted: the gate was drawn for ${expectedToken} ` +
        `and now plans ${actualToken}`,
    );
    this.name = "ContextAllocationDriftError";
    this.expectedToken = expectedToken;
    this.actualToken = actualToken;
  }
}
