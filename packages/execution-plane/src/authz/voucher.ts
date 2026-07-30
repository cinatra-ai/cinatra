/**
 * Per-command authorization voucher — VERIFY SIDE ONLY (exec-plane, epic #1705).
 *
 * The sealed session carrier answers "WHO is this" for a whole job. It cannot
 * answer "is THIS command, right now, still authorized" — it is minted once, is
 * valid for 15 minutes, and says nothing about the command text or the egress
 * tier that was resolved for it. The voucher is that missing per-command
 * authorization: the host mint site re-derives the run's OBO ceiling chain,
 * compares it (CONTAINMENT) against the persisted dispatch chain, resolves the
 * effective egress policy, and SIGNS the result together with the exact command
 * it authorizes. The broker verifies and enforces; it can do nothing else.
 *
 * STRUCTURALLY INCAPABLE OF MINTING — the load-bearing property of this module.
 * It imports `createPublicKey`, `verify`, `createHash` and `timingSafeEqual`
 * from node:crypto and NOTHING else: no `sign`, no `createPrivateKey`, no
 * `generateKeyPair*`. `ExecutionVoucherVerifier` refuses private key material at
 * construction (a PEM containing a PRIVATE KEY block, or a `KeyObject` whose
 * `type` is not `"public"`), so a broker deployment cannot be handed the signing
 * key by accident and then be talked into using it. A structural test asserts
 * the import surface, because a future edit is exactly how this property gets
 * lost. The SIGN side lives in the app layer
 * (`src/lib/execution/execution-voucher-mint.ts`) — the only holder of the
 * private key and the only party with the run store to derive a ceiling from.
 *
 * FORMAT (mirrors the sealed carrier's shape so operators read one grammar):
 *
 *     v1.<base64url(canonical JSON claims)>.<base64url(ed25519 signature)>
 *
 * The signature is DETACHED over `"cinatra-exec-voucher.v1." + <body>` — the
 * domain-separation prefix means a signature produced for some other cinatra
 * payload can never be replayed as a voucher, even under the same key. Verify
 * runs over the body bytes EXACTLY as received (never over a re-serialization),
 * so canonicalization can never open a signature-malleability gap: only the key
 * holder can produce a valid signature for any byte string, and the claims are
 * then strictly re-validated field by field.
 *
 * WHAT VERIFY ENFORCES (all of it fail-closed — every failure is a refusal, no
 * throw ever reaches the command path):
 *   - the Ed25519 signature under the broker's verify-only public key;
 *   - `aud` === this broker's OWN identity (its URI SAN in an mTLS placement),
 *     so a voucher minted for a different broker in the fleet is worthless here;
 *   - `commandSha256` === sha256 of the command actually being run, so a
 *     voucher cannot be lifted onto a different command;
 *   - `jobId` + `{orgId,userId,surface,runId}` === the OPEN job's own session,
 *     so a voucher cannot be lifted onto another tenant's job;
 *   - `iat`/`exp` against the clock with an explicit ±5s skew tolerance;
 *   - consume-once nonce (replay), in a cache bounded by `exp`.
 */

import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

// Type-only (fully erased at runtime): this leaf stays dependency-free so the
// app layer can import it through the `@cinatra-ai/execution-plane/voucher`
// subpath without pulling the docker/worker graph.
import type { EgressPolicy } from "../types";

export type { EgressPolicy };

/** Voucher grammar version. Bumped only on a breaking claims change. */
export const VOUCHER_VERSION = "v1";

/** Domain separation for the signing input — never sign a bare payload. */
export const VOUCHER_SIGNING_DOMAIN = "cinatra-exec-voucher.v1";

/**
 * Explicit clock-skew tolerance, both directions. A voucher is minted on the
 * app host and verified on the broker host; without a stated tolerance a
 * sub-second clock difference would randomly refuse legitimate commands, which
 * operators then "fix" by widening the TTL — the worse outcome.
 */
export const VOUCHER_CLOCK_SKEW_MS = 5_000;

/**
 * Default nonce-cache capacity. Sized far above any plausible in-flight command
 * population (the broker's own per-org concurrency + queue ceilings bound
 * throughput long before this). Saturation FAILS CLOSED — see `NonceCache`.
 */
