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

// ---------------------------------------------------------------------------
// #822/#825 — compiled-workflow slot binding.
//
// An orchestrator agent composes context-using child agents. At
// /api/context-resolve callback time there is no execution-state signal for
// WHICH child is active (children run inside the parent's WayFlow on a
// shared, run-scoped auth), so the trusted slot source is derived from the
// STRUCTURE of the run package's own installed OAS instead.
//
// Ground truth (verified against blog-pipeline-agent's compiled cinatra/oas.json):
// an orchestrator's installed OAS inlines each composed child's
// context-resolution FlowNode carrying `metadata.cinatra.purpose ===
// "author-placed-context-resolution-for-<slotId>"` INSIDE the child's subflow
// DEFINITION (a Flow with an `id`), while the child's package identity lives on
// the REFERENCING FlowNode (`subflow.$component_ref === <definition id>` plus
// `metadata.cinatra.packageName`). Ownership therefore needs a two-pass join
// over `$component_ref`, not a nearest-enclosing-metadata walk (which would
// silently mis-resolve on the real shape).
// ---------------------------------------------------------------------------

const CONTEXT_RESOLUTION_PURPOSE_PREFIX = "author-placed-context-resolution-for-";
// cinatra#1194 — the loader-injected marker family (mount-time injection;
// never in installed bytes today). ANY marker family present for the slot
// keeps the legacy structural join authoritative.
const LOADER_INJECTED_PURPOSE_PREFIX = "loader-injected-context-resolution-for-";

function metadataCinatra(
  node: Record<string, unknown>,
): Record<string, unknown> | null {
  const meta = node["metadata"];
  if (typeof meta !== "object" || meta === null) return null;
  const cin = (meta as Record<string, unknown>)["cinatra"];
  return typeof cin === "object" && cin !== null
    ? (cin as Record<string, unknown>)
    : null;
}

/** A Flow definition owns child components — it carries an `id` plus flow
 *  structure. The walk tracks the nearest enclosing one so a marker can be
 *  attributed to the subflow DEFINITION that contains it. */
function isFlowDefinition(node: Record<string, unknown>): boolean {
  return (
    typeof node["id"] === "string" &&
    (typeof node["$referenced_components"] === "object" ||
      typeof node["start_node"] === "string" ||
      Array.isArray(node["nodes"]))
  );
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** cinatra#1194 — loader/verifier CARRIER-PREDICATE PARITY (Codex round-1):
 *  the declaration JOIN counts a contextSlots declaration only on a node the
 *  loader's `_is_flow_definition` recognizes (plain-object refs / string-or-
 *  plain-object start_node / nodes array). The looser legacy isFlowDefinition
 *  stays untouched for walk-boundary attribution. */
function isStrictFlowCarrier(rec: Record<string, unknown>): boolean {
  return (
    typeof rec["id"] === "string" &&
    (isPlainObject(rec["$referenced_components"]) ||
      typeof rec["start_node"] === "string" ||
      isPlainObject(rec["start_node"]) ||
      Array.isArray(rec["nodes"]))
  );
}

/** Which child package does an ORCHESTRATOR'S OWN installed OAS bind to a
 *  context slot?
 *
 *  Single recursive pass that collects both halves of a join:
 *   - the Flow definition ids whose subtree carries the author-placed
 *     context-resolution marker for `slotId`, and
 *   - the `metadata.cinatra.packageName` of every FlowNode that references a
 *     definition via `subflow.$component_ref`.
 *  The slot's owner is the package that references a marked definition.
 *
 *  Fail-closed contract — returns null when the slot is unbound in this
 *  workflow, the enclosing definition has no package-named referencer (e.g. a
 *  marker sitting in the orchestrator's own root flow), or more than one
 *  DISTINCT package ends up bound to the same slotId (ambiguity is never
 *  trusted). Only an EXACT, unambiguous single owner is returned. */
