import "server-only";

// Per-command authorization voucher — SIGN SIDE (exec-plane, epic #1705).
//
// This is the mint site: the ONE place that decides a specific command, on a
// specific job, is authorized right now — and the only place that holds the
// Ed25519 private key. The broker holds the public half and can therefore
// enforce this decision without being able to make it
// (`packages/execution-plane/src/authz/voucher.ts`).
//
// WHAT EVERY MINT DOES, per command, in this order:
//
//   1. AUTHENTICATE the sealed session carrier itself (`openSealedSession`).
//      The mint trusts no caller-supplied identity — it re-opens the carrier
//      the job was opened with and reads the identity out of it.
//   2. PROBE LIVENESS, with exactly the recorded posture the broker's own
//      per-command probe uses: an ABSENT run row is `gone` (hard removal ⇒
//      deny), while a store READ ERROR keeps the recorded `alive` posture —
//      killing every in-flight sandbox on a transient read blip is a worse
//      failure than one extra command inside an unexpired carrier window.
//      These are TWO DISTINCT OUTCOMES and the module keeps them distinct: the
//      read error is recorded as a degraded observation, not silently equated
//      with a healthy read.
//   3. RE-DERIVE the run's OBO ceiling chain from its LOCKED template anchor +
//      org + project launch, and compare it against the PERSISTED dispatch
//      chain by CONTAINMENT (`oboCeilingContains`: persisted ⊇ re-derived —
//      superset OK, because a composed child chain legitimately carries parent
//      elements the mint path cannot re-derive). A MISMATCH, a MISSING
//      persisted chain on `surface: "agent_run"`, or a corrupt anchor is a HARD
//      DENY: no voucher is issued and the denial is audited.
//   4. RESOLVE the effective egress policy — signed, so the broker enforces the
//      tier this site authorized rather than one it re-resolves for itself
//      (it still CLAMPS it against the deployment maximum).
//   5. SIGN.
//
// THE CEILING NEVER RIDES THE CARRIER, deliberately. The sealed carrier stays
// identity-only; the ceiling is re-derived here and COMPARED, and only the
// verdict (a voucher, or a denial) crosses to the broker. That is why an agent
// cannot widen its own reach by holding on to an old carrier.
//
// NO OWNER / PLATFORM-ADMIN SHORT-CIRCUIT EXISTS HERE, structurally: this module
// takes no role, no actor context and no bypass flag, and never resolves one. The
// ceiling comparison therefore runs BEFORE — and instead of — any such
// short-circuit, matching the recorded design ("enforce before owner/platform-
// admin short-circuits"). A run whose own invoker owns it is denied on a ceiling
// mismatch exactly like any other.

import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

import {
  assembleVoucher,
  encodeVoucherBody,
  commandDigest,
  voucherSigningInput,
  type EgressPolicy,
  type ExecutionVoucherClaims,
} from "@cinatra-ai/execution-plane/voucher";
import {
  deriveOboCeilingChain,
  oboCeilingContains,
  type OboCeilingChain,
} from "@cinatra-ai/mcp-server/obo-ceiling";
import {
  openSealedSession,
  type ExecutionSession,
} from "@cinatra-ai/llm/execution-plane";

/**
 * Default voucher lifetime. Short by design: it only has to survive from the
 * mint call to the broker's admission decision. Anything longer widens the
 * window in which a captured voucher is replayable across a broker restart (the
 * nonce cache is in-process), and the broker's one-shot revalidation challenge
 * is what covers a legitimately long queue wait.
 */
export const DEFAULT_VOUCHER_TTL_MS = 30_000;

/** Local-dev broker identity. A managed placement uses the broker cert's URI SAN. */
export const DEFAULT_BROKER_IDENTITY_URI = "urn:cinatra:execution-broker:local-dev";

// ---------------------------------------------------------------------------
// Signing key material (host-only)
// ---------------------------------------------------------------------------

/** The narrow signing capability the minter needs — nothing else. */
export type VoucherSigner = {
  /** Detached Ed25519 signature over `input`, base64url. */
  sign: (input: string) => string;
  /** The verify-only half, handed to the broker. */
  publicKey: KeyObject;
};

export class VoucherSigningKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoucherSigningKeyError";
  }
}

