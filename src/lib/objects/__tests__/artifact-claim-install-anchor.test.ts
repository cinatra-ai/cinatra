import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Install-anchor claim-activation hook (cinatra#1493) — COMPOSITION proof with
// the lifecycle mocked (the real-DB proof lives in the sibling
// artifact-claim-install-anchor.integration.test.ts):
//   - fresh install (no live claims) routes through the REINSTALL replay (which
//     degrades to a plain install when no operation is owed);
//   - a re-fire whose live claims match the manifest is a NO-OP (no lifecycle
//     call at all — the reserve-always-INSERTs self-conflict never happens);
//   - a claim-set change routes through retire -> replay, never a raw second
//     activate;
//   - a lifecycle throw (conflict or otherwise) NEVER propagates — the anchor
//     rides the finalized install pipeline, so the hook returns a 'failed'
//     outcome instead (the pipeline must not roll back a finalized install).

vi.mock("@/lib/objects/artifact-claim-lifecycle", () => {
  class ArtifactClaimConflictError extends Error {
    constructor(
      public readonly scope: string,
      public readonly objectTypeId: string,
    ) {
      super(`conflict ${objectTypeId}@${scope}`);
      this.name = "ArtifactClaimConflictError";
    }
  }
  return {
    ArtifactClaimConflictError,
    retireArtifactExtensionClaims: vi.fn(),
    replayArtifactExtensionReinstall: vi.fn(),
  };
});
vi.mock("@/lib/objects/artifact-claim-store", () => ({
  readArtifactTypeClaimsForExtension: vi.fn(() => []),
}));
vi.mock("@/lib/objects/artifact-uninstall-operations", () => ({
  findReplayableUninstallOperation: vi.fn(() => null),
  replayArtifactUninstallOperation: vi.fn(() => ({ insertedAssertions: 0, skipped: 0 })),
}));
// The boot backstop resolves canonical rows dynamically; server-only is mocked
// so the REAL pickSingleActiveRow (extension-install-anchor) drives the
// per-scope row pick in the backstop tests below.
vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: vi.fn(),
}));

import {
  ArtifactClaimConflictError,
  replayArtifactExtensionReinstall,
  retireArtifactExtensionClaims,
} from "@/lib/objects/artifact-claim-lifecycle";
import { readArtifactTypeClaimsForExtension } from "@/lib/objects/artifact-claim-store";
import {
  findReplayableUninstallOperation,
  replayArtifactUninstallOperation,
} from "@/lib/objects/artifact-uninstall-operations";
import { readInstalledExtensionsByPackageName } from "@cinatra-ai/extensions/canonical-store";
import {
  readInstallAnchorManifestClaims,
  runInstallAnchorClaimActivation,
  runInstallAnchorClaimBackstop,
} from "@/lib/objects/artifact-claim-install-anchor";

const INPUT = {
  scope: "org:org-1",
  extensionPackage: "@v/pkg-artifact",
  extensionVersion: "1.0.0",
  installId: "inst-1",
  claims: [
    { type: "@v/pkg:thing", claim: "dedicated" as const, dispositions: { projection: "raw" as const } },
    { type: "@v/pkg:other", claim: "default" as const },
  ],
  resolveTypeValidator: () => () => true,
};

/** A live registry row matching INPUT.claims[i] (dispositions as reserve-time
 * zod parsing stores them — schema defaults applied). */
function liveRow(i: 0 | 1, status = "active") {
  return i === 0
    ? {
        id: "c1",
        scope: "org:org-1",
        objectTypeId: "@v/pkg:thing",
        claimKind: "dedicated",
        status,
        dispositions: {
          projection: "raw",
          pinnable: false,
          snapshotPolicy: "none",
          sensitivity: "normal",
        },
      }
    : {
        id: "c2",
        scope: "org:org-1",
        objectTypeId: "@v/pkg:other",
        claimKind: "default",
        status,
        dispositions: null,
      };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readArtifactTypeClaimsForExtension).mockReturnValue([]);
  vi.mocked(findReplayableUninstallOperation).mockReturnValue(null);
  vi.mocked(replayArtifactUninstallOperation).mockReturnValue({ insertedAssertions: 0, skipped: 0 });
  vi.mocked(replayArtifactExtensionReinstall).mockReturnValue({
    replayedOperationId: null,
    insertedAssertions: 0,
    skippedAssertions: 0,
    activated: [
      { claimId: "c1", type: "@v/pkg:thing", claim: "dedicated" },
      { claimId: "c2", type: "@v/pkg:other", claim: "default" },
    ],
  } as never);
  vi.mocked(retireArtifactExtensionClaims).mockReturnValue({
    operationId: "op1",
    archivedAssertions: 0,
    processedArtifacts: 0,
    retiredClaims: ["c1", "c2"],
  } as never);
});

