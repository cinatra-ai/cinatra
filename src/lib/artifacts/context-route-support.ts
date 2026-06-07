import { createHash } from "node:crypto";
import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";
import type { ResolvedContextRef } from "./context-resolver";

// ---------------------------------------------------------------------------
// Pure support logic for /api/context-resolve and /api/context-finalize.
//
// This module is intentionally dependency-light (type-only imports) so it can
// be unit-tested in isolation. The heavy IO (auth, run, actor, resolver,
// installed-extension discovery, OAS load) lives in `context-route-io.ts`.
//
// Per the frozen contract:
//   - candidates  = resolveContextSlot() refs (display meta optional)
//   - slotMeta    = the trusted slot definition (maxItems OMITTED if unbounded)
//   - selectedRefs = route-computed pre-selection
//       interactive            → []
//       autonomous + override   → [candidates[0]]  (single-ref collapse)
//       autonomous + accumulate → candidates (sliced to maxItems if set)
//   - projectId "" is normalized to undefined (resolver fail-closes on a
//     defined-but-non-member projectId)
//   - idempotency = content-addressed selectionKey (no schema change)
// ---------------------------------------------------------------------------

/** A resolved/selectable candidate. Superset of ResolvedContextRef with
 *  optional display meta (the resolver does not currently emit display
 *  fields, so candidates == refs today). */
export type ContextCandidate = ResolvedContextRef & {
  displayName?: string;
  description?: string;
};

export type ContextSlotMeta = {
  slotId: string;
  resolutionMode: "override" | "accumulate";
  selectionMode: "interactive" | "autonomous";
  minItems: number;
  maxItems?: number;
  readableOnly: boolean;
  acceptedArtifactExtensions: string[];
};

export class ContextRouteError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Normalize the empty-string projectId to undefined. resolveContextSlot
 *  treats a *defined* projectId as a strict membership gate and returns []
 *  when the actor lacks it — so a defaulted "" must become undefined. */
export function normalizeProjectId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}

/** Build the frozen slotMeta envelope from a trusted slot. `maxItems` is
 *  OMITTED when unbounded (the renderer treats any numeric maxItems as a
 *  hard cap, so 0 would disable all selection). */
export function buildSlotMeta(slot: AgentContextSlot): ContextSlotMeta {
  return {
    slotId: slot.slotId,
    resolutionMode: slot.resolutionMode,
    selectionMode: slot.selectionMode,
    minItems: typeof slot.minItems === "number" ? slot.minItems : 0,
    ...(typeof slot.maxItems === "number" ? { maxItems: slot.maxItems } : {}),
    readableOnly: slot.readableOnly === true,
    acceptedArtifactExtensions: [...slot.acceptedArtifactExtensions],
  };
}

/** Route-side autonomous pre-selection. The resolver returns the full
 *  candidate set (override → all refs of the narrowest tier); the single-ref
 *  collapse for autonomous happens HERE (per context-resolver.ts:315 doc). */
export function computeAutonomousSelectedRefs(
  candidates: ContextCandidate[],
  slot: AgentContextSlot,
): ContextCandidate[] {
  if (candidates.length === 0) return [];
  if (slot.resolutionMode === "override") {
    return [candidates[0]];
  }
  if (typeof slot.maxItems === "number" && candidates.length > slot.maxItems) {
    return candidates.slice(0, slot.maxItems);
  }
  return candidates;
}

/** Pre-selection for the resolve route, per the frozen contract. */
export function computeRouteSelectedRefs(
  candidates: ContextCandidate[],
  slot: AgentContextSlot,
): ContextCandidate[] {
  return slot.selectionMode === "autonomous"
    ? computeAutonomousSelectedRefs(candidates, slot)
    : [];
}

/** Canonical triple key for a single ref (selection-identity primitive). */
export function refTripleKey(r: {
  artifactId: string;
  representationRevisionId: string;
  semanticAssertionId: string;
}): string {
  return `${r.artifactId}|${r.representationRevisionId}|${r.semanticAssertionId}`;
}

/** Canonicalize (dedupe + sort) a ref list into stable triple keys. */
export function canonicalizeTriples(
  refs: ReadonlyArray<{
    artifactId: string;
    representationRevisionId: string;
    semanticAssertionId: string;
  }>,
): string[] {
  const set = new Set<string>();
  for (const r of refs) set.add(refTripleKey(r));
  return [...set].sort();
}

/** Content-addressed selection key. A replay of the same selection yields
 *  the same key (deterministic, dedup + sort applied first). */
export function computeSelectionKey(input: {
  parentRunId: string;
  parentPackageName: string;
  slotId: string;
  selectionMode: "interactive" | "autonomous";
  refs: ReadonlyArray<{
    artifactId: string;
    representationRevisionId: string;
    semanticAssertionId: string;
  }>;
}): string {
  // Structured, injective material (JSON tuples — not a delimiter-joined
  // string) so the key is collision-free independent of ref-id shape. Triples
  // are deduped + sorted for replay-stability.
  const tuples = [
    ...new Map(
      input.refs.map((r) => [
        refTripleKey(r),
        [r.artifactId, r.representationRevisionId, r.semanticAssertionId] as const,
      ]),
    ).values(),
  ].sort((a, b) =>
    refTripleKey({
      artifactId: a[0],
      representationRevisionId: a[1],
      semanticAssertionId: a[2],
    }).localeCompare(
      refTripleKey({
        artifactId: b[0],
        representationRevisionId: b[1],
        semanticAssertionId: b[2],
      }),
    ),
  );
  const material = JSON.stringify({
    parentRunId: input.parentRunId,
    parentPackageName: input.parentPackageName,
    slotId: input.slotId,
    selectionMode: input.selectionMode,
    triples: tuples,
  });
  return createHash("sha256").update(material).digest("hex");
}

