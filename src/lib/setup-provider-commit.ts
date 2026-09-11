import "server-only";

/**
 * THE PROVIDER-COMMIT STATE MACHINE (cinatra#2388, epic #2385 S3).
 *
 * One durable record — the SETUP-COMMIT record — carries the instance's
 * LLM-provider commitment through a fenced claim protocol:
 *
 *   (absent) --beginSetupProviderClaim--> { state: "claimed", nonce, … }
 *            --commitSetupProviderClaim--> { state: "committed", … }
 *
 * WHY A MACHINE AT ALL. Before S3, the setup-side commit of
 * `llm_default_provider` rode the readiness saga's receipt: two concurrent
 * Continues could interleave their commit + compensation arbitrarily, and the
 * Administration mutation wrote the default with no relation to setup state.
 * The machine makes both transitions FENCED:
 *
 *  - a CLAIM is inserted before any commit work, owned by a nonce and proven
 *    by READ-AFTER-INSERT nonce comparison (the insert-if-absent primitive
 *    cannot report whether it was the winner, so the winner is whoever reads
 *    their own nonce back);
 *  - every state transition is a byte-equal COMPARE-AND-SWAP against the exact
 *    raw snapshot it was derived from, so a concurrent transition makes the
 *    loser's swap a no-op instead of a lost update;
 *  - COMPENSATION is CAS-tombstone / conditional-delete only, and restores the
 *    prior default only under PROVEN ownership (the byte-equal swap landing IS
 *    the proof) — a failing execution can never clobber a concurrent winner's
 *    state;
 *  - claims EXPIRE (`expiresAt`): a claimant that crashed mid-run never wedges
 *    the wizard — the expired claim reads as absent and is reclaimable, while
 *    the RESUMED expired claimant's own commit is refused (its guard re-checks
 *    expiry, and any late swap loses the byte-equal race).
 *
 * COMMITMENT ≠ READINESS. The committed record is the provider LOCK and
 * survives credential loss. Completion/readiness is derived FRESHLY on every
 * read ({@link deriveSetupAiStepState}): lock + a fresh matching keyed
 * credential fingerprint + the provider-specific readiness INPUTS re-read
 * live (S4, cinatra#2389 — no receipt in the derivation). A fingerprint
 * mismatch reopens the committed provider's key + Continue flow while the
 * CHOICE stays locked.
 *
 * TRANSIENT-STATE HONESTY (ordering of the setup sink). The metadata store has
 * no multi-key transaction, so "nonce guard + audited default write +
 * claim→committed CAS" cannot be literally one statement. The sink orders them
 *   guard → CAS(claim→committed) → audited write → verify
 * because that is the ordering whose FAILURE states are all recoverable under
 * proven ownership: if the audited write fails, the just-written commitment is
 * CAS-tombstoned (byte-equal ⇒ ours) and the machine converges to
 * {no commitment, prior default}. The reverse ordering (write first) has an
 * unrecoverable failure state — default written, commitment lost to a
 * concurrent reclaim — in which compensation could no longer prove ownership.
 * The window in which a commitment exists before its default write is a few
 * milliseconds inside one action and converges in both directions.
 */

import { randomUUID } from "node:crypto";

import type { LlmProvider } from "@cinatra-ai/agents/llm-provider-policy";

import {
  compareAndSwapMetadataValueFromDatabase,
  readDefaultLlmProviderFromDatabase,
  readRawMetadataStringFromDatabase,
  writeDefaultLlmProviderToDatabase,
  writeMetadataValueIfAbsentToDatabase,
} from "@/lib/database";
import {
  areProviderReadinessInputsSatisfied,
  readSetupReadinessState,
  readSetupReadinessReceipt,
} from "@/lib/setup-readiness-saga";
import {
  liveCredentialFingerprintMatches,
  readLiveCredentialFingerprint,
  type LiveCredentialFingerprint,
} from "@/lib/llm-credential-fingerprint";

// ===========================================================================
// Record
// ===========================================================================

export const SETUP_PROVIDER_COMMIT_METADATA_KEY = "setup_provider_commit";

