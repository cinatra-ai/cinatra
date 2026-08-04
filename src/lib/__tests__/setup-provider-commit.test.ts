/**
 * THE PROVIDER-COMMIT STATE MACHINE (cinatra#2388, epic #2385 S3).
 *
 * Pins the acceptance criteria against an in-memory byte-accurate metadata
 * store that mirrors the production primitives exactly (insert-if-absent that
 * cannot report its winner; byte-equal CAS; raw snapshot reads):
 *
 *  - two concurrent Continues (and a resumed expired claimant) cannot
 *    interleave: exactly one commitment, the audited default always matches
 *    it, compensation never clobbers another execution;
 *  - the identifier-free public view exposes no nonce/actor;
 *  - the Administration transition's four-state matrix, with a TYPED conflict
 *    on pending claims;
 *  - the lazy receipt migration: conditional, connector-availability-gated,
 *    provenance `migrated-from-receipt`;
 *  - the fresh derivation: commitment (lock) + fingerprint freshness +
 *    readiness, fail-closed on unreadable credentials.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory metadata store mirroring the production primitives byte-for-byte.
// `readRawOverrides` lets a test stage a TOCTOU interleave: the next N raw
// reads return staged values while writes still hit the real store — exactly
// the "another process wrote between my read and my write" race.
// ---------------------------------------------------------------------------
const store = new Map<string, string>();
const readRawOverrides: Array<string | null> = [];
const defaultProvider = { value: "openai" };

vi.mock("@/lib/database", () => ({
  readRawMetadataStringFromDatabase: (key: string) => {
    if (readRawOverrides.length > 0) return readRawOverrides.shift() ?? null;
    return store.get(key) ?? null;
  },
  writeMetadataValueIfAbsentToDatabase: (key: string, value: unknown) => {
    if (!store.has(key)) store.set(key, JSON.stringify(value));
  },
  compareAndSwapMetadataValueFromDatabase: (
    key: string,
    value: unknown,
    expectedRaw: string,
  ) => {
    if (store.get(key) !== expectedRaw) return false;
    store.set(key, JSON.stringify(value));
    return true;
  },
  readDefaultLlmProviderFromDatabase: () => defaultProvider.value,
  writeDefaultLlmProviderToDatabase: (p: string) => {
    defaultProvider.value = p;
  },
}));

// The receipt re-derivation (provider binding + credential + MCP mode +
// catalog + upload opt-in) is pinned by setup-readiness-receipt.test.ts; here
// it is a controllable seam.
const readiness = {
  ready: false as boolean,
  receipt: null as { provider: string } | null,
};
vi.mock("@/lib/setup-readiness-saga", () => ({
  readSetupReadinessState: () => ({ ready: readiness.ready, receipt: readiness.receipt }),
  readSetupReadinessReceipt: () => readiness.receipt,
}));

// The keyed live-credential reader; its derivation/match rules are pinned by
// llm-credential-fingerprint.test.ts. The match stub mirrors the real
// fail-closed semantics (readable + equal, else mismatch).
type LiveFp =
  | { status: "readable"; fingerprint: string }
  | { status: "absent" }
  | { status: "unreadable"; reason: string };
const liveFingerprint = {
  value: { status: "unreadable", reason: "connector-unavailable" } as LiveFp,
};
vi.mock("@/lib/llm-credential-fingerprint", () => ({
  readLiveCredentialFingerprint: async () => liveFingerprint.value,
  liveCredentialFingerprintMatches: (stored: string | null, live: LiveFp) =>
    Boolean(stored) && live.status === "readable" && stored === live.fingerprint,
}));

import {
  SETUP_PROVIDER_COMMIT_METADATA_KEY,
  beginSetupProviderClaim,
  commitSetupProviderClaim,
  compensateOwnedSetupCommitment,
  deriveSetupAiStepState,
  describeSetupProviderCommitStateFor,
  maybeMigrateReceiptCommitment,
  readSetupProviderCommitState,
  releaseSetupProviderClaim,
  transitionDefaultProviderViaAdministration,
  SetupProviderCommitConflictError,
  type SetupProviderCommitmentRecord,
} from "@/lib/setup-provider-commit";

const KEY = SETUP_PROVIDER_COMMIT_METADATA_KEY;

function storedRecord(): Record<string, unknown> | null {
  const raw = store.get(KEY);
  if (raw === undefined) return null;
  return JSON.parse(raw) as Record<string, unknown> | null;
}

const auditedWrites: string[] = [];
async function auditedWrite(provider: string): Promise<void> {
  auditedWrites.push(provider);
  defaultProvider.value = provider;
}

beforeEach(() => {
  store.clear();
  readRawOverrides.length = 0;
  defaultProvider.value = "openai";
  readiness.ready = false;
  readiness.receipt = null;
  liveFingerprint.value = { status: "unreadable", reason: "connector-unavailable" };
  auditedWrites.length = 0;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Claim protocol
// ---------------------------------------------------------------------------

describe("beginSetupProviderClaim — fenced, nonce-owned", () => {
  it("claims an absent record and reads its own nonce back", () => {
    const begun = beginSetupProviderClaim({
      provider: "anthropic",
      actorId: "admin-1",
      startingCredentialFingerprint: "cfv1:aa",
    });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(begun.claim.provider).toBe("anthropic");
    expect(begun.claim.priorDefault).toBe("openai");
    expect(storedRecord()?.nonce).toBe(begun.claim.nonce);
    expect(readSetupProviderCommitState().kind).toBe("claim-pending");
  });

  it("refuses while a claim is pending, and while a commitment exists", () => {
    const first = beginSetupProviderClaim({
      provider: "openai",
      actorId: "admin-1",
      startingCredentialFingerprint: null,
    });
    expect(first.ok).toBe(true);
    const second = beginSetupProviderClaim({
      provider: "anthropic",
      actorId: "admin-2",
      startingCredentialFingerprint: null,
    });
    expect(second).toEqual({ ok: false, refusal: "claim-pending" });
  });

  it("READ-AFTER-INSERT nonce comparison: a raced insert-if-absent that lost yields a refusal, never a false win", () => {
    // Stage the TOCTOU: this begin's snapshot read sees NO row, but by the
    // time its insert runs, a competitor's claim is already stored — the
    // insert silently no-ops (exactly like ON CONFLICT DO NOTHING) and only
    // the read-after-insert comparison can tell the loser it lost.
    const competitor = {
      recordVersion: 1,
      state: "claimed",
      nonce: "competitor-nonce",
      provider: "openai",
      startingCredentialFingerprint: null,
      priorDefault: "openai",
      actorId: "admin-2",
      claimedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    store.set(KEY, JSON.stringify(competitor));
    readRawOverrides.push(null); // the stale snapshot read
    const lost = beginSetupProviderClaim({
      provider: "anthropic",
      actorId: "admin-1",
      startingCredentialFingerprint: null,
    });
    expect(lost).toEqual({ ok: false, refusal: "claim-pending" });
    // The competitor's claim was NOT clobbered.
    expect(storedRecord()?.nonce).toBe("competitor-nonce");
  });

  it("reclaims an EXPIRED claim via CAS over its stale bytes (crash recovery — the wizard is never wedged)", () => {
    const past = new Date(Date.now() - 60_000);
    const crashed = beginSetupProviderClaim({
      provider: "openai",
      actorId: "admin-1",
      startingCredentialFingerprint: null,
      now: past,
      ttlMs: 1,
    });
    expect(crashed.ok).toBe(true);
    // The crashed claim reads as absent…
    expect(readSetupProviderCommitState().kind).toBe("absent");
    // …and is reclaimable by the next Continue.
    const reclaimed = beginSetupProviderClaim({
      provider: "anthropic",
      actorId: "admin-2",
      startingCredentialFingerprint: null,
    });
    expect(reclaimed.ok).toBe(true);
  });
});

describe("releaseSetupProviderClaim — conditional-delete under nonce ownership only", () => {
  it("releases an owned claim and refuses a foreign nonce", () => {
    const begun = beginSetupProviderClaim({
      provider: "openai",
      actorId: "a",
      startingCredentialFingerprint: null,
    });
    if (!begun.ok) throw new Error("claim failed");
    expect(releaseSetupProviderClaim({ nonce: "someone-else" })).toBe(false);
    expect(readSetupProviderCommitState().kind).toBe("claim-pending");
    expect(releaseSetupProviderClaim({ nonce: begun.claim.nonce })).toBe(true);
    expect(readSetupProviderCommitState().kind).toBe("absent");
  });
});

// ---------------------------------------------------------------------------
// The atomic setup sink
// ---------------------------------------------------------------------------

describe("commitSetupProviderClaim — the fenced setup sink", () => {
  it("commits: nonce guard + claim→committed CAS + audited write, and the default matches the commitment", async () => {
    const begun = beginSetupProviderClaim({
      provider: "anthropic",
      actorId: "admin-1",
      startingCredentialFingerprint: "cfv1:aa",
    });
    if (!begun.ok) throw new Error("claim failed");
    const result = await commitSetupProviderClaim({
      nonce: begun.claim.nonce,
      credentialFingerprint: "cfv1:aa",
      writeAuditedDefault: auditedWrite,
    });
    expect(result.ok).toBe(true);
    expect(auditedWrites).toEqual(["anthropic"]);
    expect(defaultProvider.value).toBe("anthropic");
    const record = storedRecord() as SetupProviderCommitmentRecord;
    expect(record.state).toBe("committed");
    expect(record.provider).toBe("anthropic");
    expect(record.provenance).toBe("setup");
    expect(record.credentialFingerprint).toBe("cfv1:aa");
  });

  it("refuses a foreign nonce WITHOUT invoking the audited mutation", async () => {
    beginSetupProviderClaim({
      provider: "openai",
      actorId: "a",
      startingCredentialFingerprint: null,
    });
    const result = await commitSetupProviderClaim({
      nonce: "not-mine",
      credentialFingerprint: null,
      writeAuditedDefault: auditedWrite,
    });
    expect(result).toMatchObject({ ok: false, refusal: "nonce-mismatch" });
    expect(auditedWrites).toEqual([]);
  });

  it("refuses a RESUMED EXPIRED claimant (guard re-checks expiry) — no interleave with the reclaimer", async () => {
    const past = new Date(Date.now() - 120_000);
    const expired = beginSetupProviderClaim({
      provider: "openai",
      actorId: "a",
      startingCredentialFingerprint: null,
      now: past,
      ttlMs: 1,
    });
    if (!expired.ok) throw new Error("claim failed");
    // The reclaimer takes over and commits.
    const reclaimed = beginSetupProviderClaim({
      provider: "anthropic",
      actorId: "b",
      startingCredentialFingerprint: null,
    });
    if (!reclaimed.ok) throw new Error("reclaim failed");
    const won = await commitSetupProviderClaim({
      nonce: reclaimed.claim.nonce,
      credentialFingerprint: null,
      writeAuditedDefault: auditedWrite,
    });
    expect(won.ok).toBe(true);
    // The resumed expired claimant's commit is refused (the record is not its
    // claim any more) and its late release cannot clobber the commitment.
    const resumed = await commitSetupProviderClaim({
      nonce: expired.claim.nonce,
      credentialFingerprint: null,
      writeAuditedDefault: auditedWrite,
    });
    expect(resumed.ok).toBe(false);
    expect(releaseSetupProviderClaim({ nonce: expired.claim.nonce })).toBe(false);
    // Exactly ONE commitment, and the audited default matches it.
    expect((storedRecord() as SetupProviderCommitmentRecord).provider).toBe("anthropic");
    expect(defaultProvider.value).toBe("anthropic");
    expect(auditedWrites).toEqual(["anthropic"]);
  });

  it("a FAILED audited write tombstones the commitment under proven ownership and leaves the prior default", async () => {
    const begun = beginSetupProviderClaim({
      provider: "anthropic",
      actorId: "a",
      startingCredentialFingerprint: null,
    });
    if (!begun.ok) throw new Error("claim failed");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await commitSetupProviderClaim({
      nonce: begun.claim.nonce,
      credentialFingerprint: null,
      writeAuditedDefault: async () => {
        throw new Error("audit store unavailable");
      },
    });
    expect(result).toMatchObject({ ok: false, refusal: "default-write-failed" });
    expect(readSetupProviderCommitState().kind).toBe("absent");
    expect(defaultProvider.value).toBe("openai");
  });

  it("a write that silently did NOT land (ineligible provider preserved the prior value) is compensated too", async () => {
    const begun = beginSetupProviderClaim({
      provider: "anthropic",
      actorId: "a",
      startingCredentialFingerprint: null,
    });
    if (!begun.ok) throw new Error("claim failed");
    const result = await commitSetupProviderClaim({
      nonce: begun.claim.nonce,
      credentialFingerprint: null,
      writeAuditedDefault: async () => {
        /* the sink's refusal path: preserves the prior value, no throw */
      },
    });
    expect(result).toMatchObject({ ok: false, refusal: "default-write-failed" });
    expect(readSetupProviderCommitState().kind).toBe("absent");
    expect(defaultProvider.value).toBe("openai");
  });
});