describe("runInstallAnchorClaimActivation — routing", () => {
  it("fresh install (no live claims) activates via the reinstall replay path", () => {
    const res = runInstallAnchorClaimActivation(INPUT);
    expect(res).toEqual({ outcome: "activated", activatedClaims: 2, replayedOperationIds: [] });
    expect(replayArtifactExtensionReinstall).toHaveBeenCalledTimes(1);
    const [ctx, claims] = vi.mocked(replayArtifactExtensionReinstall).mock.calls[0];
    expect(ctx).toMatchObject({
      scope: "org:org-1",
      extensionPackage: "@v/pkg-artifact",
      extensionVersion: "1.0.0",
      actor: "system",
      installId: "inst-1",
    });
    expect(typeof ctx.resolveTypeValidator).toBe("function");
    expect(claims).toBe(INPUT.claims);
    expect(retireArtifactExtensionClaims).not.toHaveBeenCalled();
  });

  it("re-fire with live claims matching the manifest is a NO-OP (no lifecycle call)", () => {
    vi.mocked(readArtifactTypeClaimsForExtension).mockReturnValue([
      liveRow(0),
      liveRow(1),
    ] as never);
    const res = runInstallAnchorClaimActivation(INPUT);
    expect(res).toEqual({
      outcome: "noop",
      reason: "live-claims-match",
      liveClaims: 2,
      replayedOperationIds: [],
    });
    expect(replayArtifactExtensionReinstall).not.toHaveBeenCalled();
    expect(retireArtifactExtensionClaims).not.toHaveBeenCalled();
  });

  it("a dominated default ('dormant') still counts as live+matching", () => {
    vi.mocked(readArtifactTypeClaimsForExtension).mockReturnValue([
      liveRow(0),
      liveRow(1, "dormant"),
    ] as never);
    expect(runInstallAnchorClaimActivation(INPUT).outcome).toBe("noop");
  });

  it("rollback-to-prior-version re-fire (different version, same claims) is a NO-OP", () => {
    vi.mocked(readArtifactTypeClaimsForExtension).mockReturnValue([
      liveRow(0),
      liveRow(1),
    ] as never);
    const res = runInstallAnchorClaimActivation({ ...INPUT, extensionVersion: "0.9.0" });
    expect(res).toEqual({
      outcome: "noop",
      reason: "live-claims-match",
      liveClaims: 2,
      replayedOperationIds: [],
    });
  });

  it("a claim-set CHANGE routes through retire -> replay (never a raw second activate)", () => {
    vi.mocked(readArtifactTypeClaimsForExtension).mockReturnValue([liveRow(0)] as never);
    const res = runInstallAnchorClaimActivation(INPUT); // manifest now has 2 claims
    expect(res).toEqual({
      outcome: "rewired",
      retiredClaims: 2,
      activatedClaims: 2,
      replayedOperationIds: [],
    });
    expect(retireArtifactExtensionClaims).toHaveBeenCalledTimes(1);
    expect(replayArtifactExtensionReinstall).toHaveBeenCalledTimes(1);
  });

  it("a dispositions change alone routes through retire -> replay", () => {
    vi.mocked(readArtifactTypeClaimsForExtension).mockReturnValue([
      { ...liveRow(0), dispositions: { projection: "artifact-safe", pinnable: false } },
      liveRow(1),
    ] as never);
    expect(runInstallAnchorClaimActivation(INPUT).outcome).toBe("rewired");
  });

  it("a stuck 'reserved'/'retiring' claim is NOT healthy-matching — repaired via retire -> replay", () => {
    vi.mocked(readArtifactTypeClaimsForExtension).mockReturnValue([
      liveRow(0, "reserved"),
      liveRow(1),
    ] as never);
    expect(runInstallAnchorClaimActivation(INPUT).outcome).toBe("rewired");
  });

  it("a manifest that DROPPED all claims retires the live set (rewired to zero)", () => {
    vi.mocked(readArtifactTypeClaimsForExtension).mockReturnValue([
      liveRow(0),
      liveRow(1),
    ] as never);
    vi.mocked(replayArtifactExtensionReinstall).mockReturnValue({
      replayedOperationId: "op1",
      insertedAssertions: 0,
      skippedAssertions: 0,
      activated: [],
    } as never);
    const res = runInstallAnchorClaimActivation({ ...INPUT, claims: [] });
    expect(res).toMatchObject({ outcome: "rewired", activatedClaims: 0 });
    expect(retireArtifactExtensionClaims).toHaveBeenCalledTimes(1);
  });

  it("retired rows are ignored; no claims + no live rows is a NO-OP", () => {
    vi.mocked(readArtifactTypeClaimsForExtension).mockReturnValue([
      { ...liveRow(0), status: "retired" },
    ] as never);
    const res = runInstallAnchorClaimActivation({ ...INPUT, claims: [] });
    expect(res).toEqual({
      outcome: "noop",
      reason: "no-claims",
      liveClaims: 0,
      replayedOperationIds: [],
    });
    expect(retireArtifactExtensionClaims).not.toHaveBeenCalled();
    expect(replayArtifactExtensionReinstall).not.toHaveBeenCalled();
  });
});

