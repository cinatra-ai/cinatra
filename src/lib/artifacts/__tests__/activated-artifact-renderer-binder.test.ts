import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// ACTIVATION-COUPLED per-org representation-provider binding (cinatra#2044 S6
// L-A3). These pin the two contracts that had to hold TOGETHER:
//
//   #2044  — an org that INSTALLED the CMS-snapshot renderer resolves it, so the
//            review target renders instead of flooring.
//   #1630  — no activation-without-install (a merely bundled/dev-enrolled pack is
//            inert; another org sees nothing) and clean uninstall isolation
//            (the binding is retired, and a delayed straggler cannot resurrect it).
// ---------------------------------------------------------------------------

import {
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";

import {
  activatableRendererPackages,
  activatedRepresentationProviderSpecs,
  bindActivatedRepresentationProvidersForInstall,
  ensureActivatedRepresentationProviders,
  generationForEpoch,
  installEpochToken,
  pickGoverningRow,
  reconcileActivatedRepresentationProviders,
  _resetActivatedGenerationsForTests,
  type GoverningInstallRow,
} from "@/lib/artifacts/activated-artifact-renderer-binder";
import {
  systemRepresentationProviderSpecs,
  reconcileSystemRepresentationProviders,
} from "@/lib/artifacts/system-artifact-renderer-registrar";
import { GENERATED_ARTIFACT_RENDERERS } from "@/lib/generated/artifact-renderers";

const CMS_PKG = "@cinatra-ai/cms-snapshot-artifact";
const CMS_MIME = "application/vnd.cinatra.cms-fields+json";
const ORG = "org-installed";
const OTHER_ORG = "org-never-installed";

// The canonical-store batch reader is dynamically imported inside the reconcile,
// so the module mock intercepts it.
const readByNames = vi.fn<
  (names: readonly string[]) => Promise<Map<string, GoverningInstallRow[]>>
>();
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageNames: (names: readonly string[]) => readByNames(names),
}));

function liveRow(over: Partial<GoverningInstallRow> = {}): GoverningInstallRow {
  return {
    id: "install-1",
    kind: "artifact",
    status: "active",
    version: "0.1.0",
    organizationId: ORG,
    updatedAt: new Date("2026-07-26T10:00:00.000Z"),
    ...over,
  };
}

function rowsFor(rows: GoverningInstallRow[]): Map<string, GoverningInstallRow[]> {
  return new Map([[CMS_PKG, rows]]);
}