/** How long a claim fences the wizard before crash recovery reclaims it. */
export const SETUP_PROVIDER_CLAIM_TTL_MS = 10 * 60_000;

export type SetupProviderClaimRecord = {
  recordVersion: 1;
  state: "claimed";
  /** Ownership token; NEVER exposed to any admin but the claimant's own run. */
  nonce: string;
  provider: string;
  /** Keyed digest of the credential the claim started under (or null). */
  startingCredentialFingerprint: string | null;
  /** The stored default at claim time — what compensation may restore. */
  priorDefault: string;
  /** NEVER exposed to other admins (the read-only view is identifier-free). */
  actorId: string | null;
  claimedAt: string;
  expiresAt: string;
};

export type SetupProviderCommitProvenance =
  | "setup"
  | "administration"
  | "migrated-from-receipt"
  /**
   * Sealed and committed by the boot-time bootstrap from the instance
   * environment (no operator ran the wizard). Distinct so the record never
   * claims a human completed a step nobody performed.
   */
  | "environment-bootstrap";

export type SetupProviderCommitmentRecord = {
  recordVersion: 1;
  state: "committed";
  /** Identity token for read-after-insert comparison; not an admin secret. */
  commitId: string;
  provider: string;
  /** Keyed digest of the credential the commitment was earned under. */
  credentialFingerprint: string | null;
  committedAt: string;
  provenance: SetupProviderCommitProvenance;
  actorId: string | null;
};

export type SetupProviderCommitState =
  | { kind: "absent" }
  | { kind: "claim-pending"; claim: SetupProviderClaimRecord }
  | { kind: "committed"; commitment: SetupProviderCommitmentRecord };

/**
 * The identifier-free projection other admins may see. A pending claim exposes
 * NOTHING but its existence (no nonce, no actor, not even the provider — the
 * generic "setup in progress" read-only state); `ownClaim` is computed
 * server-side against the caller's own session and is the only distinction.
 */
export type SetupProviderCommitPublicView =
  | { kind: "absent" }
  | { kind: "claim-pending"; ownClaim: boolean }
  | { kind: "committed"; provider: string };

// ===========================================================================
// Snapshot read
// ===========================================================================

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseRecord(
  raw: string | null,
): SetupProviderClaimRecord | SetupProviderCommitmentRecord | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.recordVersion !== 1) {
    // Unknown version ⇒ not valid evidence. Loud, because it means a newer
    // build wrote a shape this build cannot interpret.
    console.warn(
      "[setup-provider-commit] ignoring a SETUP-COMMIT record with an unknown recordVersion",
    );
    return null;
  }
  if (record.state === "claimed") {
    if (
      !isNonEmptyString(record.nonce) ||
      !isNonEmptyString(record.provider) ||
      !isNonEmptyString(record.priorDefault) ||
      !isNonEmptyString(record.claimedAt) ||
      !isNonEmptyString(record.expiresAt)
    ) {
      return null;
    }
    return record as SetupProviderClaimRecord;
  }
  if (record.state === "committed") {
    if (
      !isNonEmptyString(record.commitId) ||
      !isNonEmptyString(record.provider) ||
      !isNonEmptyString(record.committedAt) ||
      !isNonEmptyString(record.provenance)
    ) {
      return null;
    }
    return record as SetupProviderCommitmentRecord;
  }
  return null;
}

function isClaimExpired(claim: SetupProviderClaimRecord, now: Date): boolean {
  const expires = Date.parse(claim.expiresAt);
  return !Number.isFinite(expires) || expires <= now.getTime();
}

export type SetupProviderCommitSnapshot = {
  /** Byte-accurate raw row value (null = no row), for CAS transitions. */
  raw: string | null;
  state: SetupProviderCommitState;
};

/**
 * Read the record + its byte-accurate raw snapshot. An EXPIRED claim reads as
 * `absent` (crash recovery — the wizard is never wedged) while the raw bytes
 * still carry the stale claim, so any transition out of "absent" CASes over
 * them and a resumed expired claimant's own swap deterministically loses.
 */