describe("runInstallAnchorClaimActivation — owed-replay drain (codex findings)", () => {
  it("an owed operation is drained even when the manifest has ZERO claims and none are live", () => {
    vi.mocked(findReplayableUninstallOperation)
      .mockReturnValueOnce({ id: "opA" } as never)
      .mockReturnValue(null);
    const res = runInstallAnchorClaimActivation({ ...INPUT, claims: [] });
    expect(res).toEqual({
      outcome: "noop",
      reason: "no-claims",
      liveClaims: 0,
      replayedOperationIds: ["opA"],
    });
    expect(replayArtifactUninstallOperation).toHaveBeenCalledWith({
      operationId: "opA",
      installId: "inst-1",
    });
  });

  it("ALL owed operations are drained, not just the latest (stranded-op retry safety)", () => {
    // op B (newest, empty from a retried retire) + op A (older, carries the
    // archived assertions) are BOTH owed — a latest-only replay would consume
    // B and strand A forever.
    vi.mocked(findReplayableUninstallOperation)
      .mockReturnValueOnce({ id: "opB" } as never)
      .mockReturnValueOnce({ id: "opA" } as never)
      .mockReturnValue(null);
    const res = runInstallAnchorClaimActivation(INPUT);
    expect(res).toEqual({
      outcome: "activated",
      activatedClaims: 2,
      replayedOperationIds: ["opB", "opA"],
    });
    expect(replayArtifactUninstallOperation).toHaveBeenCalledTimes(2);
  });

  it("a live-claims-match re-fire that drained an owed operation FORCES the rewire route (binding lineage is never replayed as classic — only reactivation re-enqueues its reconcile)", () => {
    vi.mocked(readArtifactTypeClaimsForExtension).mockReturnValue([
      liveRow(0),
      liveRow(1),
    ] as never);
    vi.mocked(findReplayableUninstallOperation)
      .mockReturnValueOnce({ id: "opA" } as never)
      .mockReturnValue(null);
    const res = runInstallAnchorClaimActivation(INPUT);
    expect(res).toEqual({
      outcome: "rewired",
      retiredClaims: 2,
      activatedClaims: 2,
      replayedOperationIds: ["opA"],
    });
    expect(retireArtifactExtensionClaims).toHaveBeenCalledTimes(1);
    expect(replayArtifactExtensionReinstall).toHaveBeenCalledTimes(1);
  });

  it("a NON-PROGRESSING drain (replay did not stamp the op) fails the hook, never loops or proceeds silently", () => {
    // The same op stays owed after its replay — a store regression; the drain
    // must detect the missing monotonic progress and fail, not spin or skip.
    vi.mocked(findReplayableUninstallOperation).mockReturnValue({ id: "op-stuck" } as never);
    const res = runInstallAnchorClaimActivation(INPUT);
    expect(res).toMatchObject({ outcome: "failed", conflict: false });
    expect((res as { reason: string }).reason).toMatch(/not progressing/);
    expect(replayArtifactUninstallOperation).toHaveBeenCalledTimes(1);
    expect(replayArtifactExtensionReinstall).not.toHaveBeenCalled();
  });

  it("a LONG legitimate owed history (30 ops) drains fully — no arbitrary cap strands the tail", () => {
    const ops = Array.from({ length: 30 }, (_, i) => ({ id: `op-${i}` }));
    let cursor = 0;
    vi.mocked(findReplayableUninstallOperation).mockImplementation(
      () => (cursor < ops.length ? (ops[cursor++] as never) : null),
    );
    const res = runInstallAnchorClaimActivation(INPUT);
    expect(res).toMatchObject({ outcome: "activated", activatedClaims: 2 });
    expect((res as { replayedOperationIds: string[] }).replayedOperationIds).toHaveLength(30);
    expect(replayArtifactUninstallOperation).toHaveBeenCalledTimes(30);
  });

  it("the rewire route drains the retire's own archival operation before reinstall", () => {
    vi.mocked(readArtifactTypeClaimsForExtension).mockReturnValue([liveRow(0)] as never);
    // Nothing owed pre-retire; the retire opens op1, which the post-retire
    // drain consumes BEFORE replayArtifactExtensionReinstall runs.
    vi.mocked(findReplayableUninstallOperation)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ id: "op1" } as never)
      .mockReturnValue(null);
    const res = runInstallAnchorClaimActivation(INPUT);
    expect(res).toEqual({
      outcome: "rewired",
      retiredClaims: 2,
      activatedClaims: 2,
      replayedOperationIds: ["op1"],
    });
    const retireOrder = vi.mocked(retireArtifactExtensionClaims).mock.invocationCallOrder[0];
    const drainOrder = vi.mocked(replayArtifactUninstallOperation).mock.invocationCallOrder[0];
    const reinstallOrder = vi.mocked(replayArtifactExtensionReinstall).mock.invocationCallOrder[0];
    expect(retireOrder).toBeLessThan(drainOrder);
    expect(drainOrder).toBeLessThan(reinstallOrder);
  });
});

