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
export const CONTEXT_ATTESTATION_VERSION_V2 = "v2";
export const CONTEXT_NODE_HEADER = "x-cinatra-context-node";
export const CONTEXT_ATTESTATION_HEADER = "x-cinatra-context-attestation";

// #1192 (replay-window hardening) — v2 binds a signed EXPIRY into the material so
// a captured (node, attestation) pair is no longer replayable for the whole run.
// v1 signed only `v1\n<contextId>\n<nodeId>` (no expiry) → a captured pair replayed
// for the run lifetime (up to 24h). The runtime minter (docker/wayflow/
// agent_loader.py) now sets `expiry = now + a short TTL` and emits
// `v2:<expiryEpochSeconds>:<hex>` over `v2\n<contextId>\n<nodeId>\n<expiryEpochSeconds>`.
// A tampered expiry changes the material → the signature fails; a stale expiry is
// caught by the fail-closed window check below.
//
// MERGE-SAFE rollout: the verifier accepts BOTH v1 (legacy, sig-only) and v2, so a
// freshly-deployed verifier still authenticates an as-yet-unrolled minter across
// the non-atomic two-image (Next app vs wayflow container) deploy. v1 acceptance
// is TRANSITIONAL — set CINATRA_CONTEXT_ATTEST_ACCEPT_V1=0 to enforce v2-only once
// the wayflow image has rolled (see evaluateContextAttestation `acceptLegacyV1`).
// v1 stays unforgeable (key-signed); post-rollout the minter emits only v2, so no
// v1 pair exists to capture. Removing v1 acceptance folds into the run-token spine
// that supersedes this whole path.

/** Grace applied to a v2 expiry for verifier/minter clock skew — a token that
 *  expired within this window is still accepted. */
export const CONTEXT_ATTESTATION_SKEW_MS = 60_000;
/** Reject a v2 expiry further in the future than this (defense-in-depth: even a
 *  key-holding minter cannot mint a long-lived token). Comfortably exceeds the
 *  minter TTL (_CONTEXT_ATTESTATION_TTL_SECONDS in agent_loader.py) + skew. */
export const CONTEXT_ATTESTATION_MAX_FUTURE_MS = 600_000;

/** The two endpoint "kinds" a context-resolution ApiNode targets. `resolve` →
 *  /api/context-resolve; `finalize` → /api/context-finalize (interactive or
 *  autonomous). The route passes the kind it serves so a resolve attestation
 *  cannot be replayed on finalize (and vice-versa). */
export type ContextNodeKind = "resolve" | "finalize";

/** Canonical v1 signing material (legacy — no expiry). Newline-delimited so no
 *  field can bleed into another (contextId/nodeId are opaque ids without
 *  newlines). The version prefix prevents silent cross-version replay. */
export function contextAttestationMaterial(
  contextId: string,
  nodeId: string,
): string {
  return `${CONTEXT_ATTESTATION_VERSION}\n${contextId}\n${nodeId}`;
}

/** Canonical v2 signing material — appends the expiry so it is authenticated (a
 *  tampered expiry changes the material and fails the signature). */
export function contextAttestationMaterialV2(
  contextId: string,
  nodeId: string,
  expiryEpochSeconds: number,
): string {
  return `${CONTEXT_ATTESTATION_VERSION_V2}\n${contextId}\n${nodeId}\n${expiryEpochSeconds}`;
}

/** HMAC-SHA256(key, v1 material) hex. */
export function computeContextAttestation(
  key: string,
  contextId: string,
  nodeId: string,
): string {
  return createHmac("sha256", key)
    .update(contextAttestationMaterial(contextId, nodeId))
    .digest("hex");
}

/** HMAC-SHA256(key, v2 material) hex. Mirrors the runtime minter in
 *  agent_loader.py (same key, same material). */
export function computeContextAttestationV2(
  key: string,
  contextId: string,
  nodeId: string,
  expiryEpochSeconds: number,
): string {
  return createHmac("sha256", key)
    .update(contextAttestationMaterialV2(contextId, nodeId, expiryEpochSeconds))
    .digest("hex");
}

/** Parsed `X-Cinatra-Context-Attestation` header — a discriminated union over
 *  the protocol version. v1: `v1:<hex>`; v2: `v2:<expiryEpochSeconds>:<hex>`. */