export const DEFAULT_VOUCHER_NONCE_CAPACITY = 50_000;

/** The signed claim set. Exactly these fields; anything else is rejected. */
export type ExecutionVoucherClaims = {
  /** The broker this voucher is FOR (its URI-SAN identity). */
  aud: string;
  /** The open broker job the command runs on. */
  jobId: string;
  orgId: string;
  userId: string;
  /** The minting surface (`chat` | `agent_run` | `deterministic_task` | `skill_task`). */
  surface: string;
  /** Present exactly when the session is bound to a run. */
  runId?: string;
  /** Lowercase hex sha256 of the exact command string (utf8). */
  commandSha256: string;
  /**
   * Client-generated per-command id — the idempotency + remint key.
   *
   * NOT an authorization input, and deliberately not compared against a
   * caller-supplied expectation: the broker's `exec` takes no commandId of its
   * own, so this value IS the only one, and nothing is granted on the strength
   * of it. What bounds the voucher is `aud` + `jobId` + the session tuple +
   * `commandSha256` + the nonce; `commandId` only names the bookkeeping slot the
   * broker keys its idempotency and its one-shot remint cap on. Rotating it
   * cannot widen anything — it just asks for a separate authorization, which the
   * mint site re-derives the OBO ceiling for from scratch. (Codex round 1,
   * finding 1 — rebutted with this reasoning, recorded so a later reader does
   * not mistake it for an authorization field.)
   */
  commandId: string;
  /** The effective egress policy resolved AT MINT. The broker clamps it. */
  egressPolicy: EgressPolicy;
  /** Single-use anti-replay token. */
  nonce: string;
  /** Epoch ms issued-at. */
  iat: number;
  /** Epoch ms expiry. */
  exp: number;
};

// ---------------------------------------------------------------------------
// Canonical serialization — the ONE definition of the wire form
// ---------------------------------------------------------------------------

function canonicalEgressPolicy(policy: EgressPolicy): Record<string, unknown> {
  const out: Record<string, unknown> = { mode: policy.mode };
  // Normalized + SORTED: two mints that resolved the same host set must produce
  // the same bytes, so a diff in the signed body is always a real policy diff.
  const list = (policy.allowlist ?? [])
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
  const unique = [...new Set(list)].sort();
  if (unique.length > 0) out.allowlist = unique;
  if (
    typeof policy.maxBytesPerJob === "number" &&
    Number.isFinite(policy.maxBytesPerJob) &&
    policy.maxBytesPerJob > 0
  ) {
    // At least 1, never a floored-to-zero ceiling: `0` means "no ceiling"
    // downstream, so flooring 0.5 to 0 would sign an UNBOUNDED policy from a
    // bounded ask. Same normalization as the clamp's `normalizeByteCap`.
    out.maxBytesPerJob = Math.max(1, Math.floor(policy.maxBytesPerJob));
  }
  return out;
}

/**
 * The canonical claims JSON — field-ordered, so object key order in the caller
 * can never change the bytes that get signed. Exported (not private) because
 * the SIGN side must produce byte-identical output; duplicating this formatting
 * in the app layer is precisely how a signature format drifts.
 */
export function canonicalVoucherPayload(claims: ExecutionVoucherClaims): string {
  return JSON.stringify({
    aud: claims.aud,
    commandId: claims.commandId,
    commandSha256: claims.commandSha256,
    egressPolicy: canonicalEgressPolicy(claims.egressPolicy),
    exp: Math.floor(claims.exp),
    iat: Math.floor(claims.iat),
    jobId: claims.jobId,
    nonce: claims.nonce,
    orgId: claims.orgId,
    ...(claims.runId ? { runId: claims.runId } : {}),
    surface: claims.surface,
    userId: claims.userId,
    v: VOUCHER_VERSION,
  });
}

/** base64url of the canonical claims — the voucher's middle segment. */
export function encodeVoucherBody(claims: ExecutionVoucherClaims): string {
  return Buffer.from(canonicalVoucherPayload(claims), "utf8").toString("base64url");
}

/** The exact byte string a signature must cover (domain-separated). */
export function voucherSigningInput(body: string): string {
  return `${VOUCHER_SIGNING_DOMAIN}.${body}`;
}