describe("compensateOwnedSetupCommitment — ownership-proven rollback", () => {
  it("tombstones its own commitment and restores the prior default; a foreign record is untouched", async () => {
    const begun = beginSetupProviderClaim({
      provider: "anthropic",
      actorId: "a",
      startingCredentialFingerprint: null,
    });
    if (!begun.ok) throw new Error("claim failed");
    const committed = await commitSetupProviderClaim({
      nonce: begun.claim.nonce,
      credentialFingerprint: null,
      writeAuditedDefault: auditedWrite,
    });
    if (!committed.ok) throw new Error("commit failed");
    // Owned: rolls back record + default.
    expect(
      compensateOwnedSetupCommitment({
        committedRaw: committed.raw,
        committedProvider: "anthropic",
        priorDefault: "openai",
      }),
    ).toBe(true);
    expect(readSetupProviderCommitState().kind).toBe("absent");
    expect(defaultProvider.value).toBe("openai");
    // Foreign bytes: refuses, clobbers nothing.
    store.set(KEY, JSON.stringify({ recordVersion: 1, state: "committed", commitId: "x", provider: "openai", credentialFingerprint: null, committedAt: new Date().toISOString(), provenance: "administration", actorId: null }));
    defaultProvider.value = "openai";
    expect(
      compensateOwnedSetupCommitment({
        committedRaw: committed.raw,
        committedProvider: "anthropic",
        priorDefault: "gemini",
      }),
    ).toBe(false);
    expect((storedRecord() as SetupProviderCommitmentRecord).commitId).toBe("x");
    expect(defaultProvider.value).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
// The identifier-free public view
// ---------------------------------------------------------------------------

describe("describeSetupProviderCommitStateFor — no nonce/actor identifiers exposed", () => {
  it("a pending claim exposes ONLY {kind, ownClaim} — no nonce, no actor, no provider", () => {
    const begun = beginSetupProviderClaim({
      provider: "anthropic",
      actorId: "claimant-1",
      startingCredentialFingerprint: null,
    });
    if (!begun.ok) throw new Error("claim failed");
    const otherAdmin = describeSetupProviderCommitStateFor("other-admin");
    expect(otherAdmin).toEqual({ kind: "claim-pending", ownClaim: false });
    const serialized = JSON.stringify(otherAdmin);
    expect(serialized).not.toContain(begun.claim.nonce);
    expect(serialized).not.toContain("claimant-1");
    expect(serialized).not.toContain("anthropic");
    // The claimant sees ownership (their progress render), still no nonce.
    expect(describeSetupProviderCommitStateFor("claimant-1")).toEqual({
      kind: "claim-pending",
      ownClaim: true,
    });
    // A sessionless viewer never owns a claim.
    expect(describeSetupProviderCommitStateFor(null)).toEqual({
      kind: "claim-pending",
      ownClaim: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Administration — the second transactional transition (four-state matrix)
// ---------------------------------------------------------------------------

describe("transitionDefaultProviderViaAdministration — the four-state matrix", () => {
  it("ABSENT → creates the commitment with provenance 'administration' and writes the audited default", async () => {
    liveFingerprint.value = { status: "readable", fingerprint: "cfv1:new" };
    const result = await transitionDefaultProviderViaAdministration({
      provider: "anthropic",
      actorId: "admin-9",
      writeAuditedDefault: auditedWrite,
    });
    expect(result.outcome).toBe("created");
    expect(auditedWrites).toEqual(["anthropic"]);
    const record = storedRecord() as SetupProviderCommitmentRecord;
    expect(record.provenance).toBe("administration");
    expect(record.provider).toBe("anthropic");
    expect(record.credentialFingerprint).toBe("cfv1:new");
  });

  it("PENDING CLAIM → the TYPED classified conflict; nothing is written", async () => {
    beginSetupProviderClaim({
      provider: "openai",
      actorId: "a",
      startingCredentialFingerprint: null,
    });
    await expect(
      transitionDefaultProviderViaAdministration({
        provider: "anthropic",
        actorId: "admin-9",
        writeAuditedDefault: auditedWrite,
      }),
    ).rejects.toMatchObject({
      name: "SetupProviderCommitConflictError",
      conflict: "claim-pending",
    });
    expect(auditedWrites).toEqual([]);
    expect(readSetupProviderCommitState().kind).toBe("claim-pending");
  });

  it("COMMITTED-SAME → idempotent no-op (no audit, no writes)", async () => {
    await transitionDefaultProviderViaAdministration({
      provider: "anthropic",
      actorId: "a",
      writeAuditedDefault: auditedWrite,
    });
    auditedWrites.length = 0;
    const before = store.get(KEY);
    const result = await transitionDefaultProviderViaAdministration({
      provider: "anthropic",
      actorId: "b",
      writeAuditedDefault: auditedWrite,
    });
    expect(result).toEqual({ outcome: "unchanged", provider: "anthropic" });
    expect(auditedWrites).toEqual([]);
    expect(store.get(KEY)).toBe(before);
  });

  it("COMMITTED-DIFFERENT → atomically audits + writes the default + moves the record", async () => {
    await transitionDefaultProviderViaAdministration({
      provider: "anthropic",
      actorId: "a",
      writeAuditedDefault: auditedWrite,
    });
    const moved = await transitionDefaultProviderViaAdministration({
      provider: "gemini",
      actorId: "b",
      writeAuditedDefault: auditedWrite,
    });
    expect(moved.outcome).toBe("moved");
    expect(defaultProvider.value).toBe("gemini");
    expect((storedRecord() as SetupProviderCommitmentRecord).provider).toBe("gemini");
    expect(auditedWrites).toEqual(["anthropic", "gemini"]);
  });

  it("a FAILED audited write on a move restores the exact prior record bytes and rethrows", async () => {
    await transitionDefaultProviderViaAdministration({
      provider: "anthropic",
      actorId: "a",
      writeAuditedDefault: auditedWrite,
    });
    const beforeRaw = store.get(KEY);
    await expect(
      transitionDefaultProviderViaAdministration({
        provider: "gemini",
        actorId: "b",
        writeAuditedDefault: async () => {
          throw new Error("authz denied");
        },
      }),
    ).rejects.toThrow("authz denied");
    expect(store.get(KEY)).toBe(beforeRaw);
    expect(defaultProvider.value).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// Lazy receipt migration
// ---------------------------------------------------------------------------

describe("maybeMigrateReceiptCommitment — conditional, connector-gated backfill", () => {
  it("migrates a VALID receipt on a readable connector: provenance 'migrated-from-receipt' + the fresh fingerprint", async () => {
    readiness.receipt = { provider: "openai" };
    readiness.ready = true;
    liveFingerprint.value = { status: "readable", fingerprint: "cfv1:live" };
    await maybeMigrateReceiptCommitment();
    const record = storedRecord() as SetupProviderCommitmentRecord;
    expect(record.state).toBe("committed");
    expect(record.provenance).toBe("migrated-from-receipt");
    expect(record.provider).toBe("openai");
    expect(record.credentialFingerprint).toBe("cfv1:live");
  });

  it("an UNREADABLE connector leaves the instance unbackfilled (retried on a later read)", async () => {
    readiness.receipt = { provider: "openai" };
    readiness.ready = true;
    liveFingerprint.value = { status: "unreadable", reason: "connector-unavailable" };
    await maybeMigrateReceiptCommitment();
    expect(readSetupProviderCommitState().kind).toBe("absent");
  });

  it("an INVALID receipt (any bound input drifted) does not migrate — AI setup re-runs instead", async () => {
    readiness.receipt = { provider: "openai" };
    readiness.ready = false; // the fingerprint re-derivation failed
    liveFingerprint.value = { status: "readable", fingerprint: "cfv1:live" };
    await maybeMigrateReceiptCommitment();
    expect(readSetupProviderCommitState().kind).toBe("absent");
  });

  it("never touches an existing record — including a stale EXPIRED claim (the machine was already in use)", async () => {
    readiness.receipt = { provider: "openai" };
    readiness.ready = true;
    liveFingerprint.value = { status: "readable", fingerprint: "cfv1:live" };
    const expired = {
      recordVersion: 1,
      state: "claimed",
      nonce: "n",
      provider: "openai",
      startingCredentialFingerprint: null,
      priorDefault: "openai",
      actorId: null,
      claimedAt: new Date(0).toISOString(),
      expiresAt: new Date(1).toISOString(),
    };
    store.set(KEY, JSON.stringify(expired));
    await maybeMigrateReceiptCommitment();
    expect(storedRecord()?.state).toBe("claimed");
  });
});

// ---------------------------------------------------------------------------
// Fresh derivation — commitment ≠ readiness
// ---------------------------------------------------------------------------

describe("deriveSetupAiStepState — lock survives credential loss; readiness fails closed", () => {
  async function committedWith(fingerprint: string | null) {
    const begun = beginSetupProviderClaim({
      provider: "anthropic",
      actorId: "a",
      startingCredentialFingerprint: fingerprint,
    });
    if (!begun.ok) throw new Error("claim failed");
    const committed = await commitSetupProviderClaim({
      nonce: begun.claim.nonce,
      credentialFingerprint: fingerprint,
      writeAuditedDefault: auditedWrite,
    });
    if (!committed.ok) throw new Error("commit failed");
  }

  it("no commitment → not locked, not ready", async () => {
    const state = await deriveSetupAiStepState();
    expect(state).toMatchObject({ locked: false, ready: false });
  });

  it("commitment + fresh fingerprint + readiness → ready", async () => {
    await committedWith("cfv1:aa");
    liveFingerprint.value = { status: "readable", fingerprint: "cfv1:aa" };
    readiness.ready = true;
    const state = await deriveSetupAiStepState();
    expect(state).toMatchObject({ locked: true, credentialFresh: true, ready: true });
  });

  it("credential ROTATION (fingerprint mismatch) reopens readiness while the lock STANDS", async () => {
    await committedWith("cfv1:aa");
    liveFingerprint.value = { status: "readable", fingerprint: "cfv1:ROTATED" };
    readiness.ready = true;
    const state = await deriveSetupAiStepState();
    expect(state).toMatchObject({ locked: true, credentialFresh: false, ready: false });
  });

  it("credential DELETION and an UNREADABLE surface both fail closed, lock intact", async () => {
    await committedWith("cfv1:aa");
    readiness.ready = true;
    liveFingerprint.value = { status: "absent" };
    expect(await deriveSetupAiStepState()).toMatchObject({
      locked: true,
      credentialFresh: false,
      ready: false,
    });
    liveFingerprint.value = { status: "unreadable", reason: "credential-read-failed" };
    expect(await deriveSetupAiStepState()).toMatchObject({
      locked: true,
      credentialFresh: false,
      ready: false,
    });
  });

  it("readiness evidence missing → locked but not ready (commitment ≠ readiness)", async () => {
    await committedWith("cfv1:aa");
    liveFingerprint.value = { status: "readable", fingerprint: "cfv1:aa" };
    readiness.ready = false;
    const state = await deriveSetupAiStepState();
    expect(state).toMatchObject({ locked: true, credentialFresh: true, ready: false });
  });
});

// ---------------------------------------------------------------------------
// Typed conflict class
// ---------------------------------------------------------------------------

describe("SetupProviderCommitConflictError", () => {
  it("is classified (carries its conflict kind) and instanceof-detectable", () => {
    const err = new SetupProviderCommitConflictError("claim-pending");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SetupProviderCommitConflictError");
    expect(err.conflict).toBe("claim-pending");
  });
});