beforeEach(() => {
  representationProviderRegistry._clearForTests(true);
  _resetActivatedGenerationsForTests();
  readByNames.mockReset();
  readByNames.mockResolvedValue(new Map());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("spec projection — fail-closed narrowings (#1630)", () => {
  it("projects the CMS pack's EXACT MIME at both declared slots", () => {
    const specs = activatedRepresentationProviderSpecs(CMS_PKG);
    expect(specs.map((s) => `${s.pattern}@${s.slot}`).sort()).toEqual([
      `${CMS_MIME}@detail`,
      `${CMS_MIME}@preview`,
    ]);
  });

  it("only guardedOptional packages are activatable — no `required` base leaks in", () => {
    const activatable = new Set(activatableRendererPackages());
    for (const entry of Object.values(GENERATED_ARTIFACT_RENDERERS)) {
      if (entry.resolution === "required") {
        expect(activatable.has(entry.packageName)).toBe(false);
      }
    }
    expect(activatable.has(CMS_PKG)).toBe(true);
  });

  it("a `required` package projects NO activated specs (system registrar keeps sole ownership)", () => {
    for (const entry of Object.values(GENERATED_ARTIFACT_RENDERERS)) {
      if (entry.resolution !== "required") continue;
      expect(activatedRepresentationProviderSpecs(entry.packageName)).toEqual([]);
    }
  });

  it("a package absent from the build map projects nothing (specs are never caller-supplied)", () => {
    expect(activatedRepresentationProviderSpecs("@evil/not-built-artifact")).toEqual([]);
  });

  it("no activated spec collides with a system base's claimed (mime, slot)", () => {
    const systemClaims = new Set(
      systemRepresentationProviderSpecs().map((s) => `${s.pattern}@${s.slot}`),
    );
    for (const pkg of activatableRendererPackages()) {
      for (const spec of activatedRepresentationProviderSpecs(pkg)) {
        expect(systemClaims.has(`${spec.pattern}@${spec.slot}`)).toBe(false);
      }
    }
  });
});

describe("governing-row pick", () => {
  it("prefers the org-owned live row, then an ambient row, and never another org's", () => {
    expect(pickGoverningRow([liveRow()], ORG)?.organizationId).toBe(ORG);
    expect(pickGoverningRow([liveRow({ organizationId: null })], ORG)?.organizationId).toBeNull();
    expect(pickGoverningRow([liveRow({ organizationId: "org-x" })], ORG)).toBeNull();
  });

  it("`archived` is not live; `locked` is", () => {
    expect(pickGoverningRow([liveRow({ status: "archived" })], ORG)).toBeNull();
    expect(pickGoverningRow([liveRow({ status: "locked" })], ORG)).not.toBeNull();
  });

  it("a non-artifact-kind row never governs an artifact renderer", () => {
    expect(pickGoverningRow([liveRow({ kind: "connector" })], ORG)).toBeNull();
  });
});

describe("#2044 — an org that INSTALLED the pack resolves its renderer", () => {
  it("binds detail + preview for the installing org", async () => {
    readByNames.mockResolvedValue(rowsFor([liveRow()]));
    const res = await reconcileActivatedRepresentationProviders(ORG);
    expect(res.bound).toEqual([CMS_PKG]);

    const detail = representationProviderRegistry.resolve(ORG, CMS_MIME, "detail");
    expect(detail).toMatchObject({ tier: "extension", packageName: CMS_PKG, pattern: CMS_MIME });
    const preview = representationProviderRegistry.resolve(ORG, CMS_MIME, "preview");
    expect(preview).toMatchObject({ tier: "extension", packageName: CMS_PKG });
  });
});

describe("#1630 — no activation-without-install", () => {
  it("a bundled/dev-enrolled pack with NO install row binds nothing", async () => {
    readByNames.mockResolvedValue(new Map());
    const res = await reconcileActivatedRepresentationProviders(ORG);
    expect(res.bound).toEqual([]);
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).toBeNull();
  });

  it("an install for ONE org is absent for every OTHER org", async () => {
    readByNames.mockResolvedValue(rowsFor([liveRow()]));
    await reconcileActivatedRepresentationProviders(ORG);
    await reconcileActivatedRepresentationProviders(OTHER_ORG);

    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).not.toBeNull();
    expect(representationProviderRegistry.resolve(OTHER_ORG, CMS_MIME, "detail")).toBeNull();
  });

  it("the system registrar still refuses to project the guardedOptional pack for any org", () => {
    reconcileSystemRepresentationProviders(OTHER_ORG);
    expect(representationProviderRegistry.resolve(OTHER_ORG, CMS_MIME, "detail")).toBeNull();
    expect(systemRepresentationProviderSpecs().some((s) => s.packageName === CMS_PKG)).toBe(false);
  });
});

describe("#1630 — clean uninstall isolation", () => {
  it("archiving the row unbinds the org on the next reconcile", async () => {
    readByNames.mockResolvedValue(rowsFor([liveRow()]));
    await reconcileActivatedRepresentationProviders(ORG);
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).not.toBeNull();

    readByNames.mockResolvedValue(rowsFor([liveRow({ status: "archived" })]));
    const res = await reconcileActivatedRepresentationProviders(ORG);
    expect(res.retired).toEqual([CMS_PKG]);
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).toBeNull();
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "preview")).toBeNull();
  });

  it("the capability-teardown chokepoint retires the pack (it is NOT system-exempt)", async () => {
    readByNames.mockResolvedValue(rowsFor([liveRow()]));
    await reconcileActivatedRepresentationProviders(ORG);

    const { invalidateArtifactRenderersForPackage } = await import(
      "@/lib/extension-artifact-renderers-teardown"
    );
    const removed = invalidateArtifactRenderersForPackage(CMS_PKG);
    expect(removed.removedRepresentationProviders).toBeGreaterThan(0);
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).toBeNull();
  });

  it("a delayed straggler at the torn-down generation cannot resurrect the provider", async () => {
    readByNames.mockResolvedValue(rowsFor([liveRow()]));
    await reconcileActivatedRepresentationProviders(ORG);
    const staleGeneration = generationForEpoch(ORG, CMS_PKG, installEpochToken(liveRow()));

    representationProviderRegistry.retireOrgProvider(ORG, CMS_PKG);
    // A straggler from the torn-down epoch replays its registration.
    representationProviderRegistry.registerProvider(ORG, {
      packageName: CMS_PKG,
      pattern: CMS_MIME,
      slot: "detail",
      generation: staleGeneration,
    });
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).toBeNull();
  });

  it("a genuine REINSTALL after teardown rebinds (a strictly higher generation)", async () => {
    readByNames.mockResolvedValue(rowsFor([liveRow()]));
    await reconcileActivatedRepresentationProviders(ORG);
    representationProviderRegistry.retireOrgProvider(ORG, CMS_PKG);

    // A new install row — new id, later updatedAt.
    readByNames.mockResolvedValue(
      rowsFor([liveRow({ id: "install-2", updatedAt: new Date("2026-07-26T11:00:00.000Z") })]),
    );
    await reconcileActivatedRepresentationProviders(ORG);
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).not.toBeNull();
  });
});