/** Assemble the wire token from an encoded body + a base64url signature. */
export function assembleVoucher(body: string, signatureB64Url: string): string {
  return `${VOUCHER_VERSION}.${body}.${signatureB64Url}`;
}

/** Lowercase hex sha256 of a command string — the `commandSha256` binding. */
export function commandDigest(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type VoucherRejection =
  /** No voucher presented at all. */
  | "missing"
  /**
   * The caller supplied a non-finite `nowMs`. Refused rather than evaluated: an
   * arithmetic comparison against NaN is FALSE in both directions, which would
   * silently pass the expiry check, the not-yet-valid check AND the nonce
   * cache's liveness test — i.e. a broken clock would disable three guards at
   * once. Codex round 1, finding 2.
   */
  | "clock_unavailable"
  /**
   * The outstanding-challenge lookup failed. Fail-closed: without knowing
   * whether this broker has a challenge outstanding for the command, a
   * self-chosen nonce must not be accepted. Codex round 1, finding 5.
   */
  | "challenge_unavailable"
  /** Not a `v1.<body>.<sig>` triple, or the body is not the claim shape. */
  | "malformed"
  /** Signature does not verify under the broker's public key. */
  | "bad_signature"
  /** `aud` is not this broker. */
  | "wrong_audience"
  /** `commandSha256` is not the command being run. */
  | "command_mismatch"
  /** `jobId` is not the job the command was submitted on. */
  | "job_mismatch"
  /** The signed identity is not the open job's session identity. */
  | "session_mismatch"
  /** `exp` is in the past (beyond the skew tolerance). */
  | "expired"
  /** `iat` is in the future (beyond the skew tolerance). */
  | "not_yet_valid"
  /** The nonce was already consumed. */
  | "replayed"
  /** The nonce cache is saturated — fail closed, never skip replay detection. */
  | "nonce_capacity";

export type VoucherVerification =
  | { ok: true; claims: ExecutionVoucherClaims }
  | { ok: false; rejection: VoucherRejection; detail: string };

/** What the presented voucher is checked AGAINST — all broker-side facts. */
export type VoucherVerificationContext = {
  jobId: string;
  command: string;
  /** The OPEN job's session identity, from the verified sealed carrier. */
  session: { orgId: string; userId: string; surface: string; runId?: string };
  nowMs: number;
  /**
   * When the broker has issued a revalidation challenge for this `commandId`,
   * the remint MUST carry that exact nonce. Absent ⇒ no outstanding challenge.
   */
  requiredNonceForCommandId?: (commandId: string) => string | undefined;
};

/**
 * Consume-once nonce cache, bounded by voucher expiry.
 *
 * Entries are pruned by `exp` (they can never be needed past it — an expired
 * voucher is refused on the clock check anyway), so the cache's live size is
 * bounded by the number of vouchers minted inside one TTL window. The hard
 * capacity is a second, independent bound: reaching it REFUSES
 * (`nonce_capacity`) rather than evicting, because evicting a live nonce would
 * silently re-enable the replay this cache exists to stop. Availability loss
 * under an implausible flood is the correct trade at an authorization boundary.
 */
class NonceCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly capacity: number) {}

  consume(nonce: string, expMs: number, nowMs: number): "ok" | "replayed" | "capacity" {
    const known = this.seen.get(nonce);
    if (known !== undefined) {
      // A still-live entry is a replay. An entry past its own expiry is stale
      // bookkeeping — but the voucher carrying it is expired too, so the clock
      // check has already refused it before we get here on any real path.
      if (known > nowMs) return "replayed";
      this.seen.delete(nonce);
    }
    if (this.seen.size >= this.capacity) {
      this.prune(nowMs);
      if (this.seen.size >= this.capacity) return "capacity";
    }
    this.seen.set(nonce, expMs);
    return "ok";
  }

  private prune(nowMs: number): void {
    for (const [nonce, exp] of this.seen) {
      if (exp <= nowMs) this.seen.delete(nonce);
    }
  }

  /** Live entry count (observability + tests). */
  get size(): number {
    return this.seen.size;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function finiteInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseEgressPolicy(v: unknown): EgressPolicy | null {
  if (!isPlainObject(v)) return null;
  const mode = v.mode;
  if (mode !== "none" && mode !== "allowlist" && mode !== "default_internet") return null;
  const policy: EgressPolicy = { mode };
  if (v.allowlist !== undefined) {
    if (!Array.isArray(v.allowlist) || !v.allowlist.every((h) => nonEmptyString(h))) return null;
    policy.allowlist = v.allowlist as string[];
  }
  if (v.maxBytesPerJob !== undefined) {
    if (!finiteInt(v.maxBytesPerJob) || v.maxBytesPerJob < 0) return null;
    policy.maxBytesPerJob = v.maxBytesPerJob;
  }
  return policy;
}

/** Strict claim-shape validation of a signature-verified body. */
function parseClaims(json: unknown): ExecutionVoucherClaims | null {
  if (!isPlainObject(json)) return null;
  if (json.v !== VOUCHER_VERSION) return null;
  const required = ["aud", "jobId", "orgId", "userId", "surface", "commandSha256", "commandId", "nonce"] as const;
  for (const field of required) {
    if (!nonEmptyString(json[field])) return null;
  }
  if (!finiteInt(json.iat) || !finiteInt(json.exp)) return null;
  if (json.exp <= json.iat) return null;
  if (json.runId !== undefined && !nonEmptyString(json.runId)) return null;
  const egressPolicy = parseEgressPolicy(json.egressPolicy);
  if (!egressPolicy) return null;
  return {
    aud: json.aud as string,
    jobId: json.jobId as string,
    orgId: json.orgId as string,
    userId: json.userId as string,
    surface: json.surface as string,
    ...(json.runId ? { runId: json.runId as string } : {}),
    commandSha256: json.commandSha256 as string,
    commandId: json.commandId as string,
    egressPolicy,
    nonce: json.nonce as string,
    iat: json.iat as number,
    exp: json.exp as number,
  };
}

/** Length-safe constant-time string compare (differing lengths ⇒ false). */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class VoucherKeyMaterialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoucherKeyMaterialError";
  }
}

