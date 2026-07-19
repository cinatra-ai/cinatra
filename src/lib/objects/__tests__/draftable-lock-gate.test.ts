// Draftable mutability lock gate (cinatra#1449 forward contract / #1457): the
// write-path enforcement that fails a content edit CLOSED when the publication
// ledger holds a locking operation for a draftable-claimed artifact. Deps are
// injected so the pure decision logic is tested with no DB / no ledger I/O.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import type { ArbitrableClaim } from "@cinatra-ai/objects/claims";
import type { PublicationOperationRow } from "@/lib/artifacts/publication-ledger-types";
import type { PublicationOperationState } from "@/lib/artifacts/publication-operation-state";
import {
  assertDraftableWriteAllowed,
  resolveWinningMutability,
  deriveLockState,
  DraftLockedError,
} from "@/lib/objects/draftable-lock-gate";

const TYPE = "@cinatra-ai/linkedin:post-draft";
const ORG = "org-1";
const ART = "artifact-1";

function claim(mutability: "draftable" | "record" | "external" | undefined): ArbitrableClaim {
  return {
    id: "claim-1",
    scope: "platform",
    objectTypeId: TYPE,
    claimKind: "dedicated",
    status: "active",
    extensionPackage: "@cinatra-ai/linkedin-artifacts",
    extensionVersion: "0.1.0",
    generation: 1,
    // A real claim's dispositions carry the required `projection` discriminant;
    // `mutability` is the orthogonal optional class this gate keys on.
    dispositions: mutability === undefined ? { projection: "artifact-safe" } : { projection: "artifact-safe", mutability },
  };
}

function op(state: PublicationOperationState): PublicationOperationRow {
  return {
    id: `op-${state}`,
    orgId: ORG,
    artifactId: ART,
    objectTypeId: TYPE,
    pinnedRepresentationRevisionId: "rev-1",
    destination: { connector: "@cinatra-ai/linkedin-connector", account: "acct-1", ref: null },
    dueAt: new Date().toISOString(),
    state,
    attempt: 0,
    idempotencyKey: "idem-1",
    cancellationGeneration: 0,
    receipt: state === "succeeded" ? { externalId: "urn:li:share:1", url: "https://x" } : null,
    error: null,
    createdBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    settledAt: null,
  };
}

function deps(mutability: "draftable" | "record" | "external" | undefined, ops: PublicationOperationRow[]) {
  return {
    readClaimsForOrg: vi.fn(() => (mutability === null ? [] : [claim(mutability)])) as never,
    listOperationsForArtifact: vi.fn(async () => ops),
  };
}

afterEach(() => {
  delete process.env.CINATRA_DISABLE_DRAFTABLE_LOCK_ENFORCEMENT;
});

describe("deriveLockState", () => {
  it("published (succeeded) dominates scheduled and locked", () => {
    expect(deriveLockState([op("failed"), op("pending"), op("succeeded")])).toBe("published");
  });
  it("scheduled (pending/running) when no succeeded", () => {
    expect(deriveLockState([op("failed"), op("running")])).toBe("scheduled");
    expect(deriveLockState([op("pending")])).toBe("scheduled");
  });
  it("locked when only a failed op", () => {
    expect(deriveLockState([op("failed")])).toBe("locked");
  });
  it("null when no ops or only cancelled ops", () => {
    expect(deriveLockState([])).toBeNull();
    expect(deriveLockState([op("cancelled"), op("cancelled")])).toBeNull();
  });
});

describe("resolveWinningMutability", () => {
  it("returns the winning claim's mutability", () => {
    expect(resolveWinningMutability(ORG, TYPE, () => [claim("draftable")])).toBe("draftable");
  });
  it("null for an unclaimed type", () => {
    expect(resolveWinningMutability(ORG, TYPE, () => [])).toBeNull();
  });
  it("null when the winning claim declares no mutability", () => {
    expect(resolveWinningMutability(ORG, TYPE, () => [claim(undefined)])).toBeNull();
  });
});

describe("assertDraftableWriteAllowed", () => {
  it("no-op for a non-draftable type — never reads the ledger", async () => {
    const d = deps("record", [op("succeeded")]);
    await expect(assertDraftableWriteAllowed({ orgId: ORG, objectTypeId: TYPE, artifactId: ART }, d)).resolves.toBeUndefined();
    expect(d.listOperationsForArtifact).not.toHaveBeenCalled();
  });

  it("allows a draftable write with NO publication operation (fresh/never-scheduled draft)", async () => {
    const d = deps("draftable", []);
    await expect(assertDraftableWriteAllowed({ orgId: ORG, objectTypeId: TYPE, artifactId: ART }, d)).resolves.toBeUndefined();
    expect(d.listOperationsForArtifact).toHaveBeenCalledWith(ORG, ART);
  });

  it("allows a draftable write when every operation is cancelled (unscheduled → editable)", async () => {
    const d = deps("draftable", [op("cancelled")]);
    await expect(assertDraftableWriteAllowed({ orgId: ORG, objectTypeId: TYPE, artifactId: ART }, d)).resolves.toBeUndefined();
  });

  it("rejects a content edit to a SCHEDULED draft (pending op)", async () => {
    const d = deps("draftable", [op("pending")]);
    await expect(
      assertDraftableWriteAllowed({ orgId: ORG, objectTypeId: TYPE, artifactId: ART }, d),
    ).rejects.toMatchObject({ code: "DRAFTABLE_LOCKED", lockState: "scheduled" });
  });

  it("rejects a content edit to a PUBLISHED draft (succeeded op)", async () => {
    const d = deps("draftable", [op("succeeded")]);
    await expect(
      assertDraftableWriteAllowed({ orgId: ORG, objectTypeId: TYPE, artifactId: ART }, d),
    ).rejects.toBeInstanceOf(DraftLockedError);
    await expect(
      assertDraftableWriteAllowed({ orgId: ORG, objectTypeId: TYPE, artifactId: ART }, d),
    ).rejects.toMatchObject({ lockState: "published" });
  });

  it("rejects a content edit to a FAILED (still-locked) draft", async () => {
    const d = deps("draftable", [op("failed")]);
    await expect(
      assertDraftableWriteAllowed({ orgId: ORG, objectTypeId: TYPE, artifactId: ART }, d),
    ).rejects.toMatchObject({ lockState: "locked" });
  });

  it("skips enforcement for a null org (dev-bypass sessionless-model path)", async () => {
    const d = deps("draftable", [op("succeeded")]);
    await expect(assertDraftableWriteAllowed({ orgId: null, objectTypeId: TYPE, artifactId: ART }, d)).resolves.toBeUndefined();
    expect(d.readClaimsForOrg).not.toHaveBeenCalled();
  });

  it("kill switch disables enforcement", async () => {
    process.env.CINATRA_DISABLE_DRAFTABLE_LOCK_ENFORCEMENT = "true";
    const d = deps("draftable", [op("succeeded")]);
    await expect(assertDraftableWriteAllowed({ orgId: ORG, objectTypeId: TYPE, artifactId: ART }, d)).resolves.toBeUndefined();
  });
});
