/**
 * Execution-plane session minting + sealing (exec-plane S1, cinatra#1706).
 *
 * The execution session is the trust root of the plane: it binds a sandbox
 * command to an attributable `{orgId,userId,surface,runId?}` identity. Only the
 * trusted surface-layer issuers mint one (assistant runtime for chat; agent
 * execution / llm-bridge AFTER run-token verification for agent runs;
 * deterministic-task callers for structured tasks). The minted session is
 * SEALED into an opaque, broker-verifiable carrier (`sealExecutionSession`)
 * that the injection layer embeds in the `sandbox_execution` tool and STRIPS
 * before any provider-adapter call — the broker is the only party that opens it
 * (`openSealedSession`).
 *
 * Security posture (the point of the plane, epic D4/D5):
 *  - Fail-closed on unidentifiable callers: `mintExecutionSession` REJECTS a
 *    session with no attributable identity (empty orgId/userId) — no identity ⇒
 *    no capability.
 *  - The carrier is integrity-protected (HMAC-SHA256) and expiring, so a
 *    tampered or stale carrier fails verification at the broker.
 *  - No secret / host data ever rides in the session; it is pure identity +
 *    surface + optional run binding.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { SealedExecutionSessionCarrier } from "../types";

/**
 * Surface that minted the session. Mirrors the four orchestration entry-point
 * shapes plus the chat assistant runtime:
 *  - `"chat"`               — assistant/chat surface (`stream` / `generate`).
 *  - `"agent_run"`          — an agent run (bound to a #1192 run token).
 *  - `"deterministic_task"` — `runDeterministicLlmTask`.
 *  - `"skill_task"`         — `runSkillAwareDeterministicLlmTask`.
 */
export type ExecutionSurface =
  | "chat"
  | "agent_run"
  | "deterministic_task"
  | "skill_task";

export const EXECUTION_SURFACES: readonly ExecutionSurface[] = [
  "chat",
  "agent_run",
  "deterministic_task",
  "skill_task",
] as const;

/**
 * A minted, in-memory execution session. NEVER crosses a provider-adapter
 * boundary in this shape — it is sealed first. `runId` is present exactly when
 * the surface is an agent run bound to the #1192 run token (do not invent a
 * parallel run binding — the caller supplies the verified runId).
 */
export type ExecutionSession = {
  orgId: string;
  userId: string;
  surface: ExecutionSurface;
  runId?: string;
};

/** Input to the trusted issuer. Same shape; validated on mint. */
export type MintExecutionSessionInput = {
  orgId: string;
  userId: string;
  surface: ExecutionSurface;
  runId?: string;
};

/**
 * Raised when a caller attempts to mint a session with no attributable
 * identity. The orchestration layer catches this and surfaces a structured
 * `no_session` capability error (the model stays usable) — it never crashes the
 * LLM call. Fail-closed by construction: an unidentifiable caller gets no
 * session, hence no capability.
 */
export class UnidentifiableExecutionCallerError extends Error {
  readonly field: "orgId" | "userId" | "surface";
  constructor(field: "orgId" | "userId" | "surface") {
    super(
      `Cannot mint an execution session without an attributable ${field}; ` +
        `unidentifiable callers are denied the execution capability (fail-closed).`,
    );
    this.name = "UnidentifiableExecutionCallerError";
    this.field = field;
  }
}

function isNonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Validate + normalize an execution session down to EXACTLY the four known
 * fields, or throw `UnidentifiableExecutionCallerError`. This is the single
 * fail-closed choke point every path funnels through — `mintExecutionSession`
 * (raw issuer input) AND `sealExecutionSession` (a pre-minted session object
 * that reached the injection layer). Whitelisting to `{orgId,userId,surface,
 * runId?}` is load-bearing security, not tidiness: a caller that hands in a
 * session via a cast / plain JS could otherwise smuggle host data or secret
 * fields — spreading the object would seal them into the carrier. Normalizing
 * here guarantees the carrier holds only attributable identity (epic D5) and
 * that an empty identity is rejected no matter which path minted it.
 */