export type ExecutionVoucherVerifierOptions = {
  /**
   * VERIFY-ONLY Ed25519 public key: an SPKI PEM string or a `KeyObject` whose
   * `type` is `"public"`. Private key material is REFUSED — the broker must not
   * be in a position to sign.
   */
  publicKey: string | KeyObject;
  /**
   * This broker's own identity, which `aud` must equal exactly. In a managed
   * placement it is the URI SAN of the broker's own service certificate — the
   * same name the mTLS peer check terminates on — so "who is this voucher for"
   * and "who am I" are the same string from the same source of truth.
   */
  aud: string;
  /** Clock-skew tolerance both directions. Defaults to ±5s. */
  skewMs?: number;
  /** Nonce-cache hard capacity. */
  nonceCapacity?: number;
};

export class ExecutionVoucherVerifier {
  private readonly publicKey: KeyObject;
  private readonly nonces: NonceCache;
  readonly aud: string;
  readonly skewMs: number;

  constructor(opts: ExecutionVoucherVerifierOptions) {
    if (!nonEmptyString(opts.aud)) {
      throw new VoucherKeyMaterialError(
        "The execution broker has no identity (aud) configured; it cannot verify " +
          "per-command vouchers and must not run commands (fail-closed).",
      );
    }
    this.publicKey = ExecutionVoucherVerifier.toPublicKey(opts.publicKey);
    this.aud = opts.aud;
    // Both knobs are validated at ARM time, because a bad value here does not
    // degrade one check — it silently disables several (Codex round 1, findings
    // 2 + 3). A NaN skew makes `exp + skew <= now` AND `iat - skew > now` AND
    // the nonce cache's `known > now` test all evaluate FALSE, so an expired
    // voucher verifies and its nonce is re-consumable. A non-integer or
    // non-finite capacity makes `size >= capacity` never true, so the cache
    // neither prunes nor refuses and grows without bound. Refuse to arm.
    this.skewMs = ExecutionVoucherVerifier.requireBound(
      opts.skewMs ?? VOUCHER_CLOCK_SKEW_MS,
      "skewMs",
      { min: 0 },
    );
    this.nonces = new NonceCache(
      ExecutionVoucherVerifier.requireBound(
        opts.nonceCapacity ?? DEFAULT_VOUCHER_NONCE_CAPACITY,
        "nonceCapacity",
        { min: 1 },
      ),
    );
  }