describe("runInstallAnchorClaimActivation — never throws at the anchor", () => {
  it("a claim CONFLICT surfaces as outcome 'failed' with conflict:true, not a throw", () => {
    vi.mocked(replayArtifactExtensionReinstall).mockImplementation(() => {
      throw new ArtifactClaimConflictError("org:org-1", "@v/pkg:thing");
    });
    const res = runInstallAnchorClaimActivation(INPUT);
    expect(res).toMatchObject({ outcome: "failed", conflict: true });
  });

  it("any other lifecycle error surfaces as outcome 'failed' with conflict:false", () => {
    vi.mocked(readArtifactTypeClaimsForExtension).mockImplementation(() => {
      throw new Error("db down");
    });
    const res = runInstallAnchorClaimActivation(INPUT);
    expect(res).toEqual({ outcome: "failed", conflict: false, reason: "db down" });
  });
});

describe("readInstallAnchorManifestClaims", () => {
  function writePkg(cinatra: unknown, name = "@v/pkg-artifact"): string {
    const dir = mkdtempSync(path.join(tmpdir(), "anchor-claims-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, cinatra }));
    return dir;
  }

  it("maps a valid artifact manifest's objectTypes to lifecycle claims (schema dropped)", async () => {
    const dir = writePkg({
      kind: "artifact",
      artifact: {
        accepts: { dashboard: true },
        objectTypes: [
          {
            type: "@v/pkg:thing",
            claim: "dedicated",
            dispositions: { projection: "raw" },
            schema: { type: "object" },
          },
        ],
      },
    });
    // The semantic-manifest parse applies the dispositions schema defaults —
    // the SAME normalization reserve-time storage applies, which is what keeps
    // the re-fire diff stable.
    expect(await readInstallAnchorManifestClaims(dir)).toEqual([
      {
        type: "@v/pkg:thing",
        claim: "dedicated",
        dispositions: {
          projection: "raw",
          pinnable: false,
          snapshotPolicy: "none",
          sensitivity: "normal",
        },
      },
    ]);
  });

  it("a valid artifact manifest with NO objectTypes yields [] (claims dropped => retire route upstream)", async () => {
    const dir = writePkg({ kind: "artifact", artifact: { accepts: { dashboard: true } } });
    expect(await readInstallAnchorManifestClaims(dir)).toEqual([]);
  });

  it("a non-artifact package / invalid manifest / unreadable dir yields null", async () => {
    expect(
      await readInstallAnchorManifestClaims(writePkg({ kind: "connector" })),
    ).toBeNull();
    expect(
      await readInstallAnchorManifestClaims(writePkg({ kind: "artifact", artifact: { artifactType: {} } })),
    ).toBeNull();
    expect(await readInstallAnchorManifestClaims("/nonexistent-dir")).toBeNull();
  });
});

describe("runInstallAnchorClaimBackstop — boot re-drive of failed activations", () => {
  function writeArtifactPkg(name: string, version = "1.2.3"): string {
    const dir = mkdtempSync(path.join(tmpdir(), "anchor-backstop-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name,
        version,
        cinatra: {
          kind: "artifact",
          artifact: {
            accepts: { dashboard: true },
            objectTypes: [{ type: "@v/pkg:thing", claim: "dedicated" }],
          },
        },
      }),
    );
    return dir;
  }

  const canonicalRow = (over: Record<string, unknown> = {}) => ({
    id: "row-1",
    kind: "artifact",
    status: "active",
    organizationId: null,
    // Updates rewrite source.version on the SAME row; the version column can
    // lag — the fence + provenance must read source.version (codex round-5).
    source: { type: "verdaccio", version: "1.2.3" },
    version: "1.2.3",
    isDefault: true,
    ...over,
  });

  it("fires the idempotent hook once per (package, live scope) with the canonical row's resolved version + install id", async () => {
    const dir = writeArtifactPkg("@v/pkg-artifact");
    vi.mocked(readInstalledExtensionsByPackageName).mockResolvedValueOnce([
      canonicalRow(),
      canonicalRow({ id: "row-2", organizationId: "org-9" }),
    ] as never);
    vi.mocked(replayArtifactExtensionReinstall).mockReturnValue({
      replayedOperationId: null,
      insertedAssertions: 0,
      skippedAssertions: 0,
      activated: [{ claimId: "c1", type: "@v/pkg:thing", claim: "dedicated" }],
    } as never);

    const res = await runInstallAnchorClaimBackstop([
      { packageName: "@v/pkg-artifact", storeDir: dir },
    ]);
    expect(res).toEqual({ converged: 2, failed: 0, skipped: 0 });
    const contexts = vi
      .mocked(replayArtifactExtensionReinstall)
      .mock.calls.map(([ctx]) => ctx as { scope: string; extensionVersion: string; installId: string | null });
    expect(contexts.map((c) => c.scope).sort()).toEqual(["org:org-9", "platform"]);
    expect(contexts.every((c) => c.extensionVersion === "1.2.3")).toBe(true);
    expect(contexts.map((c) => c.installId).sort()).toEqual(["row-1", "row-2"]);
  });

  it("skips: unreadable manifest dir, no live rows (CG-1 ungoverned), non-artifact row kind, ambiguous scope pick", async () => {
    const dir = writeArtifactPkg("@v/pkg-artifact");
    vi.mocked(readInstalledExtensionsByPackageName)
      .mockResolvedValueOnce([] as never) // no rows
      .mockResolvedValueOnce([canonicalRow({ kind: "connector" })] as never) // wrong kind
      .mockResolvedValueOnce([canonicalRow(), canonicalRow({ id: "row-dup" })] as never); // 2 defaults in one scope → fail-closed pick
    const res = await runInstallAnchorClaimBackstop([
      { packageName: "@v/none", storeDir: "/nonexistent-dir" },
      { packageName: "@v/pkg-artifact", storeDir: dir },
      { packageName: "@v/pkg-artifact", storeDir: dir },
      { packageName: "@v/pkg-artifact", storeDir: dir },
    ]);
    expect(res).toEqual({ converged: 0, failed: 0, skipped: 4 });
    expect(replayArtifactExtensionReinstall).not.toHaveBeenCalled();
  });

  it("stale-record fence (codex round-4/5 High): a row whose LIVE provenance (source.version) moved past the rescan-vetted manifest is SKIPPED — never activates stale claims under fresh provenance", async () => {
    const dir = writeArtifactPkg("@v/pkg-artifact", "1.0.0");
    vi.mocked(readInstalledExtensionsByPackageName).mockResolvedValueOnce([
      // Concurrent update finalized v2: the pipeline tail rewrote
      // source.version on the SAME row; the version column lags at v1 —
      // exactly the production shape (the column alone would MISS this).
      canonicalRow({ source: { type: "verdaccio", version: "2.0.0" }, version: "1.0.0" }),
    ] as never);
    const res = await runInstallAnchorClaimBackstop([
      { packageName: "@v/pkg-artifact", storeDir: dir },
    ]);
    expect(res).toEqual({ converged: 0, failed: 0, skipped: 1 });
    expect(replayArtifactExtensionReinstall).not.toHaveBeenCalled();
    expect(retireArtifactExtensionClaims).not.toHaveBeenCalled();
  });

  it("a PRESENT-but-malformed manifest version fails CLOSED (skip, no lifecycle call) — never conflated with an absent field that would degrade the fence open (codex round-6)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "anchor-backstop-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "@v/pkg-artifact",
        version: 123, // present, malformed
        cinatra: {
          kind: "artifact",
          artifact: {
            accepts: { dashboard: true },
            objectTypes: [{ type: "@v/pkg:thing", claim: "dedicated" }],
          },
        },
      }),
    );
    const res = await runInstallAnchorClaimBackstop([
      { packageName: "@v/pkg-artifact", storeDir: dir },
    ]);
    // Fail-closed BEFORE any canonical-row read: the manifest itself is
    // treated as invalid (no rows enqueued here on purpose — the read must
    // never happen).
    expect(res).toEqual({ converged: 0, failed: 0, skipped: 1 });
    expect(readInstalledExtensionsByPackageName).not.toHaveBeenCalled();
    expect(replayArtifactExtensionReinstall).not.toHaveBeenCalled();
    expect(retireArtifactExtensionClaims).not.toHaveBeenCalled();
  });

  it("stale-record fence inverse: a lagging version COLUMN never false-skips when source.version matches the vetted manifest — and provenance records source.version", async () => {
    const dir = writeArtifactPkg("@v/pkg-artifact", "2.0.0");
    vi.mocked(readInstalledExtensionsByPackageName).mockResolvedValueOnce([
      canonicalRow({ source: { type: "verdaccio", version: "2.0.0" }, version: "1.0.0" }),
    ] as never);
    vi.mocked(replayArtifactExtensionReinstall).mockReturnValue({
      replayedOperationId: null,
      insertedAssertions: 0,
      skippedAssertions: 0,
      activated: [],
    } as never);
    const res = await runInstallAnchorClaimBackstop([
      { packageName: "@v/pkg-artifact", storeDir: dir },
    ]);
    expect(res).toEqual({ converged: 1, failed: 0, skipped: 0 });
    const [ctx] = vi.mocked(replayArtifactExtensionReinstall).mock.calls[0];
    expect((ctx as { extensionVersion: string }).extensionVersion).toBe("2.0.0");
  });

  it("isolates failures: a throwing package (or a 'failed' hook outcome) is counted and the rest still converge — never throws", async () => {
    const dir = writeArtifactPkg("@v/pkg-artifact");
    vi.mocked(readInstalledExtensionsByPackageName)
      .mockRejectedValueOnce(new Error("canonical store down")) // package 1 throws
      .mockResolvedValueOnce([canonicalRow()] as never) // package 2: hook 'failed'
      .mockResolvedValueOnce([canonicalRow()] as never); // package 3: converges
    vi.mocked(replayArtifactExtensionReinstall)
      .mockImplementationOnce(() => {
        throw new ArtifactClaimConflictError("platform", "@v/pkg:thing");
      })
      .mockReturnValueOnce({
        replayedOperationId: null,
        insertedAssertions: 0,
        skippedAssertions: 0,
        activated: [],
      } as never);

    const res = await runInstallAnchorClaimBackstop([
      { packageName: "@v/pkg-a", storeDir: dir },
      { packageName: "@v/pkg-b", storeDir: dir },
      { packageName: "@v/pkg-c", storeDir: dir },
    ]);
    expect(res).toEqual({ converged: 1, failed: 2, skipped: 0 });
  });
});
