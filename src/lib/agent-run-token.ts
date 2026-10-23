import "server-only";
import { validateProducerStepBinding, type VerifiedProducerStepBinding } from "@cinatra-ai/mcp-server/request-context";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Run-token spine — the dispatch-minted per-run credential (#1193).
//
// PROBLEM. Run identity currently reaches the app through several parallel,
// re-derived channels — a `cinatra_run_id` flow input (forgeable via a
// DataFlowEdge), an A2A context-id header, a dispatcher-signed binding, and an
// in-process registry. Each surface answers "which run is calling?" its own
// way. The run-identity-spine epic (#1192) collapses them onto ONE credential.
//
// SOLUTION (this module, the identity carrier + verifier). At dispatch the
// worker mints a random 256-bit per-run token and persists ONLY its sha256
// hash in the unique-indexed `agent_runs.run_token_hash` column, BEFORE the
// blocking sendTask (the same race-free ordering the context-id pre-bind
// uses). The raw token rides the WayFlow initial message under a reserved key
// and — in a later wave — is attached to first-party callbacks host-anchored
// to the configured base URL. A single server verifier hashes a presented
// token and looks the run up by the unique index:
//   - absent token          ⇒ { ok: false, reason: "absent" }      (caller ⇒ 403)
//   - present-but-no-match   ⇒ { ok: false, reason: "unresolvable" }(caller ⇒ 403)
//   - unique-index hit       ⇒ { ok: true, run }
// There is NO body-id fallback and NO newest-wins tie-break: the lookup is a
// single unique-index probe, so it resolves at most one run or none.
//
// Only the HASH is ever stored, so a database read cannot recover a live
// token. The token is a bearer credential whose authority is the run it
// resolves to; body-supplied ids can never promote a run into OBO/actor
// minting because that path consults this verifier, not a raw body id.
// ---------------------------------------------------------------------------

/**
 * The reserved key under which the dispatcher embeds the RAW per-run token in
 * the WayFlow A2A initial message payload (spread-then-overwrite, so agent
 * inputs can never smuggle it). The double-underscore sentinel guarantees no
 * agent's Flow input schema declares it: until the loader is taught to POP it
 * before schema-filtering (a later wave), `agent_loader.py`'s
 * `_filter_inputs_to_flow_schema` already DROPS every undeclared key before
 * `start_conversation`, so the token never reaches WayFlow. Any Python
 * consumer MUST use this exact literal.
 */
export const CINATRA_RUN_TOKEN_MESSAGE_KEY = "__cinatra_run_token__";

/**
 * The HTTP header under which the WayFlow container loader attaches the RAW
 * per-run token on host-anchored first-party callbacks (#1193 W2). Lower-case
 * because `Request.headers.get` is case-insensitive and the loader emits
 * `X-Cinatra-Run-Token`; any TS consumer reads it via this constant. Kept
 * DISTINCT from the shared bridge token and the A2A context-id header so the
 * one credential carries run identity end-to-end.
 */
export const RUN_TOKEN_HEADER = "x-cinatra-run-token";

/** Random credential size — 256 bits of entropy. */
export const RUN_TOKEN_BYTES = 32;

export type MintedRunToken = {
  /** The raw bearer token. Carried to the container; NEVER persisted or logged. */
  token: string;
  /** sha256-hex of `token`. The ONLY value persisted (`agent_runs.run_token_hash`). */
  tokenHash: string;
};

/**
 * sha256-hex of a raw run token — the value stored in
 * `agent_runs.run_token_hash` and the key the verifier looks a run up by.
 */
export function hashRunToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Mint a fresh random per-run credential and its hash. Called by the worker at
 * dispatch time (the run-identity owner), NEVER by anything under OAS control.
 */
export function mintRunToken(): MintedRunToken {
  const token = randomBytes(RUN_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashRunToken(token) };
}

/** The run identity a verified token resolves to (never carries the hash). */
export type RunTokenResolution = {
  id: string;
  orgId: string;
  runBy: string | null;
};

export type VerifyRunTokenResult =
  | { ok: true; run: RunTokenResolution }
  | { ok: false; reason: "absent" | "unresolvable" };

/**
 * THE run-token verifier. Hashes a presented token and resolves the run via
 * the injected unique-index lookup (`readAgentRunByTokenHash` in production;
 * a fake in hermetic tests). Fail-closed and side-effect-free: it performs no
 * body-id fallback and does not log — the calling route logs the 403 with the
 * returned `reason` and the run/context ids (never the token or the hash).
 *
 * A constant-time compare is unnecessary: resolution is a database unique-index
 * probe on sha256(token), not a byte comparison of a secret, and forging a hit
 * requires guessing a 256-bit token.
 */
export async function verifyRunToken(
  rawToken: string | null | undefined,
  lookupByHash: (hash: string) => Promise<RunTokenResolution | null>,
): Promise<VerifyRunTokenResult> {
  if (typeof rawToken !== "string" || rawToken.length === 0) {
    return { ok: false, reason: "absent" };
  }
  const run = await lookupByHash(hashRunToken(rawToken));
  if (!run) {
    return { ok: false, reason: "unresolvable" };
  }
  return { ok: true, run };
}

// ---------------------------------------------------------------------------
// Step identity of a run's calls (cinatra#3745).
//
// The flow runtime (docker/wayflow/agent_loader.py) signs the id of the
// EXECUTING compiled step on each call a run's step makes to the model bridge
// or to the deterministic passthrough road, with its dedicated key
// (CINATRA_CONTEXT_ATTEST_KEY) over the run's context id:
//
//   X-Cinatra-Step-Node:        <nodeId>
//   X-Cinatra-Step-Attestation: s1:<expiryEpochSeconds>:<hex>
//   hex = HMAC-SHA256(key, "s1\n<contextId>\n<nodeId>\n<expiryEpochSeconds>")
//
// When a run pauses for a review the runtime records the pausing step as a
// claim `{ node, attestation: "g1:<hex>" }` over
// "g1\n<contextId>\n<taskId>\n<nodeId>" on the pause's last message.
//
// The version prefixes (`s1`, `g1`) are distinct from the context-resolution
// pair's (`v1`, `v2`), so material signed for one purpose never verifies for
// another. The model never holds, sees or chooses the step: only these two
// verifiers turn a signed value into a step id, and each answers the verified
// node id or null. A null is "no step"; the caller serves the call as it does
// without a step.
// ---------------------------------------------------------------------------

/** The runtime's step-node header (lower-case; `Headers.get` is case-insensitive). */
export const RUN_STEP_NODE_HEADER = "x-cinatra-step-node";

/** The runtime's step-attestation header (`s1:<expiry>:<hex>`). */
export const RUN_STEP_ATTESTATION_HEADER = "x-cinatra-step-attestation";

/** Grace for verifier/runtime clock skew: an expiry up to this far in the
 *  past is still accepted (the context verifier's window). */
const RUN_STEP_ATTESTATION_SKEW_MS = 60_000;

/** An expiry further ahead than this is not accepted (the context verifier's
 *  window; the runtime's time to live is 300 seconds). */
const RUN_STEP_ATTESTATION_MAX_FUTURE_MS = 600_000;

const RUN_STEP_ATTESTATION_PATTERN = /^s1:([0-9]+):([0-9a-fA-F]+)$/;
const GATE_NODE_CLAIM_PATTERN = /^g1:([0-9a-fA-F]+)$/;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hmacHex(key: string, material: string): string {
  return createHmac("sha256", key).update(material).digest("hex");
}

/** Constant-time compare of two hex strings (length mismatch answers false). */
function hexEquals(providedHex: string, expectedHex: string): boolean {
  const provided = Buffer.from(providedHex.toLowerCase(), "utf8");
  const expected = Buffer.from(expectedHex, "utf8");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Verify the runtime's step pair for one call. Answers the verified node id,
 * or null when the key, the context id, the node or the attestation is
 * missing, the attestation is not an `s1` value, the signature does not
 * verify over (contextId, node, expiry), or the expiry lies more than 60
 * seconds in the past or more than 600 seconds ahead.
 */
export function verifyRunStepAttestation(input: {
  key: string | null | undefined;
  contextId: string | null | undefined;
  node: string | null | undefined;
  attestation: string | null | undefined;
  /** Injectable clock (ms); defaults to Date.now(). */
  nowMs?: number;
}): string | null {
  const { key, contextId, node, attestation } = input;
  if (
    !nonEmptyString(key) ||
    !nonEmptyString(contextId) ||
    !nonEmptyString(node) ||
    !nonEmptyString(attestation)
  ) {
    return null;
  }
  const match = RUN_STEP_ATTESTATION_PATTERN.exec(attestation);
  if (!match) return null;
  const expiryEpochSeconds = Number(match[1]);
  if (!Number.isSafeInteger(expiryEpochSeconds)) return null;
  const expected = hmacHex(key, `s1\n${contextId}\n${node}\n${expiryEpochSeconds}`);
  if (!hexEquals(match[2]!, expected)) return null;
  const nowMs = input.nowMs ?? Date.now();
  const expiryMs = expiryEpochSeconds * 1000;
  if (nowMs > expiryMs + RUN_STEP_ATTESTATION_SKEW_MS) return null;
  if (expiryMs > nowMs + RUN_STEP_ATTESTATION_MAX_FUTURE_MS) return null;
  return node;
}

/** Production inputs are captured by the mounted host, never the request body.
 * s2 is the producer-binding claim version 2; s1 step identities are unchanged.
 * JSON bytes are signed before parsing, avoiding cross-language number encoding
 * differences. The parsed inputs additionally get the existing replay digest. */
export const RUN_PRODUCER_BINDING_HEADER = "x-cinatra-producer-binding";
export const RUN_PRODUCER_ATTESTATION_HEADER = "x-cinatra-producer-attestation";
export type VerifiedRunProducerBinding = VerifiedProducerStepBinding;
const PRODUCER_SHA = /^[a-f0-9]{64}$/;
const PRODUCER_PATH = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PRODUCER_UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function producerCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(producerCanonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${producerCanonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("producer inputs must be finite JSON");
}

/** Authenticate the NEW production claim with the SAME key/algorithm/window.
 * Missing/invalid v2 never falls back to a v1 step identity or body inputs.
 * expectedGraphSha256 is the recorded graph pin when verifying a replay. */
export function verifyRunProducerBinding(input: {
  key: string | null | undefined;
  contextId: string | null | undefined;
  node: string | null | undefined;
  binding: string | null | undefined;
  attestation: string | null | undefined;
  expectedGraphSha256?: string;
  nowMs?: number;
}): VerifiedRunProducerBinding | null {
  const { key, contextId, node, binding, attestation } = input;
  if (![key, contextId, node, binding, attestation].every(nonEmptyString)) return null;
  if (binding!.length > 65536 || !/^[A-Za-z0-9_-]+$/.test(binding!)) return null;
  const match = /^s2:([0-9]+):([0-9a-fA-F]{64})$/.exec(attestation!);
  if (!match) return null;
  const expiry = Number(match[1]);
  if (!Number.isSafeInteger(expiry)) return null;
  const nowMs = input.nowMs ?? Date.now();
  if (nowMs > expiry * 1000 + RUN_STEP_ATTESTATION_SKEW_MS || expiry * 1000 > nowMs + RUN_STEP_ATTESTATION_MAX_FUTURE_MS) return null;
  try {
    const bytes = Buffer.from(binding!, "base64url");
    if (bytes.toString("base64url") !== binding) return null;
    const claim = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (!claim || Array.isArray(claim) || claim.version !== 2 || claim.producerStepId !== node) return null;
    if (typeof claim.sourceSha256 !== "string" || !PRODUCER_SHA.test(claim.sourceSha256)
      || typeof claim.graphSha256 !== "string" || !PRODUCER_SHA.test(claim.graphSha256)
      || typeof claim.effectiveInputsSha256 !== "string" || !PRODUCER_SHA.test(claim.effectiveInputsSha256)
      || typeof claim.effectiveInputsJson !== "string"
      || typeof claim.noteInputPath !== "string" || !PRODUCER_PATH.test(claim.noteInputPath)
      || PRODUCER_UNSAFE_KEYS.has(claim.noteInputPath)) return null;
    if (input.expectedGraphSha256 !== undefined && input.expectedGraphSha256 !== claim.graphSha256) return null;
    const rawDigest = createHash("sha256").update(claim.effectiveInputsJson, "utf8").digest("hex");
    if (rawDigest !== claim.effectiveInputsSha256) return null;
    const material = `s2\n${contextId}\n${node}\n${expiry}\n${claim.sourceSha256}\n${claim.graphSha256}\n${claim.noteInputPath}\n${rawDigest}`;
    if (!hexEquals(match[2]!, hmacHex(key!, material))) return null;
    const inputs = JSON.parse(claim.effectiveInputsJson) as Record<string, unknown>;
    if (!inputs || Array.isArray(inputs) || typeof inputs !== "object") return null;
    // WayFlow external Step inputs use declared top-level keys, not paths.
    if (!Object.hasOwn(inputs, claim.noteInputPath) || typeof inputs[claim.noteInputPath] !== "string") return null;
    const inputParamsSha256 = createHash("sha256").update(producerCanonicalJson(inputs), "utf8").digest("hex");
    return validateProducerStepBinding({ version: 2, producerKind: "llm", producerStepId: node!, noteInputPath: claim.noteInputPath,
      sourceSha256: claim.sourceSha256, graphSha256: claim.graphSha256, inputParams: inputs,
      inputParamsSha256, effectiveInputsSha256: rawDigest, effectiveInputsJson: claim.effectiveInputsJson }, node!);
  } catch { return null; }
}

/**
 * Verify a recorded pause claim `{ node, attestation: "g1:<hex>" }` for the
 * gate task it was recorded for. Answers the verified node id, or null for a
 * missing key, context id or task id, a claim of any other shape, or a
 * signature that does not verify over (contextId, taskId, node).
 */
export function verifyGateNodeClaim(input: {
  key: string | null | undefined;
  contextId: string | null | undefined;
  taskId: string | null | undefined;
  claim: unknown;
}): string | null {
  const { key, contextId, taskId, claim } = input;
  if (!nonEmptyString(key) || !nonEmptyString(contextId) || !nonEmptyString(taskId)) {
    return null;
  }
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return null;
  const { node, attestation } = claim as { node?: unknown; attestation?: unknown };
  if (!nonEmptyString(node) || !nonEmptyString(attestation)) return null;
  const match = GATE_NODE_CLAIM_PATTERN.exec(attestation);
  if (!match) return null;
  const expected = hmacHex(key, `g1\n${contextId}\n${taskId}\n${node}`);
  return hexEquals(match[1]!, expected) ? node : null;
}
