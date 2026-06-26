import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Dispatcher-signed agent-run binding.
//
// PROBLEM. The LLM bridge (`/api/llm-bridge`) needs to know which
// `agent_runs` row a WayFlow LLM step belongs to so it can mint a scoped
// MCP on-behalf-of (OBO) actor token for that run's `{runBy, orgId}`. The
// run id is threaded from the dispatcher into the WayFlow A2A initial
// message (`cinatra_run_id`) and then propagated through the OAS
// DataFlowEdge into the bridge request body as `agent_run_id`.
//
// That body field is FORGEABLE: a malicious or compromised OAS author can
// rewrite the DataFlowEdge so the bridge receives another tenant's run id,
// which previously caused the bridge to mint an MCP OBO token under the
// WRONG run/org identity (a confused-deputy authorization bypass). The
// downstream live membership check validates the SELECTED run's identity,
// not the caller's entitlement to select that run, so it does not stop the
// confused deputy on its own.
//
// SOLUTION. The dispatcher (which owns run identity and is OUTSIDE OAS
// control) mints a short-lived HMAC binding over the run's authoritative
// identity tuple and threads it alongside `cinatra_run_id`. The bridge
// REFUSES to select a run for OBO minting from a body id; it only accepts a
// run selected via a VERIFIED binding (or via the auth-injected
// `x-cinatra-a2a-context-id` lookup). A malicious OAS can drop or corrupt
// the binding (degrading the run to the anonymous machine-token path, never
// an elevation) but cannot forge a valid binding for a run it does not own,
// because the key (`BETTER_AUTH_SECRET`) never leaves the trusted Cinatra
// runtime.
//
// The binding is NOT a bearer credential for the MCP boundary — it only
// authorizes run SELECTION at the bridge. The OBO token minted afterwards
// still passes through `resolveAgentRunMcpActor`'s LIVE membership/admin
// check (defense in depth) and `enforceMcpBoundary`.
// ---------------------------------------------------------------------------

/** Current binding format version. Bump on any payload-shape change. */
export const AGENT_RUN_BINDING_VERSION = 1 as const;

/** The only purpose this binding authorizes: LLM-bridge run selection. */
export const AGENT_RUN_BINDING_PURPOSE = "llm-bridge-run-select" as const;

/**
 * Max age accepted at verification. The binding is minted at dispatch and
 * the first LLM step (the only step that uses this fallback, because the
 * context-id is not yet persisted) happens shortly after. A generous but
 * bounded window limits replay if a binding leaks.
 */
const BINDING_MAX_TTL_SECONDS = 60 * 60; // 1 hour

export type AgentRunBindingPayload = {
  /** The authoritative `agent_runs.id`. */
  runId: string;
  /** The run's `org_id` (resolver namespace). */
  orgId: string;
  /** The run owner (`agent_runs.run_by`). */
  runBy: string;
  /** Constant discriminator; see AGENT_RUN_BINDING_PURPOSE. */
  purpose: typeof AGENT_RUN_BINDING_PURPOSE;
  /** Format version; see AGENT_RUN_BINDING_VERSION. */
  version: number;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). */
  exp: number;
};

function getSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "Missing BETTER_AUTH_SECRET. Cannot issue/verify agent-run binding.",
    );
  }
  return secret;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(input: string): string {
  return createHmac("sha256", getSecret()).update(input).digest("base64url");
}

/**
 * Mint a dispatcher-signed run binding. Called by the worker at dispatch
 * time (run identity owner), NEVER by anything under OAS control.
 *
 * Returns a compact `payloadB64.sigB64` string suitable for threading as a
 * flow input / request field.
 */
export function issueAgentRunBinding(input: {
  runId: string;
  orgId: string;
  runBy: string;
  /** Optional override TTL (seconds); clamped to BINDING_MAX_TTL_SECONDS. */
  ttlSeconds?: number;
}): string {
  if (!input.runId || !input.orgId || !input.runBy) {
    throw new Error(
      "issueAgentRunBinding requires non-empty runId, orgId, and runBy.",
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.min(
    Math.max(1, input.ttlSeconds ?? BINDING_MAX_TTL_SECONDS),
    BINDING_MAX_TTL_SECONDS,
  );
  const payload: AgentRunBindingPayload = {
    runId: input.runId,
    orgId: input.orgId,
    runBy: input.runBy,
    purpose: AGENT_RUN_BINDING_PURPOSE,
    version: AGENT_RUN_BINDING_VERSION,
    iat: now,
    exp: now + ttl,
  };
  const payloadB64 = base64urlJson(payload);
  return `${payloadB64}.${sign(payloadB64)}`;
}

export type AgentRunBindingVerifyResult =
  | { ok: true; payload: AgentRunBindingPayload }
  | { ok: false; reason: string };

/**
 * Verify a dispatcher-signed run binding. Returns the decoded payload only
 * when EVERY check passes:
 *   - well-formed `payload.sig` structure
 *   - constant-time HMAC match (signature is authentic)
 *   - `purpose` and `version` match the expected constants
 *   - not expired and `iat`/`exp` are sane (exp within MAX_TTL of iat)
 *
 * This function performs NO database read — the caller MUST re-read the
 * `agent_runs` row and confirm it matches the verified `{runId, orgId,
 * runBy}` before using it for run selection / OBO minting.
 */
export function verifyAgentRunBinding(
  token: string | null | undefined,
): AgentRunBindingVerifyResult {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "missing" };
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  // Constant-time signature comparison. Re-sign the payload segment and
  // compare against the provided signature. Length mismatch short-circuits
  // (timingSafeEqual requires equal-length buffers).
  let expectedSig: string;
  try {
    expectedSig = sign(payloadB64);
  } catch {
    return { ok: false, reason: "secret_unavailable" };
  }
  const providedBuf = Buffer.from(providedSig);
  const expectedBuf = Buffer.from(expectedSig);
  if (providedBuf.length !== expectedBuf.length) {
    return { ok: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: AgentRunBindingPayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as AgentRunBindingPayload;
  } catch {
    return { ok: false, reason: "malformed_payload" };
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.runId !== "string" ||
    typeof payload.orgId !== "string" ||
    typeof payload.runBy !== "string" ||
    !payload.runId ||
    !payload.orgId ||
    !payload.runBy
  ) {
    return { ok: false, reason: "incomplete_payload" };
  }
  if (payload.purpose !== AGENT_RUN_BINDING_PURPOSE) {
    return { ok: false, reason: "wrong_purpose" };
  }
  if (payload.version !== AGENT_RUN_BINDING_VERSION) {
    return { ok: false, reason: "wrong_version" };
  }
  if (
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.iat) ||
    !Number.isFinite(payload.exp)
  ) {
    return { ok: false, reason: "bad_timestamps" };
  }
  const now = Math.floor(Date.now() / 1000);
  // Reject a binding whose window is wider than the policy max (defends
  // against an attacker minting a far-future exp even with a valid key, and
  // against clock-skew abuse).
  if (payload.exp - payload.iat > BINDING_MAX_TTL_SECONDS) {
    return { ok: false, reason: "ttl_too_long" };
  }
  if (payload.exp <= now) {
    return { ok: false, reason: "expired" };
  }
  // Small tolerance for clock skew on the not-yet-valid side.
  if (payload.iat > now + 300) {
    return { ok: false, reason: "not_yet_valid" };
  }
  return { ok: true, payload };
}
