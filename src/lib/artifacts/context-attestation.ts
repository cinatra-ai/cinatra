import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// #907 — per-node context-callback attestation (pure logic).
//
// `/api/context-resolve` + `/api/context-finalize` authorize a composed child
// agent's context-slot resolution during an orchestrator run. #822/#825 proved
// (package, slot) STRUCTURAL consistency against the run package's own compiled
// OAS, but had no signal for WHICH child is calling — children share the run's
// bridge auth, so a composed child could resolve a SIBLING's own-bound
// (package, slot) within the run (#907 residual).
//
// The fix: the WayFlow runtime (docker/wayflow/agent_loader.py) mints a signed
// attestation over `(contextId, nodeId)` where `nodeId` is the compiled context-
// resolution ApiCallStep's OWN id (`ctx-<slotId>-{resolve_context,finalize_*}`),
// read from `self.id` at `_execute_request` — NOT from the request body (the
// body's slotId/parentPackageName are runtime-wired inputs the caller controls).
// The signing key is DEDICATED (distinct from the bridge token) so a caller
// holding only the run's bridge auth cannot forge it.
//
// This module is intentionally dependency-light (node:crypto only) so it is
// unit-testable in isolation. The IO caller (context-route-io.ts) supplies the
// key, the trusted contextId, the request headers, and the run's installed OAS.
//
// SECURITY BOUNDARY — the node id STRING is NOT trusted for its shape. The
// authority is the run's compiled OAS STRUCTURE: `resolveContextNodeProvenance`
// re-anchors the attested nodeId to the marked owner call-site (the same
// `author-placed-context-resolution-for-<slotId>` structure #825 keys on) and
// fails closed on an unknown, duplicated (id-collision), or ambiguous node.
// So a child that plants/executes a node whose id merely LOOKS like a sibling's
// (`ctx-<siblingSlot>-*`) does not pass unless that exact id is the unique,
// marked, package-bound context node for that slot in the run OAS.
// ---------------------------------------------------------------------------

export const CONTEXT_ATTESTATION_VERSION = "v1";
export const CONTEXT_NODE_HEADER = "x-cinatra-context-node";
export const CONTEXT_ATTESTATION_HEADER = "x-cinatra-context-attestation";

/** The two endpoint "kinds" a context-resolution ApiNode targets. `resolve` →
 *  /api/context-resolve; `finalize` → /api/context-finalize (interactive or
 *  autonomous). The route passes the kind it serves so a resolve attestation
 *  cannot be replayed on finalize (and vice-versa). */
export type ContextNodeKind = "resolve" | "finalize";

/** Canonical, injective signing material. Newline-delimited so no field can
 *  bleed into another (contextId/nodeId are opaque ids without newlines). The
 *  version prefix lets the contract rev without silent cross-version replay. */
export function contextAttestationMaterial(
  contextId: string,
  nodeId: string,
): string {
  return `${CONTEXT_ATTESTATION_VERSION}\n${contextId}\n${nodeId}`;
}

/** HMAC-SHA256(key, material) hex. Used by the server to recompute; the runtime
 *  computes the same value with the same key (see agent_loader.py). */
export function computeContextAttestation(
  key: string,
  contextId: string,
  nodeId: string,
): string {
  return createHmac("sha256", key)
    .update(contextAttestationMaterial(contextId, nodeId))
    .digest("hex");
}

/** Parse the `X-Cinatra-Context-Attestation` header value. Format:
 *  `v1:<hex>`. Returns the hex signature for the supported version, or null
 *  on any malformed / unknown-version input (caller fails closed). */
export function parseContextAttestationHeader(raw: string | null): string | null {
  if (typeof raw !== "string") return null;
  const idx = raw.indexOf(":");
  if (idx <= 0) return null;
  const version = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  if (version !== CONTEXT_ATTESTATION_VERSION) return null;
  // hex, non-empty, even length (sha256 → 64 hex chars, but keep the check
  // shape-only; the constant-time compare is the real gate).
  if (!/^[0-9a-f]+$/i.test(sig)) return null;
  return sig.toLowerCase();
}

/** Constant-time compare of a provided hex signature against the expected one.
 *  Length-mismatch short-circuits false (timingSafeEqual requires equal-length
 *  buffers). */