export function findBoundChildPackageForSlot(
  oas: Record<string, unknown>,
  slotId: string,
  opts?: {
    /** cinatra#1194 — allow the DECLARATION join for slim (declaration-only)
     *  compositions: a nested Flow definition whose own
     *  metadata.cinatra.contextSlots declares `slotId`, owned by the unique
     *  packageName among its referencing FlowNodes. Enabled by the IO caller
     *  ONLY on the run-token-authenticated path. ANY marker for the slot
     *  (either family) keeps the legacy structural join authoritative. */
    allowDeclarationBinding?: boolean;
  },
): string | null {
  const marker = `${CONTEXT_RESOLUTION_PURPOSE_PREFIX}${slotId}`;
  const injectedMarker = `${LOADER_INJECTED_PURPOSE_PREFIX}${slotId}`;
  const markedDefinitionIds = new Set<string>();
  const packageByDefinitionId = new Map<string, Set<string>>();
  // cinatra#1194 — definition ids whose OWN metadata declares `slotId`
  // (declaration attribution never crosses a nested-definition boundary:
  // the carrier is the definition node the metadata sits on). The root
  // document carries no referencing FlowNode, so a root declaration
  // correctly contributes no owner here (a top-level slot belongs to the
  // run package itself; this function serves the composed path only).
  const declaringDefinitionIds = new Set<string>();
  const declaredCountByDefinition = new Map<string, number>();
  let markerSeenAnyFamily = false;

  const walk = (node: unknown, enclosingDefinitionId: string | null): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, enclosingDefinitionId);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const rec = node as Record<string, unknown>;
    const cin = metadataCinatra(rec);

    if (cin?.["purpose"] === marker && enclosingDefinitionId) {
      markedDefinitionIds.add(enclosingDefinitionId);
    }
    if (cin?.["purpose"] === marker || cin?.["purpose"] === injectedMarker) {
      markerSeenAnyFamily = true;
    }

    const subflow = rec["subflow"];
    const componentRef =
      typeof subflow === "object" && subflow !== null
        ? (subflow as Record<string, unknown>)["$component_ref"]
        : null;
    if (
      typeof componentRef === "string" &&
      typeof cin?.["packageName"] === "string"
    ) {
      const set = packageByDefinitionId.get(componentRef) ?? new Set<string>();
      set.add(cin["packageName"] as string);
      packageByDefinitionId.set(componentRef, set);
    }

    const isDefinition = isFlowDefinition(rec);
    // Declaration recognition uses the STRICT (loader-parity) predicate;
    // boundary attribution below keeps the legacy predicate.
    if (isStrictFlowCarrier(rec) && cin) {
      const rawSlots = cin["contextSlots"];
      if (Array.isArray(rawSlots)) {
        const defId = rec["id"] as string;
        let declaredHere = 0;
        for (const entry of rawSlots) {
          const entrySlot =
            typeof entry === "object" && entry !== null
              ? (entry as Record<string, unknown>)["slotId"]
              : null;
          if (entrySlot === slotId) declaredHere += 1;
        }
        if (declaredHere > 0) {
          declaringDefinitionIds.add(defId);
          // ACCUMULATE across same-id definitions: two definitions sharing
          // one id that both declare the slot must read as ambiguous.
          declaredCountByDefinition.set(
            defId,
            (declaredCountByDefinition.get(defId) ?? 0) + declaredHere,
          );
        }
      }
    }

    const nextDefinitionId = isDefinition
      ? (rec["id"] as string)
      : enclosingDefinitionId;
    for (const value of Object.values(rec)) walk(value, nextDefinitionId);
  };

  walk(oas, null);

  // Legacy structural join — authoritative whenever ANY marker family names
  // the slot (mirrors the loader's injection-skip rule).
  if (markedDefinitionIds.size > 0 || markerSeenAnyFamily) {
    const owners = new Set<string>();
    for (const defId of markedDefinitionIds) {
      for (const pkg of packageByDefinitionId.get(defId) ?? []) owners.add(pkg);
    }
    if (owners.size !== 1) return null;
    return [...owners][0] ?? null;
  }

  // cinatra#1194 — declaration join (run-token path only).
  if (!opts?.allowDeclarationBinding) return null;
  // Exactly ONE definition declares the slot, exactly ONCE (a duplicate
  // in-carrier declaration or a multi-carrier slot is ambiguous → null).
  if (declaringDefinitionIds.size !== 1) return null;
  const declaringDefId = [...declaringDefinitionIds][0];
  if (declaredCountByDefinition.get(declaringDefId) !== 1) return null;
  const owners = packageByDefinitionId.get(declaringDefId);
  if (!owners || owners.size !== 1) return null;
  return [...owners][0] ?? null;
}