export function normalizeExecutionSession(
  input: MintExecutionSessionInput | ExecutionSession,
): ExecutionSession {
  if (!isNonEmpty(input.orgId)) {
    throw new UnidentifiableExecutionCallerError("orgId");
  }
  if (!isNonEmpty(input.userId)) {
    throw new UnidentifiableExecutionCallerError("userId");
  }
  if (!EXECUTION_SURFACES.includes(input.surface)) {
    throw new UnidentifiableExecutionCallerError("surface");
  }
  const session: ExecutionSession = {
    orgId: input.orgId.trim(),
    userId: input.userId.trim(),
    surface: input.surface,
  };
  // runId is optional; include it only when the caller supplies a non-empty one
  // (agent runs bound to a #1192 run token). An empty string is NOT a run
  // binding — drop it rather than persist a meaningless "".
  if (isNonEmpty(input.runId)) {
    session.runId = input.runId.trim();
  }
  return session;
}

/**
 * Trusted surface-layer issuer. Thin wrapper over `normalizeExecutionSession`:
 * validates that the caller is attributable and returns a normalized session.
 * Throws `UnidentifiableExecutionCallerError` on a missing org / user / surface
 * — the ONLY correct outcome for an unidentifiable caller (D4 technical
 * carve-out: no attributable identity ⇒ no capability). Does NOT seal — sealing
 * is a separate, explicit step so the in-memory session can be inspected
 * (audit, policy) before it becomes opaque.
 */
export function mintExecutionSession(
  input: MintExecutionSessionInput,
): ExecutionSession {
  return normalizeExecutionSession(input);
}

// ---------------------------------------------------------------------------
// Sealing — opaque, broker-verifiable carrier
// ---------------------------------------------------------------------------

/**
 * Default carrier lifetime. A sealed carrier is short-lived: it only has to
 * survive from injection to the broker's first command dispatch. The broker
 * revalidates run/session liveness per command regardless (S1 broker slice), so
 * this is a coarse anti-replay bound, not the authorization itself.
 */
export const DEFAULT_CARRIER_TTL_MS = 15 * 60 * 1000;

const CARRIER_VERSION = "v1";

/**
 * Server misconfiguration signal: the broker signing secret is absent. The
 * orchestration layer maps this to a `capability_unavailable` capability error
 * (distinct from `no_session`) — a plane that cannot seal is unavailable, not a
 * caller-identity failure. Fail-closed: with no secret we NEVER emit an
 * unsigned carrier.
 */
export class ExecutionBrokerSecretMissingError extends Error {
  constructor() {
    super(
      "EXECUTION_BROKER_SECRET is not configured; the execution plane cannot " +
        "seal a session carrier and is therefore unavailable (fail-closed).",
    );
    this.name = "ExecutionBrokerSecretMissingError";
  }
}

function resolveBrokerSecret(explicit?: string): string {
  const secret = explicit ?? process.env.EXECUTION_BROKER_SECRET;
  if (!isNonEmpty(secret)) {
    throw new ExecutionBrokerSecretMissingError();
  }
  return secret;
}

type CarrierPayload = ExecutionSession & {
  /** Epoch ms the carrier was sealed. */
  iat: number;
  /** Epoch ms the carrier expires. */
  exp: number;
};

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/**
 * Seal a minted session into an opaque, broker-verifiable carrier. Format:
 * `v1.<base64url(payload)>.<base64url(hmac)>`. The payload is
 * integrity-protected but NOT encrypted — it carries no secret, only identity,
 * so a confidentiality guarantee is unnecessary; integrity + expiry are what
 * matter (a caller must not be able to forge or replay another org's session).
 *
 * `nowMs` / `ttlMs` / `secret` are injectable for hermetic tests; production
 * reads the secret from `EXECUTION_BROKER_SECRET` and uses wall-clock time.
 *
 * The session is re-normalized here (not spread): sealing whitelists exactly
 * `{orgId,userId,surface,runId?}` and re-runs identity validation, so a
 * pre-minted session that reached this path via a cast / plain JS can neither
 * smuggle extra host/secret fields into the carrier nor seal an empty identity
 * (fail-closed, epic D5). `EXECUTION_BROKER_SECRET` missing ⇒
 * `ExecutionBrokerSecretMissingError`; an unidentifiable session ⇒
 * `UnidentifiableExecutionCallerError` — both surfaced as distinct capability
 * errors by the injection layer.
 */
