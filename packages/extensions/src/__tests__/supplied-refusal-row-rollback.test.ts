// A REFUSED SUPPLIED INSTALL LEAVES NO ROW (cinatra#3204 criterion 23).
//
// The refusal measured on the real screen: a supplied CONNECTOR package that
// ships no `cinatra/config.json` is refused by name and the message states that
// "the placeholder install row was rolled back" — while the canonical row for
// that package stayed ACTIVE in the database after every attempt. The claim was
// false, which is worse than the refusal itself: the operator is told the
// instance is clean and it is not.
//
// The cause is the non-finalized predicate, not the dispatcher. A SUPPLIED row
// carries no `integrity` field — its root of trust is the content digest — and
// the predicate treated EVERY integrity-less row as "a non-pipeline source
// (github/local) — leave it". That shortcut predates the supplied road: since
// leg 1 a supplied row IS pipeline-driven, so the rollback skipped exactly the
// rows it exists for, at both gates (the dispatcher's own re-read guard and the
// lifecycle primitive's self-guard, which share this one predicate).
//
// Pinned per kind, because all four kinds route their pre-finalize refusal
// through the SAME `rollbackNonFinalizedCanonicalRow` gate: connector through
// the activate hook's `finalized:false`, agent/skill/artifact through the store
// pipeline's `finalized:false`.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = {
  id: string;
  packageName: string;
  status: string;
  ownerLevel?: string;
  ownerId?: string | null;
  organizationId: string | null;
  source: Record<string, unknown> | null;
};
let rows: Row[] = [];

const installExtensionManifest = vi.fn(async (row: Row) => {
  rows.push({ ...row });
  return row;
});
const dropRow = vi.fn(async (id: string) => {
  rows = rows.filter((r) => r.id !== id);
});
const readInstalledExtensionById = vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null);
const readInstalledExtensionsByPackageName = vi.fn(async (pkg: string) =>
  rows.filter((r) => r.packageName === pkg),
);

vi.mock("@cinatra-ai/agents", () => ({
  withInstallLock: async (_packageName: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...a: unknown[]) =>
    readInstalledExtensionsByPackageName(...(a as [string])),
  readInstalledExtensionById: (...a: unknown[]) => readInstalledExtensionById(...(a as [string])),
  listInstalledExtensions: vi.fn(async (): Promise<unknown[]> => []),
  readEffectiveStatusByPackageNames: vi.fn(async () => new Map()),
}));

vi.mock("../lifecycle-primitive", () => ({
  installExtensionManifest: (...a: unknown[]) => installExtensionManifest(...(a as [Row])),
  supersedeOrganizationRowsForWorkspaceInstall: vi.fn(async () => [] as string[]),
  transitionExtensionLifecycle: vi.fn(async () => null),
  // The REAL primitive self-enforces its "non-finalized only" contract through
  // the same predicate this suite is about, so the mock consults the REAL
  // predicate rather than a hand-written mirror: a fix that only reaches the
  // dispatcher's own guard and not the primitive's would still fail here.
  deleteNonFinalizedCanonicalRow: async (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    const { isNonFinalizedLiveRowAware } = await import("../non-finalized-row");
    const nonFinalized = await isNonFinalizedLiveRowAware({
      status: row.status,
      source: row.source,
      packageName: row.packageName,
      organizationId: row.organizationId,
    });
    if (!nonFinalized) {
      throw new Error(
        `deleteNonFinalizedCanonicalRow refused — '${id}' is not a non-finalized placeholder`,
      );
    }
    await dropRow(id);
  },
}));

vi.mock("../required-in-prod", () => ({
  isPackageRequiredInProd: () => false,
  checkRequiredExtensionVersionPin: () => ({ ok: true }),
}));

const fireExtensionActivate = vi.fn();
vi.mock("../activate-hook", () => ({
  fireExtensionActivate: (...a: unknown[]) =>
    fireExtensionActivate(...(a as [string, string | null, string | undefined])),
}));

import { extensionRegistry } from "../index";
import { isNonFinalizedLiveRow, isNonFinalizedLiveRowAware } from "../non-finalized-row";
import { makeHandler } from "./__mocks__/extension-handler";
import type { Actor, PackageRef } from "../index";