export function readSetupProviderCommitSnapshot(
  now: Date = new Date(),
): SetupProviderCommitSnapshot {
  const raw = readRawMetadataStringFromDatabase(SETUP_PROVIDER_COMMIT_METADATA_KEY);
  const record = parseRecord(raw);
  if (!record) return { raw, state: { kind: "absent" } };
  if (record.state === "claimed") {
    if (isClaimExpired(record, now)) return { raw, state: { kind: "absent" } };
    return { raw, state: { kind: "claim-pending", claim: record } };
  }
  return { raw, state: { kind: "committed", commitment: record } };
}

export function readSetupProviderCommitState(
  now: Date = new Date(),
): SetupProviderCommitState {
  return readSetupProviderCommitSnapshot(now).state;
}

/** The identifier-free view for rendering; see {@link SetupProviderCommitPublicView}. */
export function describeSetupProviderCommitStateFor(
  viewerActorId: string | null,
  now: Date = new Date(),
): SetupProviderCommitPublicView {
  const state = readSetupProviderCommitState(now);
  if (state.kind === "claim-pending") {
    return {
      kind: "claim-pending",
      ownClaim:
        viewerActorId !== null && state.claim.actorId === viewerActorId,
    };
  }
  if (state.kind === "committed") {
    return { kind: "committed", provider: state.commitment.provider };
  }
  return { kind: "absent" };
}

// ===========================================================================
// Fenced writes (shared internals)
// ===========================================================================

/**
 * Land `record` in the "absent" state's two physical shapes:
 *  - NO ROW: insert-if-absent, then READ-AFTER-INSERT identity comparison
 *    (the insert cannot report whether it won);
 *  - A ROW whose bytes are a tombstone / expired claim / unparsable value:
 *    byte-equal CAS over the observed snapshot.
 * Returns true iff OUR record is now the stored one.
 */
function landRecordOverAbsent(
  record: SetupProviderClaimRecord | SetupProviderCommitmentRecord,
  observedRaw: string | null,
  identity: { field: "nonce" | "commitId"; value: string },
): boolean {
  if (observedRaw === null) {
    writeMetadataValueIfAbsentToDatabase(SETUP_PROVIDER_COMMIT_METADATA_KEY, record);
    const after = parseRecord(
      readRawMetadataStringFromDatabase(SETUP_PROVIDER_COMMIT_METADATA_KEY),
    );
    return (
      after !== null &&
      (after as Record<string, unknown>)[identity.field] === identity.value
    );
  }
  return compareAndSwapMetadataValueFromDatabase(
    SETUP_PROVIDER_COMMIT_METADATA_KEY,
    record,
    observedRaw,
  );
}

/** The exact bytes a record write produced (both primitives JSON.stringify). */
function rawOf(record: unknown): string {
  return JSON.stringify(record);
}

// ===========================================================================
// The claim protocol
// ===========================================================================

export type BeginSetupProviderClaimResult =
  | { ok: true; claim: SetupProviderClaimRecord }
  | { ok: false; refusal: "claim-pending" | "committed" };

export function beginSetupProviderClaim(input: {
  provider: string;
  actorId: string | null;
  startingCredentialFingerprint: string | null;
  now?: Date;
  ttlMs?: number;
  /** Injectable for tests; production reads the stored default. */
  readStoredDefault?: () => string;
}): BeginSetupProviderClaimResult {
  const now = input.now ?? new Date();
  const readStoredDefault =
    input.readStoredDefault ?? readDefaultLlmProviderFromDatabase;
  const snapshot = readSetupProviderCommitSnapshot(now);
  if (snapshot.state.kind === "claim-pending") {
    return { ok: false, refusal: "claim-pending" };
  }
  if (snapshot.state.kind === "committed") {
    return { ok: false, refusal: "committed" };
  }
  const claim: SetupProviderClaimRecord = {
    recordVersion: 1,
    state: "claimed",
    nonce: randomUUID(),
    provider: input.provider,
    startingCredentialFingerprint: input.startingCredentialFingerprint,
    priorDefault: readStoredDefault(),
    actorId: input.actorId,
    claimedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + (input.ttlMs ?? SETUP_PROVIDER_CLAIM_TTL_MS),
    ).toISOString(),
  };
  const landed = landRecordOverAbsent(claim, snapshot.raw, {
    field: "nonce",
    value: claim.nonce,
  });
  if (!landed) {
    // Lost the race — classify what won so the caller can render honestly.
    const winner = readSetupProviderCommitState(now);
    return {
      ok: false,
      refusal: winner.kind === "committed" ? "committed" : "claim-pending",
    };
  }
  return { ok: true, claim };
}