export function sealExecutionSession(
  session: ExecutionSession,
  opts?: { secret?: string; nowMs?: number; ttlMs?: number },
): SealedExecutionSessionCarrier {
  const secret = resolveBrokerSecret(opts?.secret);
  // Whitelist + validate — NEVER spread the caller's object into the carrier.
  const clean = normalizeExecutionSession(session);
  const iat = opts?.nowMs ?? Date.now();
  const exp = iat + (opts?.ttlMs ?? DEFAULT_CARRIER_TTL_MS);
  const payload: CarrierPayload = {
    orgId: clean.orgId,
    userId: clean.userId,
    surface: clean.surface,
    ...(clean.runId ? { runId: clean.runId } : {}),
    iat,
    exp,
  };
  const body = b64url(JSON.stringify(payload));
  const mac = sign(secret, `${CARRIER_VERSION}.${body}`);
  return `${CARRIER_VERSION}.${body}.${mac}`;
}

/** Discriminated result of opening a sealed carrier at the broker boundary. */
export type OpenSealedSessionResult =
  | { ok: true; session: ExecutionSession }
  | {
      ok: false;
      reason: "malformed" | "bad_signature" | "expired" | "no_secret";
    };

/**
 * Broker-side verification: open a sealed carrier back into a session. This is
 * the counterpart the S1 broker slice calls before it will dispatch a command.
 * Returns a discriminated failure (never throws for a bad carrier) so the
 * broker can fail the command closed with a precise reason. Constant-time MAC
 * comparison; expiry enforced against `nowMs` (injectable for tests).
 */
export function openSealedSession(
  carrier: SealedExecutionSessionCarrier,
  opts?: { secret?: string; nowMs?: number },
): OpenSealedSessionResult {
  let secret: string;
  try {
    secret = resolveBrokerSecret(opts?.secret);
  } catch {
    return { ok: false, reason: "no_secret" };
  }
  if (typeof carrier !== "string") return { ok: false, reason: "malformed" };
  const parts = carrier.split(".");
  if (parts.length !== 3 || parts[0] !== CARRIER_VERSION) {
    return { ok: false, reason: "malformed" };
  }
  const [, body, mac] = parts;
  const expected = sign(secret, `${CARRIER_VERSION}.${body}`);
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (
    macBuf.length !== expBuf.length ||
    !timingSafeEqual(macBuf, expBuf)
  ) {
    return { ok: false, reason: "bad_signature" };
  }
  let payload: CarrierPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const now = opts?.nowMs ?? Date.now();
  if (typeof payload.exp !== "number" || now >= payload.exp) {
    return { ok: false, reason: "expired" };
  }
  // Re-run identity validation on the opened payload — a carrier is only valid
  // if it still names an attributable caller (defense in depth against a
  // secret-holder minting an identity-less carrier out of band).
  if (
    !isNonEmpty(payload.orgId) ||
    !isNonEmpty(payload.userId) ||
    !EXECUTION_SURFACES.includes(payload.surface)
  ) {
    return { ok: false, reason: "malformed" };
  }
  const session: ExecutionSession = {
    orgId: payload.orgId,
    userId: payload.userId,
    surface: payload.surface,
  };
  if (isNonEmpty(payload.runId)) session.runId = payload.runId;
  return { ok: true, session };
}