export type ParsedContextAttestation =
  | { version: "v1"; sigHex: string }
  | { version: "v2"; sigHex: string; expiryEpochSeconds: number };

function isHexSignature(s: string): boolean {
  return s.length > 0 && /^[0-9a-f]+$/i.test(s);
}

/** Parse the `X-Cinatra-Context-Attestation` header value. Returns the parsed
 *  shape for a supported version, or null on any malformed / unknown-version
 *  input (caller fails closed). A v2 expiry must be a non-negative safe integer
 *  (digits only — no sign, dot, NaN, or overflow). */
export function parseContextAttestationHeader(
  raw: string | null,
): ParsedContextAttestation | null {
  if (typeof raw !== "string") return null;
  const firstColon = raw.indexOf(":");
  if (firstColon <= 0) return null;
  const version = raw.slice(0, firstColon);
  const rest = raw.slice(firstColon + 1);
  if (version === CONTEXT_ATTESTATION_VERSION) {
    if (!isHexSignature(rest)) return null;
    return { version: "v1", sigHex: rest.toLowerCase() };
  }
  if (version === CONTEXT_ATTESTATION_VERSION_V2) {
    const secondColon = rest.indexOf(":");
    if (secondColon <= 0) return null;
    const expStr = rest.slice(0, secondColon);
    const sig = rest.slice(secondColon + 1);
    if (!/^[0-9]+$/.test(expStr)) return null;
    const expiryEpochSeconds = Number(expStr);
    if (!Number.isSafeInteger(expiryEpochSeconds)) return null;
    if (!isHexSignature(sig)) return null;
    return { version: "v2", sigHex: sig.toLowerCase(), expiryEpochSeconds };
  }
  return null;
}

/** Constant-time compare of two hex signatures. Length-mismatch short-circuits
 *  false (timingSafeEqual requires equal-length buffers). */