export function verifyContextAttestationSignature(input: {
  key: string;
  contextId: string;
  nodeId: string;
  providedSignatureHex: string;
}): boolean {
  const expected = computeContextAttestation(
    input.key,
    input.contextId,
    input.nodeId,
  );
  const providedBuf = Buffer.from(input.providedSignatureHex, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

// ---------------------------------------------------------------------------
// OAS-structure provenance re-anchor.
//
// Ground truth (verified against blog-pipeline-agent's compiled cinatra/oas.json):
//   - each composed child slot inlines a context-resolution SUBFLOW definition
//     (id e.g. `<child>__context-<slotId>-subflow`) whose `$referenced_components`
//     DIRECTLY hold the ApiNodes `ctx-<slotId>-resolve_context` (→ context-resolve)
//     and `ctx-<slotId>-finalize_interactive|autonomous` (→ context-finalize);
//   - the OWNER marker is a FlowNode carrying
//     `metadata.cinatra.purpose === "author-placed-context-resolution-for-<slotId>"`
//     whose `subflow.$component_ref` points at that context-resolution subflow def.
//
// So: enclosing-def(nodeId) === marker.subflow.$component_ref binds a context
// ApiNode to its slot. Duplicate node ids (collision), unowned nodes, and
// ambiguous slots all fail closed.
// ---------------------------------------------------------------------------

const CONTEXT_RESOLUTION_PURPOSE_PREFIX = "author-placed-context-resolution-for-";

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
 *  structure. Mirrors context-route-support.isFlowDefinition so the enclosing-
 *  definition attribution matches the #825 walk. */
function isFlowDefinition(node: Record<string, unknown>): boolean {
  return (
    typeof node["id"] === "string" &&
    (typeof node["$referenced_components"] === "object" ||
      typeof node["start_node"] === "string" ||
      Array.isArray(node["nodes"]))
  );
}

function contextKindForUrl(url: unknown): ContextNodeKind | null {
  if (typeof url !== "string") return null;
  if (url.includes("/api/context-resolve")) return "resolve";
  if (url.includes("/api/context-finalize")) return "finalize";
  return null;
}

export type ContextNodeProvenance = {
  slotId: string;
  kind: ContextNodeKind;
};

/** Re-anchor an attested context-resolution `nodeId` to the run's compiled OAS.
 *
 *  Returns `{ slotId, kind }` derived from the OAS STRUCTURE (the marked owner
 *  call-site), or null when the node id is:
 *   - absent (no context ApiNode with that id), or
 *   - duplicated across enclosing definitions (id-collision — fail closed), or
 *   - not held by a definition that is the `$component_ref` target of exactly
 *     one `author-placed-context-resolution-for-<slotId>` marker (unowned /
 *     ambiguous — fail closed).
 *
 *  The returned slotId/kind are the STRUCTURAL truth; the caller compares them
 *  against the request body (slotId) and the endpoint it serves (kind). The
 *  owner PACKAGE binding stays with findBoundChildPackageForSlot (unchanged). */
export function resolveContextNodeProvenance(
  oas: Record<string, unknown>,
  nodeId: string,
): ContextNodeProvenance | null {
  if (!nodeId) return null;

  // enclosing-def id → slotId, from the owner markers.
  const slotByContextDef = new Map<string, Set<string>>();
  // nodeId → set of { defId, kind } occurrences (as a context ApiNode).
  const occurrencesByNodeId = new Map<
    string,
    Array<{ defId: string | null; kind: ContextNodeKind }>
  >();

  const walk = (node: unknown, enclosingDefinitionId: string | null): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, enclosingDefinitionId);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const rec = node as Record<string, unknown>;
    const cin = metadataCinatra(rec);

    // Owner marker → the context-resolution subflow def it references.
    const purpose = cin?.["purpose"];
    if (
      typeof purpose === "string" &&
      purpose.startsWith(CONTEXT_RESOLUTION_PURPOSE_PREFIX)
    ) {
      const slot = purpose.slice(CONTEXT_RESOLUTION_PURPOSE_PREFIX.length);
      const subflow = rec["subflow"];
      const ref =
        typeof subflow === "object" && subflow !== null
          ? (subflow as Record<string, unknown>)["$component_ref"]
          : null;
      if (slot && typeof ref === "string") {
        const set = slotByContextDef.get(ref) ?? new Set<string>();
        set.add(slot);
        slotByContextDef.set(ref, set);
      }
    }

    // Context-resolution ApiNode → record its id + enclosing def + kind.
    const id = rec["id"];
    const kind = contextKindForUrl(rec["url"]);
    if (typeof id === "string" && kind) {
      const arr = occurrencesByNodeId.get(id) ?? [];
      arr.push({ defId: enclosingDefinitionId, kind });
      occurrencesByNodeId.set(id, arr);
    }

    const nextDefinitionId = isFlowDefinition(rec)
      ? (rec["id"] as string)
      : enclosingDefinitionId;
    for (const value of Object.values(rec)) walk(value, nextDefinitionId);
  };

  walk(oas, null);

  const occ = occurrencesByNodeId.get(nodeId);
  // Absent, or duplicated across definitions (id-collision) → fail closed.
  if (!occ || occ.length !== 1) return null;
  const { defId, kind } = occ[0];
  if (!defId) return null;
  const slots = slotByContextDef.get(defId);
  // The enclosing def is not a single-slot marked context owner → fail closed.
  if (!slots || slots.size !== 1) return null;
  const slotId = [...slots][0];
  return { slotId, kind };
}