describe("generation semantics vs long-lived processes", () => {
  it("is stable while the durable epoch is unchanged (idempotent re-bind)", () => {
    const token = installEpochToken(liveRow());
    expect(generationForEpoch(ORG, CMS_PKG, token)).toBe(1);
    expect(generationForEpoch(ORG, CMS_PKG, token)).toBe(1);
  });

  it("advances on ANY durable change and NEVER goes backwards on a clock rollback", () => {
    const g1 = generationForEpoch(ORG, CMS_PKG, installEpochToken(liveRow()));
    // archive → restore bumps status + updatedAt
    const g2 = generationForEpoch(
      ORG,
      CMS_PKG,
      installEpochToken(liveRow({ status: "archived", updatedAt: new Date("2026-07-26T12:00:00Z") })),
    );
    // an EARLIER wall-clock timestamp (clock rollback / cross-worker skew)
    const g3 = generationForEpoch(
      ORG,
      CMS_PKG,
      installEpochToken(liveRow({ id: "install-2", updatedAt: new Date("2020-01-01T00:00:00Z") })),
    );
    expect(g2).toBeGreaterThan(g1);
    expect(g3).toBeGreaterThan(g2);
  });

  it("two lifecycle events inside the SAME millisecond still get distinct generations", () => {
    const at = new Date("2026-07-26T10:00:00.000Z");
    const a = generationForEpoch(ORG, CMS_PKG, installEpochToken(liveRow({ id: "i1", updatedAt: at })));
    const b = generationForEpoch(ORG, CMS_PKG, installEpochToken(liveRow({ id: "i2", updatedAt: at })));
    expect(b).toBeGreaterThan(a);
  });
});

describe("fail-closed on unproven entries", () => {
  it("a canonical-store READ FAILURE retires the org's activated providers", async () => {
    readByNames.mockResolvedValue(rowsFor([liveRow()]));
    await reconcileActivatedRepresentationProviders(ORG);
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).not.toBeNull();

    readByNames.mockRejectedValue(new Error("canonical store unreachable"));
    const res = await reconcileActivatedRepresentationProviders(ORG);
    expect(res.degraded).toBe(true);
    expect(res.bound).toEqual([]);
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).toBeNull();
  });

  it("`ensureActivatedRepresentationProviders` never throws", async () => {
    readByNames.mockRejectedValue(new Error("boom"));
    await expect(ensureActivatedRepresentationProviders(ORG)).resolves.toBeUndefined();
  });

  it("the system bases keep resolving while the activated path is degraded", async () => {
    readByNames.mockRejectedValue(new Error("down"));
    await ensureActivatedRepresentationProviders(ORG);
    reconcileSystemRepresentationProviders(ORG);
    expect(representationProviderRegistry.resolve(ORG, "application/pdf", "detail")).toMatchObject({
      tier: "extension",
    });
  });
});

describe("install-transaction bind", () => {
  it("binds for a CONCRETE-org install row", () => {
    expect(
      bindActivatedRepresentationProvidersForInstall({ packageName: CMS_PKG, row: liveRow() }),
    ).toBe(2);
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).not.toBeNull();
  });

  it("an AMBIENT (org-less) install binds nothing here — the per-org reconcile owns it", () => {
    expect(
      bindActivatedRepresentationProvidersForInstall({
        packageName: CMS_PKG,
        row: liveRow({ organizationId: null }),
      }),
    ).toBe(0);
  });

  it("an ARCHIVED row never binds", () => {
    expect(
      bindActivatedRepresentationProvidersForInstall({
        packageName: CMS_PKG,
        row: liveRow({ status: "archived" }),
      }),
    ).toBe(0);
  });

  it("a package outside the build map never binds", () => {
    expect(
      bindActivatedRepresentationProvidersForInstall({
        packageName: "@evil/not-built-artifact",
        row: liveRow(),
      }),
    ).toBe(0);
  });
});