/**
 * Release a claim this execution owns (saga failure BEFORE the sink ran).
 * Conditional-delete only: the byte-equal CAS against the claim's own bytes is
 * the ownership proof, so a concurrent winner's state is never clobbered.
 * The stored default is untouched — setup never writes it outside the sink.
 */
export function releaseSetupProviderClaim(input: { nonce: string }): boolean {
  const raw = readRawMetadataStringFromDatabase(SETUP_PROVIDER_COMMIT_METADATA_KEY);
  const record = parseRecord(raw);
  if (!record || record.state !== "claimed" || record.nonce !== input.nonce) {
    return false;
  }
  return compareAndSwapMetadataValueFromDatabase(
    SETUP_PROVIDER_COMMIT_METADATA_KEY,
    null,
    raw as string,
  );
}

// ===========================================================================
// The atomic setup sink
// ===========================================================================

export type CommitSetupProviderClaimResult =
  | { ok: true; commitment: SetupProviderCommitmentRecord; raw: string }
  | {
      ok: false;
      refusal:
        | "not-claimed"
        | "nonce-mismatch"
        | "claim-expired"
        | "fence-lost"
        | "default-write-failed";
      message: string;
    };

/**
 * The ONE setup-side sink for the audited `llm_default_provider` write: the
 * nonce guard, the claim→committed CAS, and the audited default write are a
 * single fenced step — the audited mutation is never invoked unfenced from
 * setup. See the module header for the ordering rationale.
 */