export type SelectionEnvelope = {
  slotId: string;
  resolutionMode: "override" | "accumulate";
  selectedRefs: Array<{
    artifactId: string;
    representationRevisionId: string;
    semanticAssertionId: string;
  }>;
};

/** Parse the JSON envelope string emitted by the renderer (interactive) or
 *  synthesized in the autonomous finalize ApiNode. Throws ContextRouteError
 *  (422) on malformed input. */
export function parseUserResponseEnvelope(userResponse: string): SelectionEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(userResponse);
  } catch {
    throw new ContextRouteError(422, "bad_envelope", "userResponse is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ContextRouteError(422, "bad_envelope", "userResponse is not an object");
  }
  const o = parsed as Record<string, unknown>;
  const slotId = typeof o.slotId === "string" ? o.slotId : "";
  const resolutionMode = o.resolutionMode === "override" ? "override" : "accumulate";
  const rawRefs = Array.isArray(o.selectedRefs) ? o.selectedRefs : [];
  const selectedRefs = rawRefs.map((r) => {
    const x = (r ?? {}) as Record<string, unknown>;
    return {
      artifactId: String(x.artifactId ?? ""),
      representationRevisionId: String(x.representationRevisionId ?? ""),
      semanticAssertionId: String(x.semanticAssertionId ?? ""),
    };
  });
  if (!slotId) {
    throw new ContextRouteError(422, "bad_envelope", "userResponse missing slotId");
  }
  return { slotId, resolutionMode, selectedRefs };
}

/** Revalidate submitted refs against the TRUSTED candidate set. Returns the
 *  matched trusted candidates (NOT the body-supplied refs — extension /
 *  sourceScope / ownerId come from the resolver, not the client). Throws
 *  ContextRouteError(422) on any membership / min / max / mode violation. */
export function revalidateSelectedRefs(input: {
  submitted: SelectionEnvelope["selectedRefs"];
  candidates: ContextCandidate[];
  slot: AgentContextSlot;
}): ContextCandidate[] {
  const { submitted, candidates, slot } = input;
  const byTriple = new Map<string, ContextCandidate>();
  for (const c of candidates) byTriple.set(refTripleKey(c), c);

  const seen = new Set<string>();
  const trusted: ContextCandidate[] = [];
  for (const ref of submitted) {
    const key = refTripleKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const match = byTriple.get(key);
    if (!match) {
      throw new ContextRouteError(
        422,
        "ref_not_in_candidates",
        `selected ref ${key} is not in the trusted candidate set`,
      );
    }
    trusted.push(match);
  }

  const minItems = typeof slot.minItems === "number" ? slot.minItems : 0;
  if (trusted.length < minItems) {
    throw new ContextRouteError(
      422,
      "below_min_items",
      `selected ${trusted.length} refs < minItems ${minItems}`,
    );
  }
  if (typeof slot.maxItems === "number" && trusted.length > slot.maxItems) {
    throw new ContextRouteError(
      422,
      "above_max_items",
      `selected ${trusted.length} refs > maxItems ${slot.maxItems}`,
    );
  }
  if (slot.resolutionMode === "override" && trusted.length > 1) {
    throw new ContextRouteError(
      422,
      "override_multi_select",
      `override slot cannot have ${trusted.length} selected refs`,
    );
  }
  return trusted;
}

/** Build the append-only audit rows from trusted candidates. */
export function buildSelectionRows(input: {
  orgId: string;
  parentRunId: string;
  parentPackageName: string;
  slotId: string;
  selectionMode: "interactive" | "autonomous";
  trusted: ContextCandidate[];
}): Array<{
  orgId: string;
  parentRunId: string;
  parentPackageName: string;
  slotId: string;
  artifactId: string;
  representationRevisionId: string;
  semanticAssertionId: string;
  extension: string;
  sourceScope: ResolvedContextRef["sourceScope"];
  selectedBy: "user" | "autonomous";
  selectionMode: "interactive" | "autonomous";
}> {
  const selectedBy = input.selectionMode === "autonomous" ? "autonomous" : "user";
  return input.trusted.map((c) => ({
    orgId: input.orgId,
    parentRunId: input.parentRunId,
    parentPackageName: input.parentPackageName,
    slotId: input.slotId,
    artifactId: c.artifactId,
    representationRevisionId: c.representationRevisionId,
    semanticAssertionId: c.semanticAssertionId,
    extension: c.extension,
    sourceScope: c.sourceScope,
    selectedBy,
    selectionMode: input.selectionMode,
  }));
}