describe("no regression for the required (system) path", () => {
  it("the system specs are unchanged by an activated bind", async () => {
    const before = systemRepresentationProviderSpecs();
    readByNames.mockResolvedValue(rowsFor([liveRow()]));
    await reconcileActivatedRepresentationProviders(ORG);
    expect(systemRepresentationProviderSpecs()).toEqual(before);
  });

  it("the system bases still win their own MIMEs for the installing org", async () => {
    readByNames.mockResolvedValue(rowsFor([liveRow()]));
    await reconcileActivatedRepresentationProviders(ORG);
    reconcileSystemRepresentationProviders(ORG);

    for (const mime of ["application/pdf", "image/png", "application/json"]) {
      const res = representationProviderRegistry.resolve(ORG, mime, "detail");
      expect(res?.tier).toBe("extension");
      expect(res && "packageName" in res ? res.packageName : null).not.toBe(CMS_PKG);
    }
  });
});

// ---------------------------------------------------------------------------
// Codex closure-round findings (all three were real; each is pinned here).
// ---------------------------------------------------------------------------

describe("codex R1 — package purity: a MIXED package is never activatable", () => {
  it("no activatable package also carries a `required` build-map entry", () => {
    const requiredPackages = new Set(
      Object.values(GENERATED_ARTIFACT_RENDERERS)
        .filter((e) => e.resolution === "required")
        .map((e) => e.packageName),
    );
    for (const pkg of activatableRendererPackages()) {
      expect(requiredPackages.has(pkg)).toBe(false);
    }
  });

  it("retirement is package-scoped, so a system package must never be a candidate", async () => {
    // Retiring is `retireOrgProvider(orgId, packageName)` — whole-package. Bind
    // the system bases, then reconcile with NO install rows: the reconcile must
    // retire only its own candidates and leave every system binding intact.
    reconcileSystemRepresentationProviders(ORG);
    const systemBefore = representationProviderRegistry
      ._snapshotOrgProviders(ORG)
      .filter((d) => d.generation === 1).length;
    expect(systemBefore).toBeGreaterThan(0);

    readByNames.mockResolvedValue(new Map());
    await reconcileActivatedRepresentationProviders(ORG);

    const systemAfter = representationProviderRegistry
      ._snapshotOrgProviders(ORG)
      .filter((d) => d.generation === 1).length;
    expect(systemAfter).toBe(systemBefore);
    expect(representationProviderRegistry.resolve(ORG, "application/pdf", "detail")).toMatchObject({
      tier: "extension",
    });
  });
});

describe("codex R1 — a transient store outage RECOVERS on the next reconcile", () => {
  it("rebinds after a fail-closed retire even though the install row is UNCHANGED", async () => {
    const row = liveRow();
    readByNames.mockResolvedValue(rowsFor([row]));
    await reconcileActivatedRepresentationProviders(ORG);
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).not.toBeNull();

    // Transient outage → fail-closed retire (the registry keeps the tombstone floor).
    readByNames.mockRejectedValue(new Error("transient outage"));
    expect((await reconcileActivatedRepresentationProviders(ORG)).degraded).toBe(true);
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).toBeNull();

    // The store comes back. The row never changed, so a naive allocator would
    // hand back the tombstoned generation and the registry would reject the
    // write as a straggler — the provider would never return.
    readByNames.mockResolvedValue(rowsFor([row]));
    await reconcileActivatedRepresentationProviders(ORG);
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).toMatchObject({
      tier: "extension",
      packageName: CMS_PKG,
    });
  });

  it("an uninstall → REINSTALL of the very same durable epoch still rebinds", async () => {
    const row = liveRow();
    readByNames.mockResolvedValue(rowsFor([row]));
    await reconcileActivatedRepresentationProviders(ORG);

    readByNames.mockResolvedValue(rowsFor([liveRow({ status: "archived" })]));
    await reconcileActivatedRepresentationProviders(ORG);
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).toBeNull();

    readByNames.mockResolvedValue(rowsFor([row]));
    await reconcileActivatedRepresentationProviders(ORG);
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).not.toBeNull();
  });
});

describe("codex R1 — a POST-READ throw is fail-CLOSED, not fail-open", () => {
  it("retires the org's providers when the reconcile throws after binding once", async () => {
    readByNames.mockResolvedValue(rowsFor([liveRow()]));
    await ensureActivatedRepresentationProviders(ORG);
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).not.toBeNull();

    // A throw that is NOT the canonical read (so the inner fail-closed arm is
    // bypassed) — e.g. a malformed row or a registry write error.
    readByNames.mockImplementation(() => {
      throw new Error("post-read explosion");
    });
    await expect(ensureActivatedRepresentationProviders(ORG)).resolves.toBeUndefined();
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).toBeNull();

    // …and it still recovers once the fault clears.
    readByNames.mockImplementation(async () => rowsFor([liveRow()]));
    await ensureActivatedRepresentationProviders(ORG);
    expect(representationProviderRegistry.resolve(ORG, CMS_MIME, "detail")).not.toBeNull();
  });
});