  /** A finite, integral bound ≥ `min`. Anything else refuses to arm. */
  private static requireBound(
    value: number,
    field: "skewMs" | "nonceCapacity",
    opts: { min: number },
  ): number {
    if (!Number.isSafeInteger(value) || value < opts.min) {
      throw new VoucherKeyMaterialError(
        `The execution broker's voucher \`${field}\` must be an integer >= ${opts.min}, ` +
          `got ${String(value)}. A non-integral or out-of-range bound silently disables ` +
          "the clock and replay guards, so the broker refuses to arm (fail-closed).",
      );
    }
    return value;
  }

  /**
   * Narrow arbitrary key input to an Ed25519 PUBLIC key, refusing anything that
   * would give this process signing capability. `createPublicKey` happily
   * derives a public key FROM a private one, which would let a misconfigured
   * deployment hand the broker the signing key — so private material is
   * rejected explicitly, before that call.
   */
  private static toPublicKey(input: string | KeyObject): KeyObject {
    let key: KeyObject;
    if (typeof input === "string") {
      if (/PRIVATE KEY/.test(input)) {
        throw new VoucherKeyMaterialError(
          "The execution broker was configured with PRIVATE voucher key material. " +
            "The broker verifies only; supply the Ed25519 SPKI public key (fail-closed).",
        );
      }
      try {
        key = createPublicKey(input);
      } catch (err) {
        throw new VoucherKeyMaterialError(
          `Voucher verification key is unusable: ${(err as Error).message}`,
        );
      }
    } else {
      if (input.type !== "public") {
        // Note that `createPublicKey` would happily DERIVE the public half from a
        // private KeyObject — which is exactly how a misconfigured deployment
        // would end up handing the broker signing material. Refuse instead.
        throw new VoucherKeyMaterialError(
          `The execution broker was configured with a "${input.type}" key. The broker ` +
            "verifies only; supply an Ed25519 public key (fail-closed).",
        );
      }
      // An already-public KeyObject is used AS IS: node's `createPublicKey`
      // accepts a KeyObject only to derive from a PRIVATE one and throws on a
      // public one, so re-wrapping here would reject the very input this
      // verifier is meant to take.
      key = input;
    }
    if (key.asymmetricKeyType !== "ed25519") {
      throw new VoucherKeyMaterialError(
        `Voucher verification key must be Ed25519, got "${String(key.asymmetricKeyType)}" (fail-closed).`,
      );
    }
    return key;
  }

  /**
   * Full pre-dispatch verification. CONSUMES the nonce on success — call it
   * exactly once per presented voucher; the post-queue re-check is
   * `checkFreshness`, which deliberately does NOT re-consume (that would make
   * the broker replay-detect its own command).
   */
  verify(voucher: string | undefined | null, ctx: VoucherVerificationContext): VoucherVerification {
    if (!nonEmptyString(voucher)) {
      return {
        ok: false,
        rejection: "missing",
        detail: "no per-command authorization voucher was presented",
      };
    }
    // A usable clock is a PRECONDITION, not one check among several: every
    // comparison below against a non-finite `nowMs` is false in both directions,
    // which would pass expiry, not-yet-valid and the nonce cache's liveness test
    // at once (Codex round 1, finding 2).
    if (!Number.isFinite(ctx.nowMs)) {
      return {
        ok: false,
        rejection: "clock_unavailable",
        detail: "no usable clock was supplied for voucher verification",
      };
    }
    const parts = voucher.split(".");
    if (parts.length !== 3 || parts[0] !== VOUCHER_VERSION) {
      return { ok: false, rejection: "malformed", detail: "not a v1 voucher triple" };
    }
    const [, body, signature] = parts;
    if (body.length === 0 || signature.length === 0) {
      return { ok: false, rejection: "malformed", detail: "empty voucher segment" };
    }

    // 1. SIGNATURE FIRST, over the body bytes exactly as received. Nothing below
    //    this line trusts an unsigned byte.
    let signatureOk: boolean;
    try {
      signatureOk = verify(
        null,
        Buffer.from(voucherSigningInput(body), "utf8"),
        this.publicKey,
        Buffer.from(signature, "base64url"),
      );
    } catch {
      // A malformed signature segment must be a refusal, never a throw into the
      // command path.
      signatureOk = false;
    }
    if (!signatureOk) {
      return {
        ok: false,
        rejection: "bad_signature",
        detail: "voucher signature does not verify under this broker's verification key",
      };
    }

    // 2. Claim shape.
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return { ok: false, rejection: "malformed", detail: "voucher body is not JSON" };
    }
    const claims = parseClaims(decoded);
    if (!claims) {
      return { ok: false, rejection: "malformed", detail: "voucher claims are not the v1 shape" };
    }