/** Build a signer from an Ed25519 PKCS#8 private key (PEM string or KeyObject). */
export function createEd25519VoucherSigner(privateKey: string | KeyObject): VoucherSigner {
  let key: KeyObject;
  try {
    key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  } catch (err) {
    throw new VoucherSigningKeyError(
      `voucher signing key is unusable: ${(err as Error).message}`,
    );
  }
  if (key.type !== "private") {
    throw new VoucherSigningKeyError(
      "voucher signing requires a PRIVATE key; a public key cannot mint.",
    );
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new VoucherSigningKeyError(
      `voucher signing key must be Ed25519, got "${String(key.asymmetricKeyType)}".`,
    );
  }
  return {
    sign: (input: string) => sign(null, Buffer.from(input, "utf8"), key).toString("base64url"),
    publicKey: createPublicKey(key),
  };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** The run row fields the ceiling comparison needs. */
export type VoucherMintRunRow = {
  id: string;
  orgId: string | null;
  templateId: string;
  projectId: string | null;
  /** The PERSISTED dispatch chain. Null ⇒ corrupt anchor or a pre-backfill row. */
  oboCeiling: OboCeilingChain | null;
  runBy: string | null;
};

/** The template fields the anchor re-derivation needs. */
export type VoucherMintTemplateRow = {
  ownerLevel: string | null;
  ownerId: string | null;
};

/** Denial reasons. Every one of them means NO voucher was issued. */
export type VoucherMintDenial =
  /** The carrier itself did not verify (tampered / expired / no secret). */
  | "carrier_rejected"
  /** The bound run is hard-removed (or its identity no longer matches). */
  | "run_removed"
  /** `surface: "agent_run"` with no run binding at all — nothing to bound. */
  | "run_binding_missing"
  /** The run row carries no persisted OBO ceiling chain. */
  | "obo_ceiling_missing"
  /** The persisted chain does not CONTAIN the freshly re-derived chain. */
  | "obo_ceiling_mismatch"
  /** The locked template anchor is corrupt — a chain cannot be derived. */
  | "obo_anchor_corrupt"
  /** The run store could not be read for the ceiling comparison. */
  | "obo_ceiling_unresolved"
  /** The egress policy could not be resolved. */
  | "egress_unavailable"
  /** Signing failed. */
  | "signing_failed";

/** What the audit hook is handed for every denial (and every degraded probe). */
export type VoucherMintAuditEvent = {
  decision: "minted" | "denied";
  denial?: VoucherMintDenial;
  detail: string;
  orgId: string;
  userId: string;
  surface: string;
  runId?: string;
  jobId: string;
  commandId: string;
  /**
   * True when the liveness probe THREW and the recorded `alive` posture stood.
   *
   * SCOPE, stated exactly (Codex round 3, finding 2): the production probe
   * (`createRunLivenessProbe`) converts its OWN store read errors to `alive`
   * internally, because that posture is recorded and is shared verbatim with the
   * broker's per-command probe. So this flag marks a failure of the PROBE SEAM
   * itself, not every degraded store read beneath it. Surfacing store-level
   * degradation would mean widening the shared `RunLivenessProbe` contract, which
   * this slice deliberately does not do — the two probes must not drift on what
   * `gone` means.
   */
  livenessDegraded?: boolean;
};

export type VoucherMintPorts = {
  /** This broker's identity — becomes the voucher `aud`. */
  aud: string;
  signer: VoucherSigner;
  /**
   * The SAME per-command liveness probe the broker uses (`createRunLivenessProbe`).
   * Injected rather than re-implemented so the two can never drift into
   * disagreeing about what `gone` means.
   */
  livenessProbe: (session: ExecutionSession) => Promise<"alive" | "archived" | "gone">;
  readRun: (runId: string) => Promise<VoucherMintRunRow | null>;
  readTemplate: (templateId: string) => Promise<VoucherMintTemplateRow | null>;
  resolveEgressPolicy: (session: ExecutionSession) => EgressPolicy | Promise<EgressPolicy>;
  audit: (event: VoucherMintAuditEvent) => void | Promise<void>;
  /** Carrier secret override (tests); production reads EXECUTION_BROKER_SECRET. */
  carrierSecret?: string;
  ttlMs?: number;
  nowMs?: () => number;
  randomNonce?: () => string;
};

export type MintCommandVoucherInput = {
  sessionCarrier: string;
  jobId: string;
  command: string;
  commandId: string;
  /** Set ONLY when answering a broker revalidation challenge. */
  nonce?: string;
};

export type MintCommandVoucherResult =
  | { ok: true; voucher: string; claims: ExecutionVoucherClaims }
  | { ok: false; reason: VoucherMintDenial; message: string };

// ---------------------------------------------------------------------------
// The minter
// ---------------------------------------------------------------------------

export function createCommandVoucherMinter(
  ports: VoucherMintPorts,
): (input: MintCommandVoucherInput) => Promise<MintCommandVoucherResult> {
  const now = () => ports.nowMs?.() ?? Date.now();
  const nonce = () => ports.randomNonce?.() ?? randomUUID();
  const ttl = ports.ttlMs ?? DEFAULT_VOUCHER_TTL_MS;

  return async (input: MintCommandVoucherInput): Promise<MintCommandVoucherResult> => {
    // --- 1. authenticate the carrier ---------------------------------------
    const opened = openSealedSession(input.sessionCarrier, {
      ...(ports.carrierSecret ? { secret: ports.carrierSecret } : {}),
      nowMs: now(),
    });
    if (!opened.ok) {
      // No attributable identity ⇒ nothing to audit against a tenant, and
      // nothing to authorize. Refuse without inventing an org to record it under.
      return {
        ok: false,
        reason: "carrier_rejected",
        message: `the execution-session carrier was rejected (${opened.reason}); no voucher is issued (fail-closed)`,
      };
    }
    const session = opened.session;

    const deny = async (
      reason: VoucherMintDenial,
      message: string,
      extra?: { livenessDegraded?: boolean },
    ): Promise<MintCommandVoucherResult> => {
      await safeAudit(ports, {
        decision: "denied",
        denial: reason,
        detail: message,
        orgId: session.orgId,
        userId: session.userId,
        surface: session.surface,
        ...(session.runId ? { runId: session.runId } : {}),
        jobId: input.jobId,
        commandId: input.commandId,
        ...(extra?.livenessDegraded ? { livenessDegraded: true } : {}),
      });
      return { ok: false, reason, message };
    };

    // --- 2. liveness, with the recorded posture preserved exactly ----------
    // TWO DISTINCT OUTCOMES: an absent row answers `gone` (the probe's own
    // contract) and hard-denies; a READ ERROR keeps the recorded `alive` posture
    // and is recorded as degraded rather than being collapsed into a healthy read.
    let liveness: "alive" | "archived" | "gone";
    let livenessDegraded = false;
    try {
      liveness = await ports.livenessProbe(session);
    } catch {
      liveness = "alive";
      livenessDegraded = true;
    }
    if (liveness === "gone") {
      return deny(
        "run_removed",
        "the bound run no longer exists (hard-removed) or no longer matches the sealed identity; no voucher is issued (fail-closed)",
        { livenessDegraded },
      );
    }

    // --- 3. OBO ceiling: re-derive + CONTAINMENT compare -------------------
    // Applies whenever the session is bound to a run. `surface: "agent_run"`
    // with NO run binding is itself a hard deny: an agent run whose ceiling
    // cannot be established must not execute commands.
    if (session.surface === "agent_run" && !session.runId) {
      return deny(
        "run_binding_missing",
        "an agent-run execution session with no run binding cannot be bounded by an OBO ceiling; no voucher is issued (fail-closed)",
        { livenessDegraded },
      );
    }
    if (session.runId) {
      let run: VoucherMintRunRow | null;
      try {
        run = await ports.readRun(session.runId);
      } catch (err) {
        // Distinct from a liveness read error: the ceiling comparison is the
        // AUTHORIZATION, and an authorization that cannot be evaluated is a
        // denial. Only the LIVENESS observation carries the alive-on-error
        // posture, and only because the run's existence is not the grant.
        return deny(
          "obo_ceiling_unresolved",
          `the run's OBO ceiling could not be read (${(err as Error).message}); no voucher is issued (fail-closed)`,
          { livenessDegraded },
        );
      }
      if (!run) {
        return deny(
          "run_removed",
          "the bound run row is absent; no voucher is issued (fail-closed)",
          { livenessDegraded },
        );
      }
      // The run's tenancy must be PRESENT and must match the carrier. Codex round
      // 3, finding 1: falling back to the carrier's org for a row whose `orgId` is
      // null would let a corrupt row derive a chain against an org it never
      // recorded — the org element is the mandatory floor of every derived chain,
      // so guessing it is exactly the wrong thing to guess.
      if (!run.orgId) {
        return deny(
          "obo_anchor_corrupt",
          "the bound run row carries no organization; its OBO ceiling chain cannot be derived against a guessed tenancy; no voucher is issued (fail-closed)",
          { livenessDegraded },
        );
      }
      if (run.orgId !== session.orgId) {
        return deny(
          "run_removed",
          "the bound run belongs to a different organization than the sealed session; no voucher is issued (fail-closed)",
          { livenessDegraded },
        );
      }
      let template: VoucherMintTemplateRow | null;
      try {
        template = await ports.readTemplate(run.templateId);
      } catch (err) {
        return deny(
          "obo_ceiling_unresolved",
          `the run's locked template anchor could not be read (${(err as Error).message}); no voucher is issued (fail-closed)`,
          { livenessDegraded },
        );
      }
      // A MISSING template ROW is a broken reference, not the documented
      // pre-backfill state, and must not silently weaken the re-derivation to the
      // bare org floor (Codex round 3, finding 1). A row that EXISTS with a null
      // `ownerLevel` IS the recorded pre-backfill state and keeps
      // `deriveOboCeilingChain`'s own null-tier handling — the shared derivation
      // contract is not forked here, only the absent-row case is closed.
      if (!template) {
        return deny(
          "obo_anchor_corrupt",
          "the run's locked template row is absent, so its anchor cannot be re-derived; no voucher is issued (fail-closed)",
          { livenessDegraded },
        );
      }
      const recomputed = deriveOboCeilingChain({
        ownerLevel: template.ownerLevel,
        ownerId: template.ownerId,
        orgId: run.orgId,
        projectId: run.projectId,
      });
      if (!recomputed) {
        return deny(
          "obo_anchor_corrupt",
          "the run's locked template anchor is corrupt (a partial anchor is never widened to the org floor); no voucher is issued (fail-closed)",
          { livenessDegraded },
        );
      }
      if (!run.oboCeiling || run.oboCeiling.length === 0) {
        // A missing persisted chain is a HARD DENY for an agent run. For a
        // non-agent-run surface that nonetheless carries a run binding it is the
        // same verdict: there is no persisted grant to compare against, and the
        // fresh derivation cannot stand in for one (that would let a corrupt or
        // absent dispatch record silently re-authorize the run).
        return deny(
          "obo_ceiling_missing",
          "the bound run carries no persisted OBO ceiling chain; no voucher is issued (fail-closed)",
          { livenessDegraded },
        );
      }
      if (!oboCeilingContains(run.oboCeiling, recomputed)) {
        return deny(
          "obo_ceiling_mismatch",
          "the run's persisted OBO ceiling chain does not contain its freshly re-derived chain; no voucher is issued (fail-closed)",
          { livenessDegraded },
        );
      }
    }

    // --- 4. effective egress policy ---------------------------------------
    let egressPolicy: EgressPolicy;
    try {
      egressPolicy = await ports.resolveEgressPolicy(session);
    } catch (err) {
      return deny(
        "egress_unavailable",
        `the effective egress policy could not be resolved (${(err as Error).message}); no voucher is issued (fail-closed)`,
        { livenessDegraded },
      );
    }

    // --- 5. sign ----------------------------------------------------------
    const iat = now();
    const claims: ExecutionVoucherClaims = {
      aud: ports.aud,
      jobId: input.jobId,
      orgId: session.orgId,
      userId: session.userId,
      surface: session.surface,
      ...(session.runId ? { runId: session.runId } : {}),
      commandSha256: commandDigest(input.command),
      commandId: input.commandId,
      egressPolicy,
      // A remint MUST carry the broker's challenge nonce; otherwise a fresh one.
      nonce: input.nonce ?? nonce(),
      iat,
      exp: iat + ttl,
    };
    let voucher: string;
    try {
      const body = encodeVoucherBody(claims);
      voucher = assembleVoucher(body, ports.signer.sign(voucherSigningInput(body)));
    } catch (err) {
      return deny(
        "signing_failed",
        `the voucher could not be signed (${(err as Error).message}); no voucher is issued (fail-closed)`,
        { livenessDegraded },
      );
    }

    await safeAudit(ports, {
      decision: "minted",
      detail: `authorized command ${input.commandId} on job ${input.jobId}`,
      orgId: session.orgId,
      userId: session.userId,
      surface: session.surface,
      ...(session.runId ? { runId: session.runId } : {}),
      jobId: input.jobId,
      commandId: input.commandId,
      ...(livenessDegraded ? { livenessDegraded: true } : {}),
    });
    return { ok: true, voucher, claims };
  };
}

/** Auditing must never turn a decision into an exception. */
async function safeAudit(
  ports: VoucherMintPorts,
  event: VoucherMintAuditEvent,
): Promise<void> {
  try {
    await ports.audit(event);
  } catch {
    // The decision was already made and enforced; a sink failure cannot undo it.
  }
}