export async function commitSetupProviderClaim(input: {
  nonce: string;
  /** Keyed digest of the credential the readiness run just verified. */
  credentialFingerprint: string | null;
  /** The AUDITED platform-admin mutation (injected by the server action). */
  writeAuditedDefault: (provider: LlmProvider) => Promise<void>;
  /**
   * WHO earned this commitment. Defaults to `"setup"` — the wizard's Continue,
   * which is every pre-existing caller — so a boot-time environment bootstrap
   * can be told apart in the record instead of masquerading as an operator run.
   */
  provenance?: SetupProviderCommitProvenance;
  now?: Date;
  readStoredDefault?: () => string;
  restoreDefault?: (provider: string) => void;
}): Promise<CommitSetupProviderClaimResult> {
  const now = input.now ?? new Date();
  const readStoredDefault =
    input.readStoredDefault ?? readDefaultLlmProviderFromDatabase;
  const restoreDefault = input.restoreDefault ?? writeDefaultLlmProviderToDatabase;

  // --- Nonce guard -----------------------------------------------------
  const raw = readRawMetadataStringFromDatabase(SETUP_PROVIDER_COMMIT_METADATA_KEY);
  const record = parseRecord(raw);
  if (!record || record.state !== "claimed") {
    return {
      ok: false,
      refusal: "not-claimed",
      message: "No pending setup claim exists — run the setup step again.",
    };
  }
  if (record.nonce !== input.nonce) {
    return {
      ok: false,
      refusal: "nonce-mismatch",
      message: "Another setup run holds the claim — this run must not commit.",
    };
  }
  if (isClaimExpired(record, now)) {
    // The resumed expired claimant: refused HERE, and even a racing swap after
    // this check loses byte-equality to whoever legitimately reclaimed.
    return {
      ok: false,
      refusal: "claim-expired",
      message: "This setup run's claim expired — run the setup step again.",
    };
  }

  // --- claim→committed CAS (the fence) ---------------------------------
  const commitment: SetupProviderCommitmentRecord = {
    recordVersion: 1,
    state: "committed",
    commitId: randomUUID(),
    provider: record.provider,
    credentialFingerprint: input.credentialFingerprint,
    committedAt: now.toISOString(),
    provenance: input.provenance ?? "setup",
    actorId: record.actorId,
  };
  const swapped = compareAndSwapMetadataValueFromDatabase(
    SETUP_PROVIDER_COMMIT_METADATA_KEY,
    commitment,
    raw as string,
  );
  if (!swapped) {
    return {
      ok: false,
      refusal: "fence-lost",
      message: "The setup claim changed underneath this run — nothing was committed.",
    };
  }
  const committedRaw = rawOf(commitment);

  // --- Audited default write, compensated under proven ownership --------
  const compensate = () => {
    const tombstoned = compareAndSwapMetadataValueFromDatabase(
      SETUP_PROVIDER_COMMIT_METADATA_KEY,
      null,
      committedRaw,
    );
    if (!tombstoned) {
      // Someone moved the record after our commit — it is no longer ours to
      // repair; restoring anything now WOULD clobber another execution.
      console.error(
        "[setup-provider-commit] could not compensate a failed commit: the record is no longer this run's (leaving state to its current owner).",
      );
      return;
    }
    // Ownership proven by the landed tombstone swap: restore the prior default
    // only if the failed write actually moved it.
    try {
      if (readStoredDefault() === record.provider && record.priorDefault !== record.provider) {
        restoreDefault(record.priorDefault);
      }
    } catch (err) {
      console.error(
        "[setup-provider-commit] could not restore the prior default provider after a failed commit:",
        err instanceof Error ? err.name : typeof err,
      );
    }
  };

  try {
    await input.writeAuditedDefault(record.provider as LlmProvider);
  } catch (err) {
    compensate();
    return {
      ok: false,
      refusal: "default-write-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // The audited sink refuses ineligible providers by PRESERVING the prior
  // value rather than throwing — verify the write actually landed.
  if (readStoredDefault() !== record.provider) {
    compensate();
    return {
      ok: false,
      refusal: "default-write-failed",
      message: `The default LLM provider was not saved as "${record.provider}".`,
    };
  }

  return { ok: true, commitment, raw: committedRaw };
}

/**
 * Compensate a commitment THIS execution created (e.g. the receipt write after
 * a successful commit failed): CAS-tombstone the exact committed bytes, and —
 * only when that ownership proof lands — restore the prior default.
 */
export function compensateOwnedSetupCommitment(input: {
  committedRaw: string;
  committedProvider: string;
  priorDefault: string;
  readStoredDefault?: () => string;
  restoreDefault?: (provider: string) => void;
}): boolean {
  const readStoredDefault =
    input.readStoredDefault ?? readDefaultLlmProviderFromDatabase;
  const restoreDefault = input.restoreDefault ?? writeDefaultLlmProviderToDatabase;
  const tombstoned = compareAndSwapMetadataValueFromDatabase(
    SETUP_PROVIDER_COMMIT_METADATA_KEY,
    null,
    input.committedRaw,
  );
  if (!tombstoned) return false;
  if (
    readStoredDefault() === input.committedProvider &&
    input.priorDefault !== input.committedProvider
  ) {
    restoreDefault(input.priorDefault);
  }
  return true;
}

/**
 * Refresh the credential fingerprint on an EXISTING commitment after a
 * successful re-verify (key rotation closed through the reopened key flow).
 * Byte-equal CAS: a concurrent transition simply wins and the refresh no-ops.
 */
export function refreshCommittedCredentialFingerprint(input: {
  expectedRaw: string;
  commitment: SetupProviderCommitmentRecord;
  credentialFingerprint: string | null;
}): boolean {
  return compareAndSwapMetadataValueFromDatabase(
    SETUP_PROVIDER_COMMIT_METADATA_KEY,
    { ...input.commitment, credentialFingerprint: input.credentialFingerprint },
    input.expectedRaw,
  );
}

// ===========================================================================
// Administration — the second transactional transition
// ===========================================================================

/**
 * TYPED, CLASSIFIED conflict for a provider change attempted while a setup
 * claim is pending — surfaced to callers as a conflict (409 / a flash code),
 * never an unclassified 500.
 */
export class SetupProviderCommitConflictError extends Error {
  readonly conflict: "claim-pending" | "concurrent-transition";
  constructor(conflict: "claim-pending" | "concurrent-transition") {
    super(
      conflict === "claim-pending"
        ? "AI setup is currently completing this instance's provider commitment. Retry after it finishes."
        : "Another provider transition landed concurrently. Re-read the current state and retry.",
    );
    this.name = "SetupProviderCommitConflictError";
    this.conflict = conflict;
  }
}

export type AdministrationProviderTransitionResult =
  | { outcome: "created" | "moved"; commitment: SetupProviderCommitmentRecord }
  | { outcome: "unchanged"; provider: string };

/**
 * The EXPLICIT Administration provider change — the only non-setup writer of
 * the commitment, and the transition every global default writer routes
 * through. Four-state matrix:
 *
 *   absent               → CREATE the commitment (provenance "administration")
 *   pending claim        → typed {@link SetupProviderCommitConflictError}
 *   committed, same      → idempotent no-op (no audit, no writes)
 *   committed, different → fence (CAS move) + audited default write, with
 *                          byte-equal-restore compensation on failure
 *
 * Readiness is deliberately INDEPENDENT: the new provider's key flow may
 * reopen after the move; the commitment (the lock) transfers regardless.
 *
 * AUTHZ lives in the injected audited mutation (which is authz + strict audit
 * + write); callers gate with their own admin session first, exactly like
 * every existing writer. A failure inside the mutation is compensated by
 * restoring the exact prior bytes, so an unauthorized caller cannot move the
 * record durably.
 */
export async function transitionDefaultProviderViaAdministration(input: {
  provider: LlmProvider;
  actorId: string | null;
  /** The AUDITED platform-admin mutation (authz + strict audit + write). */
  writeAuditedDefault: (provider: LlmProvider) => Promise<void>;
  now?: Date;
  readStoredDefault?: () => string;
  readCredentialFingerprint?: (provider: string) => Promise<LiveCredentialFingerprint>;
}): Promise<AdministrationProviderTransitionResult> {
  const now = input.now ?? new Date();
  const readStoredDefault =
    input.readStoredDefault ?? readDefaultLlmProviderFromDatabase;
  const readFingerprint =
    input.readCredentialFingerprint ?? readLiveCredentialFingerprint;

  const snapshot = readSetupProviderCommitSnapshot(now);
  if (snapshot.state.kind === "claim-pending") {
    throw new SetupProviderCommitConflictError("claim-pending");
  }
  if (
    snapshot.state.kind === "committed" &&
    snapshot.state.commitment.provider === input.provider
  ) {
    // cinatra#2504: a second natural door to heal a legacy commitment whose
    // fingerprint was never captured (pre-openai-connector-0.1.9) — the
    // operator revisiting "the same provider" in Administration is otherwise
    // a pure no-op, so opportunistically refresh a null fingerprint while
    // we're here. Best-effort and byte-equal CAS: an unreadable credential or
    // a lost race just leaves the record exactly as it was — the no-op
    // contract (no audit, no default write) is unaffected either way.
    if (snapshot.state.commitment.credentialFingerprint === null && snapshot.raw !== null) {
      const commitment = snapshot.state.commitment;
      const expectedRaw = snapshot.raw;
      try {
        const live = await readFingerprint(input.provider);
        if (live.status === "readable") {
          refreshCommittedCredentialFingerprint({
            expectedRaw,
            commitment,
            credentialFingerprint: live.fingerprint,
          });
        }
      } catch {
        // Leave the null fingerprint for the next opportunity (setup's own
        // re-verify, or a later Administration visit).
      }
    }
    return { outcome: "unchanged", provider: input.provider };
  }

  // The new provider's credential may be absent/unreadable — that reopens its
  // key flow, it does not block the transition. Stored as null on any
  // non-readable outcome (fail-closed mismatch on every later readiness read).
  let credentialFingerprint: string | null = null;
  try {
    const live = await readFingerprint(input.provider);
    credentialFingerprint = live.status === "readable" ? live.fingerprint : null;
  } catch {
    credentialFingerprint = null;
  }

  const commitment: SetupProviderCommitmentRecord = {
    recordVersion: 1,
    state: "committed",
    commitId: randomUUID(),
    provider: input.provider,
    credentialFingerprint,
    committedAt: now.toISOString(),
    provenance: "administration",
    actorId: input.actorId,
  };

  // --- Fence: land the moved/created record ------------------------------
  const landed = landRecordOverAbsent(commitment, snapshot.raw, {
    field: "commitId",
    value: commitment.commitId,
  });
  if (!landed) {
    throw new SetupProviderCommitConflictError("concurrent-transition");
  }
  const newRaw = rawOf(commitment);

  // --- Audited write, compensated by byte-equal restore ------------------
  const compensate = () => {
    const restored = compareAndSwapMetadataValueFromDatabase(
      SETUP_PROVIDER_COMMIT_METADATA_KEY,
      snapshot.raw === null ? null : (JSON.parse(snapshot.raw) as unknown),
      newRaw,
    );
    if (!restored) {
      console.error(
        "[setup-provider-commit] could not restore the prior SETUP-COMMIT record after a failed Administration transition (a concurrent transition owns it now).",
      );
    }
  };

  try {
    await input.writeAuditedDefault(input.provider);
  } catch (err) {
    compensate();
    throw err;
  }
  if (readStoredDefault() !== input.provider) {
    compensate();
    throw new Error(
      `The default LLM provider was not saved as "${input.provider}" — the transition was rolled back.`,
    );
  }

  return {
    outcome: snapshot.state.kind === "committed" ? "moved" : "created",
    commitment,
  };
}

// ===========================================================================
// Lazy receipt migration
// ===========================================================================

/**
 * Backfill the commitment from the LANDED receipt model, lazily, on a
 * setup-state read (cinatra#2388: deploying over a configured instance must
 * not reopen setup once connectors are readable).
 *
 * Conditions, all fail-closed:
 *  - only when NO record exists (claim or commitment ⇒ untouched);
 *  - only from a receipt whose EVERY bound input still re-checks — the stored
 *    default, the MCP mode, the catalog signature, and the Anthropic upload
 *    opt-in are exactly the receipt-fingerprint inputs
 *    {@link readSetupReadinessState} re-derives; an absent/invalid/expired
 *    receipt re-runs AI setup instead of migrating;
 *  - only when the connector's LIVE credential is readable — an unavailable
 *    connector leaves the instance UNBACKFILLED (this simply returns; the next
 *    read retries) and setup renders incomplete until then;
 *  - the insert is CONDITIONAL (insert-if-absent / CAS over stale bytes), so
 *    concurrent readers cannot double-commit.
 */
export async function maybeMigrateReceiptCommitment(deps?: {
  readCredentialFingerprint?: (provider: string) => Promise<LiveCredentialFingerprint>;
  now?: Date;
}): Promise<void> {
  const now = deps?.now ?? new Date();
  const snapshot = readSetupProviderCommitSnapshot(now);
  if (snapshot.state.kind !== "absent") return;
  // A RAW pending-but-expired claim also parses to "absent" — but an expired
  // claim means a setup run already used the machine; never migrate over it.
  if (parseRecord(snapshot.raw) !== null) return;

  const receipt = readSetupReadinessReceipt();
  if (!receipt) return;
  const readiness = await readSetupReadinessState();
  if (!readiness.ready || readiness.receipt?.provider !== receipt.provider) return;

  const readFingerprint =
    deps?.readCredentialFingerprint ?? readLiveCredentialFingerprint;
  let live: LiveCredentialFingerprint;
  try {
    live = await readFingerprint(receipt.provider);
  } catch {
    return; // unreadable ⇒ unbackfilled, retried on a later read
  }
  if (live.status !== "readable") return;

  const commitment: SetupProviderCommitmentRecord = {
    recordVersion: 1,
    state: "committed",
    commitId: randomUUID(),
    provider: receipt.provider,
    credentialFingerprint: live.fingerprint,
    committedAt: now.toISOString(),
    provenance: "migrated-from-receipt",
    actorId: null,
  };
  // Conditional insert; a lost race means another reader migrated (or a real
  // transition landed) — both are correct outcomes to yield to.
  landRecordOverAbsent(commitment, snapshot.raw, {
    field: "commitId",
    value: commitment.commitId,
  });
}

// ===========================================================================
// Fresh completion derivation (the cache's replacement)
// ===========================================================================

export type SetupAiStepState = {
  /** True iff a commitment exists (the provider LOCK — survives credential loss). */
  locked: boolean;
  commitState: SetupProviderCommitState;
  /** True iff the LIVE keyed credential fingerprint matches the commitment's. */
  credentialFresh: boolean;
  /**
   * True iff a commitment exists and its stored `credentialFingerprint` is
   * `null` — a legacy commitment made before fingerprint capture existed
   * (pre-openai-connector-0.1.9, cinatra#2504), not a genuine rotation or
   * removal. `credentialFresh` is `false` in both cases; this flag lets a
   * caller tell them apart and render truthful copy instead of the
   * rotation/removal explanation, which is false for this case.
   */
  credentialFingerprintNeverCaptured: boolean;
  /** Lock + fresh credential + live provider-specific readiness inputs. */
  ready: boolean;
};

/**
 * The FRESH derivation of the AI step's state — what replaced the positive
 * completion cache. Cheap by construction (metadata reads + one connector
 * credential read + the live provider-input reads), and NEVER stale: there is
 * no memo, so there is no stale-true window after invalidation.
 */
export async function deriveSetupAiStepState(deps?: {
  readCredentialFingerprint?: (provider: string) => Promise<LiveCredentialFingerprint>;
  now?: Date;
}): Promise<SetupAiStepState> {
  const now = deps?.now ?? new Date();
  await maybeMigrateReceiptCommitment(deps);
  const commitState = readSetupProviderCommitState(now);
  if (commitState.kind !== "committed") {
    return {
      locked: false,
      commitState,
      credentialFresh: false,
      credentialFingerprintNeverCaptured: false,
      ready: false,
    };
  }
  // cinatra#2504: a legacy commitment (pre-openai-connector-0.1.9) stored no
  // fingerprint at all — distinct from a fingerprint that was captured and no
  // longer matches (rotation/removal). Derived from the already-read
  // commitment; no extra read.
  const credentialFingerprintNeverCaptured =
    commitState.commitment.credentialFingerprint === null;
  const readFingerprint =
    deps?.readCredentialFingerprint ?? readLiveCredentialFingerprint;
  let credentialFresh = false;
  try {
    const live = await readFingerprint(commitState.commitment.provider);
    credentialFresh = liveCredentialFingerprintMatches(
      commitState.commitment.credentialFingerprint,
      live,
    );
  } catch {
    credentialFresh = false; // unreadable ⇒ fail-closed mismatch
  }
  // S4 (cinatra#2389): readiness is RECEIPT-FREE. The committed record is the
  // provider lock, the keyed fingerprint above covers the credential, and the
  // provider-specific readiness inputs are re-read LIVE (Anthropic: native MCP
  // delivery + the standing skills-upload opt-in). The receipt survives only
  // as the lazy-migration source ({@link maybeMigrateReceiptCommitment}).
  const inputsSatisfied = areProviderReadinessInputsSatisfied(
    commitState.commitment.provider as LlmProvider,
  );
  return {
    locked: true,
    commitState,
    credentialFresh,
    credentialFingerprintNeverCaptured,
    ready: credentialFresh && inputsSatisfied,
  };
}