    // 3. Audience — a voucher for another broker in the fleet is worthless here.
    if (!constantTimeEquals(claims.aud, this.aud)) {
      return {
        ok: false,
        rejection: "wrong_audience",
        detail: "voucher audience is not this broker",
      };
    }

    // 4. Job + session binding: a voucher cannot be lifted onto another job or
    //    another tenant's session, even under the same key.
    if (claims.jobId !== ctx.jobId) {
      return { ok: false, rejection: "job_mismatch", detail: "voucher is bound to a different job" };
    }
    if (
      claims.orgId !== ctx.session.orgId ||
      claims.userId !== ctx.session.userId ||
      claims.surface !== ctx.session.surface ||
      (claims.runId ?? null) !== (ctx.session.runId ?? null)
    ) {
      return {
        ok: false,
        rejection: "session_mismatch",
        detail: "voucher identity does not match the job's own execution session",
      };
    }

    // 5. Command binding.
    if (!constantTimeEquals(claims.commandSha256, commandDigest(ctx.command))) {
      return {
        ok: false,
        rejection: "command_mismatch",
        detail: "voucher does not authorize this command",
      };
    }

    // 6. Clock, with the explicit skew tolerance in both directions.
    const fresh = this.checkFreshness(claims, ctx.nowMs);
    if (!fresh.ok) return fresh;
    if (claims.iat - this.skewMs > ctx.nowMs) {
      return {
        ok: false,
        rejection: "not_yet_valid",
        detail: "voucher is issued in the future beyond the skew tolerance",
      };
    }

    // 7. An outstanding revalidation challenge pins the nonce: the remint must
    //    answer THIS broker's challenge, not merely present some fresh voucher.
    //    A lookup that FAILS is fail-closed — not knowing whether a challenge is
    //    outstanding must never resolve to "accept a self-chosen nonce" (Codex
    //    round 1, finding 5).
    let required: string | undefined;
    try {
      required = ctx.requiredNonceForCommandId?.(claims.commandId);
    } catch {
      return {
        ok: false,
        rejection: "challenge_unavailable",
        detail:
          "the broker could not determine whether a revalidation challenge is " +
          "outstanding for this command; the voucher is refused (fail-closed)",
      };
    }
    if (required !== undefined && required !== claims.nonce) {
      return {
        ok: false,
        rejection: "replayed",
        detail: "voucher does not carry the outstanding revalidation nonce for this command",
      };
    }

    // 8. Consume-once.
    const consumed = this.nonces.consume(claims.nonce, claims.exp + this.skewMs, ctx.nowMs);
    if (consumed === "replayed") {
      return { ok: false, rejection: "replayed", detail: "voucher nonce was already consumed" };
    }
    if (consumed === "capacity") {
      return {
        ok: false,
        rejection: "nonce_capacity",
        detail:
          "the broker's replay-detection cache is saturated; the command is refused " +
          "rather than dispatched without replay protection (fail-closed)",
      };
    }
    return { ok: true, claims };
  }

  /**
   * Expiry-only re-check, for the POST-QUEUE freshness gate. Separate from
   * `verify` on purpose: after an unbounded queue wait the authorization must
   * still be live, but the nonce has legitimately already been consumed by this
   * same command's pre-dispatch verification.
   */
  checkFreshness(
    claims: ExecutionVoucherClaims,
    nowMs: number,
  ): { ok: true } | { ok: false; rejection: "expired"; detail: string } {
    if (claims.exp + this.skewMs <= nowMs) {
      return {
        ok: false,
        rejection: "expired",
        detail: "voucher expired",
      };
    }
    return { ok: true };
  }

  /** Live nonce-cache size (observability + tests). */
  get trackedNonces(): number {
    return this.nonces.size;
  }
}