function constantTimeHexEqual(providedHex: string, expectedHex: string): boolean {
  const providedBuf = Buffer.from(providedHex, "utf8");
  const expectedBuf = Buffer.from(expectedHex, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/** Constant-time verify of a v1 signature. */
export function verifyContextAttestationSignature(input: {
  key: string;
  contextId: string;
  nodeId: string;
  providedSignatureHex: string;
}): boolean {
  return constantTimeHexEqual(
    input.providedSignatureHex,
    computeContextAttestation(input.key, input.contextId, input.nodeId),
  );
}

/** Constant-time verify of a v2 signature (expiry is part of the material). */
export function verifyContextAttestationSignatureV2(input: {
  key: string;
  contextId: string;
  nodeId: string;
  expiryEpochSeconds: number;
  providedSignatureHex: string;
}): boolean {
  return constantTimeHexEqual(
    input.providedSignatureHex,
    computeContextAttestationV2(
      input.key,
      input.contextId,
      input.nodeId,
      input.expiryEpochSeconds,
    ),
  );
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
// cinatra#1194 — the loader stamps its injected owner FlowNode with this
// prefix. It never appears in INSTALLED bytes today (injection happens at
// mount, after install), but any marker family present for a slot makes the
// legacy structural path authoritative for that slot — mirror of the
// loader's own skip rule.
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

// ---------------------------------------------------------------------------
// cinatra#1194 — deterministic injection grammar + contextSlots declaration
// re-anchor (the loader-owned subflow path).
//
// A slim (declaration-only) spec carries NO subflow bytes: the WayFlow
// loader injects the canonical template at mount time with ids in the FIXED
// grammar below (docker/wayflow/context_subflow_injection.py — the template
// and this verifier version together in this repo). The attested nodeId of
// such a spec therefore cannot be re-anchored to installed STRUCTURE; it is
// re-anchored to the installed DECLARATION plus the grammar instead, and
// ONLY on the run-token-authenticated path (the image that injects is the
// image that attaches the run token; legacy transports keep the marker path).
// ---------------------------------------------------------------------------

/** The three context ApiNode kinds the loader's template materializes (the
 *  only node ids the runtime minter can sign). Suffix-matched — no kind is a
 *  suffix of another, so the parse is unambiguous. */
const INJECTED_NODE_SUFFIXES: ReadonlyArray<readonly [string, ContextNodeKind]> = [
  ["-resolve_context", "resolve"],
  ["-finalize_interactive", "finalize"],
  ["-finalize_autonomous", "finalize"],
];

/** Parse a nodeId under the deterministic injection grammar
 *  `ctx-<slotId>-<kind>`. Returns null for anything else. */
export function parseInjectedContextNodeId(
  nodeId: string,
): { slotId: string; kind: ContextNodeKind } | null {
  if (!nodeId.startsWith("ctx-")) return null;
  const rest = nodeId.slice(4);
  for (const [suffix, kind] of INJECTED_NODE_SUFFIXES) {
    if (rest.endsWith(suffix)) {
      const slotId = rest.slice(0, -suffix.length);
      if (slotId) return { slotId, kind };
    }
  }
  return null;
}

/** The full id set the loader's injection of `slotId` introduces. Verifier/
 *  injector COLLISION PARITY: the declaration anchor must refuse exactly
 *  where the injector would refuse to inject (any of these ids already
 *  present in the installed bytes). Mirrors _injected_component_ids in
 *  docker/wayflow/context_subflow_injection.py. */
function injectedComponentIds(slotId: string): string[] {
  const kinds = [
    "start",
    "resolve_context",
    "select_mode",
    "emit_context_payload",
    "context_select_gate",
    "finalize_interactive",
    "finalize_autonomous",
    "end",
  ];
  return [
    `context-${slotId}-subflow`,
    `context_${slotId}`,
    ...kinds.map((k) => `ctx-${slotId}-${k}`),
  ];
}

const SELECTION_MODES = new Set(["interactive", "autonomous"]);
const RESOLUTION_MODES = new Set(["override", "accumulate"]);
const ALLOWED_SLOT_KEYS = new Set([
  "slotId",
  "acceptedArtifactExtensions",
  "selectionMode",
  "resolutionMode",
  "minItems",
  "maxItems",
  "readableOnly",
]);

/** Strict single-entry validation mirroring the canonical zod schema in
 *  packages/extensions/src/agent-context-slots-reader.ts (kept inline so this
 *  module stays dependency-light — node:crypto only). */
function isWellFormedSlotEntry(entry: unknown): entry is Record<string, unknown> {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return false;
  }
  const rec = entry as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!ALLOWED_SLOT_KEYS.has(key)) return false;
  }
  if (typeof rec["slotId"] !== "string" || !rec["slotId"]) return false;
  const exts = rec["acceptedArtifactExtensions"];
  if (
    !Array.isArray(exts) ||
    exts.length === 0 ||
    !exts.every((e) => typeof e === "string" && e.length > 0)
  ) {
    return false;
  }
  if (!SELECTION_MODES.has(rec["selectionMode"] as string)) return false;
  if (!RESOLUTION_MODES.has(rec["resolutionMode"] as string)) return false;
  const minItems = rec["minItems"];
  if (
    minItems !== undefined &&
    (!Number.isInteger(minItems) || (minItems as number) < 0)
  ) {
    return false;
  }
  const maxItems = rec["maxItems"];
  if (
    maxItems !== undefined &&
    (!Number.isInteger(maxItems) || (maxItems as number) < 1)
  ) {
    return false;
  }
  if (
    typeof minItems === "number" &&
    typeof maxItems === "number" &&
    minItems > maxItems
  ) {
    return false;
  }
  const readableOnly = rec["readableOnly"];
  if (readableOnly !== undefined && typeof readableOnly !== "boolean") {
    return false;
  }
  return true;
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Loader/verifier CARRIER-PREDICATE PARITY (Codex round-1): a contextSlots
 *  declaration counts ONLY on a node the loader's `_is_flow_definition`
 *  recognizes — string id plus a PLAIN-OBJECT $referenced_components, a
 *  string-or-plain-object start_node, or a nodes array. The legacy
 *  isFlowDefinition (above) is looser (`typeof === "object"` admits
 *  null/arrays) and stays untouched for the #825 walk-boundary attribution;
 *  the DECLARATION scan must mirror the loader exactly so the server can
 *  never anchor a "carrier" the loader would not inject. */
function isStrictFlowCarrier(rec: Record<string, unknown>): boolean {
  return (
    typeof rec["id"] === "string" &&
    (isPlainObject(rec["$referenced_components"]) ||
      typeof rec["start_node"] === "string" ||
      isPlainObject(rec["start_node"]) ||
      Array.isArray(rec["nodes"]))
  );
}

type DeclarationScan = {
  /** slotId → number of well-formed declaring occurrences across carriers. */
  countBySlot: Map<string, number>;
  /** slotIds that can NEVER anchor via declaration: they appear in a
   *  malformed carrier (or malformed entry), or twice within one carrier —
   *  fail-closed taint, per the Codex round-0 convergence. */
  tainted: Set<string>;
};

/** Collect contextSlots declarations from every carrier: the root document
 *  plus any nested Flow definition carrying metadata.cinatra.contextSlots
 *  DIRECTLY (declaration attribution never crosses into a nested def). */
function scanContextSlotDeclarations(oas: Record<string, unknown>): DeclarationScan {
  const countBySlot = new Map<string, number>();
  const tainted = new Set<string>();

  const consumeCarrier = (raw: unknown): void => {
    if (raw === null || raw === undefined) return;
    if (!Array.isArray(raw)) {
      // Present-but-malformed carrier: nothing trustworthy to extract, and
      // nothing to taint by name — string slot ids inside a non-array shape
      // are unreachable anyway. (An attacker cannot use this to UNBLOCK a
      // slot: absent counts never anchor.)
      return;
    }
    const seenHere = new Set<string>();
    const wellFormed = raw.every(isWellFormedSlotEntry);
    for (const entry of raw) {
      const slotId =
        typeof entry === "object" && entry !== null
          ? (entry as Record<string, unknown>)["slotId"]
          : null;
      if (typeof slotId !== "string" || !slotId) continue;
      if (!wellFormed) {
        tainted.add(slotId);
        continue;
      }
      if (seenHere.has(slotId)) {
        tainted.add(slotId);
        continue;
      }
      seenHere.add(slotId);
      countBySlot.set(slotId, (countBySlot.get(slotId) ?? 0) + 1);
    }
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const rec = node as Record<string, unknown>;
    // Only STRICT carriers declare (loader parity). A contextSlots blob on a
    // node the loader would not recognize is IGNORED, exactly as the loader
    // ignores it — it can never affect what executes. (A degenerate ROOT
    // that declares slots fails the loader's mount outright, so ignoring it
    // here is equally fail-closed: nothing can run to present a token.)
    if (isStrictFlowCarrier(rec)) {
      const cin = metadataCinatra(rec);
      if (cin && "contextSlots" in cin) consumeCarrier(cin["contextSlots"]);
    }
    for (const value of Object.values(rec)) walk(value);
  };

  walk(oas);
  return { countBySlot, tainted };
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
  /** How the nodeId was re-anchored: the legacy marked-owner STRUCTURE walk,
   *  or (cinatra#1194, run-token path only) the deterministic injection
   *  grammar + the installed contextSlots DECLARATION. */
  anchor: "marker" | "declaration";
};

/** Re-anchor an attested context-resolution `nodeId` to the run's compiled OAS.
 *
 *  LEGACY (always available): `{ slotId, kind, anchor: "marker" }` derived
 *  from the OAS STRUCTURE (the marked owner call-site). Fails closed when
 *  the node id is duplicated across enclosing definitions (id-collision), or
 *  not held by a definition that is the `$component_ref` target of exactly
 *  one context-resolution marker (unowned / ambiguous).
 *
 *  DECLARATION (cinatra#1194; only with `opts.allowDeclarationAnchor`, which
 *  the caller sets on the run-token-authenticated path): for a slim spec
 *  whose installed bytes carry NO subflow, the nodeId is re-anchored to the
 *  deterministic injection grammar + the installed `contextSlots`
 *  declaration instead. Fails closed unless ALL hold:
 *   - the nodeId appears nowhere in the installed bytes,
 *   - it parses under the grammar `ctx-<slotId>-<kind>`,
 *   - NONE of the ids the loader's injection of that slot would generate
 *     exist in the installed bytes (verifier/injector collision parity),
 *   - the slot is declared EXACTLY once across all carriers, in a
 *     well-formed declaration (malformed/duplicate carriers taint), and
 *   - NO marker (author-placed or loader-injected) exists for that slot —
 *     marker presence keeps the legacy path authoritative, mirroring the
 *     loader's own injection-skip rule.
 *
 *  The returned slotId/kind are the trust-root truth; the caller compares
 *  them against the request body (slotId) and the endpoint it serves (kind).
 *  The owner PACKAGE binding stays with findBoundChildPackageForSlot. */
export function resolveContextNodeProvenance(
  oas: Record<string, unknown>,
  nodeId: string,
  opts?: { allowDeclarationAnchor?: boolean },
): ContextNodeProvenance | null {
  if (!nodeId) return null;

  // enclosing-def id → slotId, from the owner markers.
  const slotByContextDef = new Map<string, Set<string>>();
  // nodeId → set of { defId, kind } occurrences (as a context ApiNode).
  const occurrencesByNodeId = new Map<
    string,
    Array<{ defId: string | null; kind: ContextNodeKind }>
  >();
  // Every slot named by ANY marker family (blocks the declaration anchor).
  const markerSlots = new Set<string>();
  // Every id / $referenced_components key in the installed bytes (the
  // injector's collision surface — see injectedComponentIds).
  const allIds = new Set<string>();

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
    if (typeof purpose === "string") {
      for (const prefix of [
        CONTEXT_RESOLUTION_PURPOSE_PREFIX,
        LOADER_INJECTED_PURPOSE_PREFIX,
      ]) {
        if (!purpose.startsWith(prefix)) continue;
        const slot = purpose.slice(prefix.length);
        if (slot) markerSlots.add(slot);
        if (prefix !== CONTEXT_RESOLUTION_PURPOSE_PREFIX) continue;
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
    }

    // Context-resolution ApiNode → record its id + enclosing def + kind.
    const id = rec["id"];
    if (typeof id === "string") allIds.add(id);
    const refsMap = rec["$referenced_components"];
    if (typeof refsMap === "object" && refsMap !== null) {
      for (const key of Object.keys(refsMap as Record<string, unknown>)) {
        allIds.add(key);
      }
    }
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
  if (occ && occ.length === 1) {
    // Legacy structural anchor: the node id exists in the installed bytes.
    const { defId, kind } = occ[0];
    if (!defId) return null;
    const slots = slotByContextDef.get(defId);
    // The enclosing def is not a single-slot marked context owner → fail closed.
    if (!slots || slots.size !== 1) return null;
    const slotId = [...slots][0];
    return { slotId, kind, anchor: "marker" };
  }
  if (occ && occ.length !== 1) return null; // duplicated in bytes → fail closed

  // cinatra#1194 — declaration anchor (run-token path only). The node id is
  // NOT in the installed bytes: for a slim spec that is exactly right (the
  // loader injected it at mount).
  if (!opts?.allowDeclarationAnchor) return null;
  const parsed = parseInjectedContextNodeId(nodeId);
  if (!parsed) return null;
  // Verifier/injector collision parity: the loader refuses to inject a slot
  // whose generated ids collide with existing ids; anchoring must refuse in
  // exactly the same situations.
  for (const generatedId of injectedComponentIds(parsed.slotId)) {
    if (allIds.has(generatedId)) return null;
  }
  if (markerSlots.has(parsed.slotId)) return null; // legacy authoritative
  const { countBySlot, tainted } = scanContextSlotDeclarations(oas);
  if (tainted.has(parsed.slotId)) return null;
  if (countBySlot.get(parsed.slotId) !== 1) return null;
  return { slotId: parsed.slotId, kind: parsed.kind, anchor: "declaration" };
}

// ---------------------------------------------------------------------------
// Pure decision — combines signature verification with the OAS provenance
// re-anchor. Kept dependency-light so the FULL fail-closed decision matrix is
// unit-testable without the auth/run/actor IO chain. context-route-io.ts reads
// the request headers + env and maps a failure to ContextRouteError(403).
// ---------------------------------------------------------------------------

export type ContextAttestationResult =
  | {
      ok: true;
      slotId: string;
      kind: ContextNodeKind;
      /** cinatra#1194 — which re-anchor served this node (observability for
       *  the slim-format rollout; ids only, logged by the IO caller). */
      anchor: "marker" | "declaration";
      legacyV1?: boolean;
    }
  | { ok: false; code: string; message: string };

/** Evaluate the #907/#1192 attestation for a composed-child context call. Every
 *  failure is a 403-worthy fail-closed reason (the caller maps `code`/`message`
 *  to ContextRouteError). `contextId` MUST be the trusted x-cinatra-a2a-context-id
 *  binding (never a body value); `nodeIdHeader`/`attestationHeader` are the raw
 *  request header values; `runOas` is the run package's installed OAS.
 *
 *  A v2 attestation additionally carries a signed expiry: it is rejected once
 *  expired (past `expiry + skew`) or if its expiry is implausibly far in the
 *  future — closing the intra-run replay window. A v1 attestation has no expiry
 *  and is accepted only transitionally (`acceptLegacyV1`, default true) for the
 *  non-atomic two-image rollout. */
export function evaluateContextAttestation(input: {
  key: string | undefined | null;
  contextId: string | null;
  nodeIdHeader: string | null;
  attestationHeader: string | null;
  runOas: Record<string, unknown> | null;
  slotId: string;
  expectedKind: ContextNodeKind;
  /** Accept a legacy v1 (no-expiry) attestation. Default true (MERGE-SAFE
   *  transitional). Set false (CINATRA_CONTEXT_ATTEST_ACCEPT_V1=0) to enforce
   *  v2-only after the wayflow minter image has rolled. */
  acceptLegacyV1?: boolean;
  /** cinatra#1194 — allow the declaration re-anchor for slim (declaration-
   *  only) specs. Default false; the IO caller enables it ONLY when the run
   *  was resolved via the run token (the acceptance boundary: the injecting
   *  image is the token-attaching image). The legacy marker anchor is always
   *  available regardless. */
  allowDeclarationAnchor?: boolean;
  /** Injectable clock (ms) for the v2 expiry check. Default Date.now(). */
  nowMs?: number;
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
  const parsed = parseContextAttestationHeader(attestationHeader);
  if (!nodeId || !parsed) {
    return {
      ok: false,
      code: "attestation_missing",
      message:
        "composed-child context resolution requires a valid per-node attestation",
    };
  }

  const acceptLegacyV1 = input.acceptLegacyV1 ?? true;
  const nowMs = input.nowMs ?? Date.now();
  let legacyV1 = false;

  if (parsed.version === "v1") {
    if (!acceptLegacyV1) {
      return {
        ok: false,
        code: "attestation_legacy_rejected",
        message:
          "legacy v1 context attestation rejected — v2 (expiring) attestation required",
      };
    }
    if (
      !verifyContextAttestationSignature({
        key,
        contextId,
        nodeId,
        providedSignatureHex: parsed.sigHex,
      })
    ) {
      return {
        ok: false,
        code: "attestation_invalid",
        message: "context attestation signature did not verify",
      };
    }
    legacyV1 = true;
  } else {
    // v2 — verify the signature (which binds the expiry) BEFORE trusting the
    // expiry value, then enforce the fail-closed validity window.
    if (
      !verifyContextAttestationSignatureV2({
        key,
        contextId,
        nodeId,
        expiryEpochSeconds: parsed.expiryEpochSeconds,
        providedSignatureHex: parsed.sigHex,
      })
    ) {
      return {
        ok: false,
        code: "attestation_invalid",
        message: "context attestation signature did not verify",
      };
    }
    const expiryMs = parsed.expiryEpochSeconds * 1000;
    if (nowMs > expiryMs + CONTEXT_ATTESTATION_SKEW_MS) {
      return {
        ok: false,
        code: "attestation_expired",
        message: "context attestation has expired",
      };
    }
    if (expiryMs > nowMs + CONTEXT_ATTESTATION_MAX_FUTURE_MS) {
      return {
        ok: false,
        code: "attestation_expired",
        message:
          "context attestation expiry is implausibly far in the future",
      };
    }
  }

  const prov = runOas
    ? resolveContextNodeProvenance(runOas, nodeId, {
        allowDeclarationAnchor: input.allowDeclarationAnchor === true,
      })
    : null;
  if (!prov) {
    return {
      ok: false,
      code: "attestation_node_unrecognized",
      message: `attested node '${nodeId}' is not a unique, marked or declared context-resolution node in the run OAS`,
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
  return legacyV1
    ? {
        ok: true,
        slotId: prov.slotId,
        kind: prov.kind,
        anchor: prov.anchor,
        legacyV1: true,
      }
    : { ok: true, slotId: prov.slotId, kind: prov.kind, anchor: prov.anchor };
}