// ---------------------------------------------------------------------------
// Pure decision — combines signature verification with the OAS provenance
// re-anchor. Kept dependency-light so the FULL fail-closed decision matrix is
// unit-testable without the auth/run/actor IO chain. context-route-io.ts reads
// the request headers + env and maps a failure to ContextRouteError(403).
// ---------------------------------------------------------------------------

export type ContextAttestationResult =
  | { ok: true; slotId: string; kind: ContextNodeKind }
  | { ok: false; code: string; message: string };

/** Evaluate the #907 attestation for a composed-child context call. Every
 *  failure is a 403-worthy fail-closed reason (the caller maps `code`/`message`
 *  to ContextRouteError). `contextId` MUST be the trusted x-cinatra-a2a-context-id
 *  binding (never a body value); `nodeIdHeader`/`attestationHeader` are the raw
 *  request header values; `runOas` is the run package's installed OAS. */
export function evaluateContextAttestation(input: {
  key: string | undefined | null;
  contextId: string | null;
  nodeIdHeader: string | null;
  attestationHeader: string | null;
  runOas: Record<string, unknown> | null;
  slotId: string;
  expectedKind: ContextNodeKind;
}): ContextAttestationResult {
  const { key, contextId, nodeIdHeader, attestationHeader, runOas } = input;

  if (!contextId) {
    return {
      ok: false,
      code: "attestation_context_required",
      message:
        "composed-child context resolution requires the trusted x-cinatra-a2a-context-id binding",
    };
  }
  if (!key) {
    return {
      ok: false,
      code: "attestation_unconfigured",
      message:
        "CINATRA_CONTEXT_ATTEST_KEY is not set — refusing composed-child context resolution",
    };
  }
  const nodeId = nodeIdHeader;
  const sigHex = parseContextAttestationHeader(attestationHeader);
  if (!nodeId || !sigHex) {
    return {
      ok: false,
      code: "attestation_missing",
      message:
        "composed-child context resolution requires a valid per-node attestation",
    };
  }
  if (
    !verifyContextAttestationSignature({
      key,
      contextId,
      nodeId,
      providedSignatureHex: sigHex,
    })
  ) {
    return {
      ok: false,
      code: "attestation_invalid",
      message: "context attestation signature did not verify",
    };
  }
  const prov = runOas ? resolveContextNodeProvenance(runOas, nodeId) : null;
  if (!prov) {
    return {
      ok: false,
      code: "attestation_node_unrecognized",
      message: `attested node '${nodeId}' is not a unique, marked context-resolution node in the run OAS`,
    };
  }
  if (prov.slotId !== input.slotId) {
    return {
      ok: false,
      code: "attestation_slot_mismatch",
      message: `attested node owns slot '${prov.slotId}', not requested '${input.slotId}'`,
    };
  }
  if (prov.kind !== input.expectedKind) {
    return {
      ok: false,
      code: "attestation_kind_mismatch",
      message: `attested node is a '${prov.kind}' node, not '${input.expectedKind}'`,
    };
  }
  return { ok: true, slotId: prov.slotId, kind: prov.kind };
}