const DIGEST = "a".repeat(64);
const STORE_DIGEST = "c".repeat(128);
const SHA = "b".repeat(40);

const actor: Actor = {
  actorType: "system",
  userId: "u1",
  source: "worker",
  orgId: "org-1",
  orgRole: "org_admin",
};

const localRef = (packageName: string): PackageRef =>
  ({
    registryUrl: "https://registry.example.com",
    packageName,
    version: "1.0.0",
    provenance: { type: "local", path: "snapshots/thing.tgz", contentDigest: DIGEST },
  }) as PackageRef;

const githubRef = (packageName: string): PackageRef =>
  ({
    registryUrl: "https://registry.example.com",
    packageName,
    version: "1.0.0",
    provenance: {
      type: "github",
      repo: "owner/repo",
      ref: "v1.0.0",
      resolvedSha: SHA,
      contentDigest: DIGEST,
    },
  }) as PackageRef;

beforeEach(() => {
  extensionRegistry._resetForTesting();
  rows = [];
  vi.clearAllMocks();
  // Every case in this file is the REFUSAL: the pipeline ran and did NOT
  // finalize (the connector package shipped no real-integrity payload).
  fireExtensionActivate.mockResolvedValue({ finalized: false, reason: "no-config" });
});

describe("a supplied install the pipeline refuses leaves NO canonical row", () => {
  for (const kind of ["connector", "agent", "skill", "artifact"] as const) {
    it(`${kind}: a refused LOCAL supplied install removes the placeholder row`, async () => {
      const packageName = `@acme/refused-${kind}`;
      extensionRegistry.register(makeHandler(kind));

      await expect(
        extensionRegistry.install(kind, localRef(packageName), actor),
      ).rejects.toThrow(/did not finalize/);

      expect(rows.filter((r) => r.packageName === packageName)).toEqual([]);
    });
  }

  it("connector: a refused GITHUB supplied install removes the placeholder row", async () => {
    const packageName = "@acme/refused-github-connector";
    extensionRegistry.register(makeHandler("connector"));

    await expect(
      extensionRegistry.install("connector", githubRef(packageName), actor),
    ).rejects.toThrow(/did not finalize/);

    expect(rows.filter((r) => r.packageName === packageName)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The predicate itself — the supplied road's finalize marker, and the
// pre-#3204 rows it must keep its hands off.
// ---------------------------------------------------------------------------
describe("the non-finalized signal on a supplied row", () => {
  const live = (source: Record<string, unknown>) => ({ status: "active", source });

  it("a supplied row with no active digest is non-finalized (the placeholder)", () => {
    expect(
      isNonFinalizedLiveRow(
        live({ type: "local", path: "x.tgz", resolvedCommitOrTreeHash: DIGEST, contentDigest: DIGEST }),
      ),
    ).toBe(true);
  });

  it("a supplied row the pipeline finalized (active digest present) is left alone", () => {
    expect(
      isNonFinalizedLiveRow(
        live({
          type: "local",
          path: "x.tgz",
          resolvedCommitOrTreeHash: DIGEST,
          contentDigest: DIGEST,
          activeDigest: STORE_DIGEST,
        }),
      ),
    ).toBe(false);
  });

  it("a PRE-#3204 github/local row (no content digest) keeps its handler-owned handling", async () => {
    const row = live({ type: "local", path: "x.tgz", resolvedCommitOrTreeHash: SHA });
    expect(isNonFinalizedLiveRow(row)).toBe(false);
    await expect(
      isNonFinalizedLiveRowAware({ ...row, packageName: "@acme/legacy-skill", organizationId: null }),
    ).resolves.toBe(false);
  });

  it("an archived supplied placeholder is not live, so it is not rollbackable here", () => {
    expect(
      isNonFinalizedLiveRow({
        status: "archived",
        source: { type: "local", path: "x.tgz", resolvedCommitOrTreeHash: DIGEST, contentDigest: DIGEST },
      }),
    ).toBe(false);
  });
});
