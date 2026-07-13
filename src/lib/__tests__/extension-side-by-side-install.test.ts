// cinatra#1040 S3 — the SIDE-BY-SIDE version installer: mutation-free
// preflight refusals (gatekept fence, kind, version namespace, default-sibling
// health), the row-bound + version-scoped pipeline wiring, the shared-state
// discipline overrides (grants/ownership/migrations), placeholder rollback,
// idempotence, and the version-scoped teardown.
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- module mocks (the installer resolves everything dynamically) ----------

const withInstallLock = vi.fn(async (_pkg: string, fn: () => Promise<unknown>) => fn());
vi.mock("@cinatra-ai/agents", () => ({
  withInstallLock: (...a: unknown[]) =>
    withInstallLock(...(a as [string, () => Promise<unknown>])),
}));

let gatekeptEnabled = false;
vi.mock("@/lib/gatekept-install", () => ({
  isGatekeptInstallEnabled: () => gatekeptEnabled,
}));

vi.mock("@cinatra-ai/registries", () => ({
  isExactVersion: (v: string) => /^\d+\.\d+\.\d+$/.test(v),
}));

let requiredInProd = false;
let pinCheck: { ok: true } | { ok: false; reason: string } = { ok: true };
vi.mock("@cinatra-ai/extensions/required-in-prod", () => ({
  isPackageRequiredInProd: () => requiredInProd,
  checkRequiredExtensionVersionPin: () => pinCheck,
}));

type FakeRow = {
  id: string;
  packageName: string;
  organizationId: string | null;
  status: string;
  isDefault?: boolean;
  version?: string;
  source: unknown;
};
let canonicalRows: FakeRow[] = [];
const readInstalledExtensionsByPackageName = vi.fn(async () => canonicalRows);
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: () => readInstalledExtensionsByPackageName(),
}));

// Journal: versionless anchor read (the default's health) + version-scoped ops.
let defaultOpPhase: string | null = "finalized";
let versionOps: Record<string, { installOpId: string; phase: string } | null> = {};
const advanceInstallOpPhase = vi.fn(async () => undefined);
const beginInstallOp = vi.fn(async () => undefined);
vi.mock("@/lib/extension-install-ops", () => ({
  readInstallOp: async () =>
    defaultOpPhase ? { installOpId: "def-op", phase: defaultOpPhase, digest: null } : null,
  readInstallOpForVersion: async (_pkg: string, _org: string | null, version: string) =>
    versionOps[version] ?? null,
  advanceInstallOpPhase: (...a: unknown[]) => advanceInstallOpPhase(...(a as [])),
  beginInstallOp: (...a: unknown[]) => beginInstallOp(...(a as [])),
}));

const installExtensionManifest = vi.fn(async (row: { id: string }) => row);
const deleteSideBySideVersionRow = vi.fn(async () => undefined);
vi.mock("@cinatra-ai/extensions/lifecycle-primitive", () => ({
  installExtensionManifest: (...a: unknown[]) => installExtensionManifest(...(a as [{ id: string }])),
  deleteSideBySideVersionRow: (...a: unknown[]) => deleteSideBySideVersionRow(...(a as [])),
}));

const makeCanonicalRowInstallDeps = vi.fn((opts: Record<string, unknown>) => ({
  __rowBound: opts,
}));
vi.mock("@/lib/extension-install-canonical-row-deps", () => ({
  makeCanonicalRowInstallDeps: (...a: unknown[]) =>
    makeCanonicalRowInstallDeps(...(a as [Record<string, unknown>])),
}));

// The pipeline: capture the input + deps the installer builds; behavior is
// scripted per test (finalize vs throw).
let pipelineImpl: (input: unknown, deps: Record<string, never>) => Promise<unknown> = async () => ({});
const installExtensionFromRegistry = vi.fn((input: unknown, deps: never) =>
  pipelineImpl(input, deps),
);
const basePreflightMigrations = vi.fn(async () => false);
const baseReadGrantForScope = vi.fn(async () => null as unknown);
// cinatra#1391 PORTS AXIS: named base grant spies the side-by-side union path wraps.
const baseRecordRequestedGrant = vi.fn(async () => undefined);
const baseApproveGrant = vi.fn(async () => undefined);
const baseRestoreGrant = vi.fn(async () => undefined);
// cinatra#1040 S6: base OWNERSHIP hooks the side-by-side union path wraps.
let baseTokenKeys: string[] = [];
const baseReadWidgetAuthTokenKeys = vi.fn(async () => baseTokenKeys);
const baseRecordRequestedOwnershipGrant = vi.fn(async () => undefined);
const baseApproveOwnershipGrant = vi.fn(async () => undefined);
const baseRevokeOwnershipGrant = vi.fn(async () => undefined);
vi.mock("@/lib/extension-install-pipeline", () => ({
  installExtensionFromRegistry: (...a: unknown[]) =>
    installExtensionFromRegistry(...(a as [unknown, never])),
  makeDefaultInstallPipelineDeps: async () => ({
    resolveIntegrity: vi.fn(),
    materialize: vi.fn(),
    readRequestedPorts: vi.fn(async () => []),
    preflightMigrations: (...a: unknown[]) => basePreflightMigrations(...(a as [])),
    readGrantForScope: (...a: unknown[]) => baseReadGrantForScope(...(a as [])),
    recordRequestedGrant: (...a: unknown[]) => baseRecordRequestedGrant(...(a as [])),
    approveGrant: (...a: unknown[]) => baseApproveGrant(...(a as [])),
    restoreGrant: (...a: unknown[]) => baseRestoreGrant(...(a as [])),
    readWidgetAuthTokenKeys: (...a: unknown[]) => baseReadWidgetAuthTokenKeys(...(a as [])),
    recordRequestedOwnershipGrant: (...a: unknown[]) =>
      baseRecordRequestedOwnershipGrant(...(a as [])),
    approveOwnershipGrant: (...a: unknown[]) => baseApproveOwnershipGrant(...(a as [])),
    revokeOwnershipGrant: (...a: unknown[]) => baseRevokeOwnershipGrant(...(a as [])),
    activateInProcess: vi.fn(async () => ({ activated: true })),
  }),
}));

// Real revoke (uninstall reconcile path) — mocked so the DI-unit test needs no DB.
const ownershipRevoke = vi.fn(async () => null);
const readWidgetAuthTokenKeysFromStore = vi.fn(async () => [] as string[]);
vi.mock("@/lib/extension-capability-ownership-grants", () => ({
  revokeOwnershipGrant: (...a: unknown[]) => ownershipRevoke(...(a as [])),
  readWidgetAuthTokenKeysFromStore: (...a: unknown[]) =>
    readWidgetAuthTokenKeysFromStore(...(a as [])),
}));

// cinatra#1391 PORTS AXIS: the shared host-port grant store (dynamic-imported by
// the install-time union path for the hash + by the teardown ports reconcile).
// Deterministic order-insensitive hash so union/prior/survivor comparisons are
// assertable without a DB.
const portsHash = (ports: readonly string[]): string =>
  `h:${Array.from(new Set(ports.map(String))).sort().join(",")}`;
const grantsReadGrantForScope = vi.fn(async () => null as unknown);
const grantsRestoreGrant = vi.fn(async () => undefined);
const grantsRecordRequestedGrant = vi.fn(async () => undefined);
vi.mock("@/lib/extension-host-port-grants", () => ({
  computeRequestedPortsHash: (p: readonly string[]) => portsHash(p),
  readGrantForScope: (...a: unknown[]) => grantsReadGrantForScope(...(a as [])),
  restoreGrant: (...a: unknown[]) => grantsRestoreGrant(...(a as [])),
  recordRequestedGrant: (...a: unknown[]) => grantsRecordRequestedGrant(...(a as [])),
}));

import {
  installExtensionVersionSideBySide,
  uninstallExtensionVersionSideBySide,
  SideBySideInstallError,
} from "@/lib/extension-side-by-side-install";

const PKG = "@cinatra-ai/shared";

function defaultRow(over: Partial<FakeRow> = {}): FakeRow {
  return {
    id: "row-default",
    packageName: PKG,
    organizationId: null,
    status: "active",
    isDefault: true,
    version: "0.2.1",
    source: { type: "verdaccio", version: "0.2.1" },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  gatekeptEnabled = false;
  requiredInProd = false;
  pinCheck = { ok: true };
  canonicalRows = [defaultRow()];
  defaultOpPhase = "finalized";
  versionOps = {};
  baseTokenKeys = [];
  pipelineImpl = async () => {
    versionOps["0.3.0"] = { installOpId: "sbs-op", phase: "finalized" };
    return {};
  };
});

const INPUT = { packageName: PKG, version: "0.3.0", typeId: "skill", orgId: null } as const;

describe("installExtensionVersionSideBySide — mutation-free preflight", () => {
  it("REFUSES when gatekept install is enabled at execution time (env flip between planning and execution)", async () => {
    gatekeptEnabled = true;
    await expect(installExtensionVersionSideBySide(INPUT)).rejects.toMatchObject({
      code: "GATEKEPT_PATH",
    });
    expect(installExtensionManifest).not.toHaveBeenCalled();
    expect(installExtensionFromRegistry).not.toHaveBeenCalled();
  });

  it("REFUSES the workflow kind (saga-owned native state)", async () => {
    await expect(
      installExtensionVersionSideBySide({ ...INPUT, typeId: "workflow" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_KIND" });
  });

  it("REFUSES the '0.0.0' legacy journal namespace and non-exact versions", async () => {
    await expect(
      installExtensionVersionSideBySide({ ...INPUT, version: "0.0.0" }),
    ).rejects.toMatchObject({ code: "INVALID_VERSION" });
    await expect(
      installExtensionVersionSideBySide({ ...INPUT, version: "^0.3.0" }),
    ).rejects.toMatchObject({ code: "INVALID_VERSION" });
  });

  it("REFUSES required-in-prod packages (host-lock-pinned)", async () => {
    requiredInProd = true;
    await expect(installExtensionVersionSideBySide(INPUT)).rejects.toMatchObject({
      code: "REQUIRED_IN_PROD",
    });
  });

  it("REFUSES a host-pin violation with the pin gate's reason", async () => {
    pinCheck = { ok: false, reason: "pinned to ^0.2.0" };
    await expect(installExtensionVersionSideBySide(INPUT)).rejects.toMatchObject({
      code: "HOST_PIN_VIOLATION",
    });
  });

  it("REFUSES without exactly one live DEFAULT sibling (0 defaults / no rows)", async () => {
    canonicalRows = [];
    await expect(installExtensionVersionSideBySide(INPUT)).rejects.toMatchObject({
      code: "NO_DEFAULT_SIBLING",
    });
    canonicalRows = [defaultRow({ isDefault: false })];
    await expect(installExtensionVersionSideBySide(INPUT)).rejects.toMatchObject({
      code: "NO_DEFAULT_SIBLING",
    });
  });

  it("REFUSES when the default install's journal is not finalized (broken base)", async () => {
    defaultOpPhase = "materialized";
    await expect(installExtensionVersionSideBySide(INPUT)).rejects.toMatchObject({
      code: "DEFAULT_NOT_ANCHORED",
    });
  });
});

describe("installExtensionVersionSideBySide — pipeline wiring", () => {
  it("creates a NON-DEFAULT placeholder row at the pin and runs the pipeline row-bound + version-scoped, with the current-mirror OFF and activation inert", async () => {
    const res = await installExtensionVersionSideBySide(INPUT);
    // Placeholder: isDefault false, version = pin.
    const rowInput = installExtensionManifest.mock.calls[0]![0] as Record<string, unknown>;
    expect(rowInput.isDefault).toBe(false);
    expect(rowInput.version).toBe("0.3.0");
    expect(rowInput.packageName).toBe(PKG);
    expect(res.rowId).toBe(rowInput.id);
    // Row-bound canonical deps: bound to the new row, `current` mirror OFF.
    const bindOpts = makeCanonicalRowInstallDeps.mock.calls[0]![0] as Record<string, unknown>;
    expect(bindOpts.boundRowId).toBe(rowInput.id);
    expect(bindOpts.mirrorCurrentDigest).toBe(false);
    // Pipeline input: stable version-scoped op id + the planner kind.
    const [pipeInput, pipeDeps] = installExtensionFromRegistry.mock.calls[0]! as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(pipeInput.installOpId).toBe(`sbs:${PKG}@0.3.0:(global)`);
    expect(pipeInput.expectedKind).toBe("skill");
    // Version-scoped journal begin.
    await (pipeDeps.beginInstallOp as (b: unknown) => Promise<void>)({
      installOpId: "x",
      packageName: PKG,
      orgId: null,
    });
    expect(beginInstallOp).toHaveBeenCalledWith(expect.objectContaining({ version: "0.3.0" }));
    // The prior-op read observes only the version namespace (fresh-install semantics).
    versionOps["0.3.0"] = null;
    expect(await (pipeDeps.readInstallOp as (p: string, o: null) => Promise<unknown>)(PKG, null)).toBeNull();
    // Activation is inert (versioned activation = S4).
    const act = await (pipeDeps.activateInProcess as () => Promise<{ activated: boolean; reason?: string }>)();
    expect(act.activated).toBe(false);
    expect(act.reason).toContain("S4");
  });

  it("SHARED-STATE DISCIPLINE: empty port request no-ops; covered request no-ops; uncovered request REFUSES; ownership keys REFUSE; declared migrations are ALLOWED (S5 union, deferred to activation)", async () => {
    await installExtensionVersionSideBySide(INPUT);
    const [, pipeDeps] = installExtensionFromRegistry.mock.calls[0]! as [
      unknown,
      Record<string, unknown>,
    ];
    const recordGrant = pipeDeps.recordRequestedGrant as (g: unknown) => Promise<void>;
    // Empty request → no-op.
    await recordGrant({ packageName: PKG, orgId: null, requestedPorts: [] });
    // Covered by the scope's APPROVED grant → no-op.
    baseReadGrantForScope.mockResolvedValueOnce({ status: "approved", approvedPorts: ["p1", "p2"] });
    await recordGrant({ packageName: PKG, orgId: null, requestedPorts: ["p1"] });
    // Uncovered → refusal.
    baseReadGrantForScope.mockResolvedValueOnce({ status: "approved", approvedPorts: ["p1"] });
    await expect(
      recordGrant({ packageName: PKG, orgId: null, requestedPorts: ["p1", "p9"] }),
    ).rejects.toMatchObject({ code: "PORTS_NOT_COVERED" });
    // Ownership grants refuse outright.
    await expect(
      (pipeDeps.recordRequestedOwnershipGrant as (g: unknown) => Promise<void>)({
        packageName: PKG,
        orgId: null,
        tokenConfigKey: "k",
      }),
    ).rejects.toMatchObject({ code: "DECLARES_OWNERSHIP_KEYS" });
    // cinatra#1040 S5: a declared migration is NO LONGER refused — the base
    // preflight is still consulted (validation stands) and its `true` return is
    // passed through so the pipeline trust gate can still reject an UNSIGNED
    // declarer, but a SIGNED declarer proceeds; application is deferred to the
    // loader's cross-version union at activation.
    basePreflightMigrations.mockResolvedValueOnce(true);
    await expect(
      (pipeDeps.preflightMigrations as (i: unknown) => Promise<boolean>)({
        storeDir: "/x",
        packageName: PKG,
      }),
    ).resolves.toBe(true);
    // No declared migrations → false (pipeline proceeds).
    basePreflightMigrations.mockResolvedValueOnce(false);
    await expect(
      (pipeDeps.preflightMigrations as (i: unknown) => Promise<boolean>)({
        storeDir: "/x",
        packageName: PKG,
      }),
    ).resolves.toBe(false);
    // applyMigrations stays a no-op at install (deferred to the activation union).
    await expect(
      (pipeDeps.applyMigrations as (i: unknown) => Promise<unknown>)({
        storeDir: "/x",
        packageName: PKG,
      }),
    ).resolves.toBeUndefined();
  });

  it("a pipeline failure ROLLS BACK the placeholder this attempt created (version-scoped non-finalized check) and rethrows", async () => {
    pipelineImpl = async () => {
      versionOps["0.3.0"] = { installOpId: "sbs-op", phase: "failed" };
      throw new Error("materialize refused");
    };
    await expect(installExtensionVersionSideBySide(INPUT)).rejects.toThrow("materialize refused");
    expect(deleteSideBySideVersionRow).toHaveBeenCalledTimes(1);
    expect(advanceInstallOpPhase).toHaveBeenCalledWith(
      expect.objectContaining({ installOpId: "sbs-op", phase: "rolled_back" }),
    );
  });

  it("a pipeline failure that DID finalize (crash after finalize) leaves the row in place", async () => {
    pipelineImpl = async () => {
      versionOps["0.3.0"] = { installOpId: "sbs-op", phase: "finalized" };
      throw new Error("post-finalize hiccup");
    };
    await expect(installExtensionVersionSideBySide(INPUT)).rejects.toThrow("post-finalize hiccup");
    expect(deleteSideBySideVersionRow).not.toHaveBeenCalled();
  });

  it("IDEMPOTENT: an existing non-default row at the pin with a FINALIZED version-scoped op returns immediately (no pipeline)", async () => {
    canonicalRows = [
      defaultRow(),
      defaultRow({ id: "row-sbs", isDefault: false, version: "0.3.0" }),
    ];
    versionOps["0.3.0"] = { installOpId: "sbs-op", phase: "finalized" };
    const res = await installExtensionVersionSideBySide(INPUT);
    expect(res.rowId).toBe("row-sbs");
    expect(installExtensionManifest).not.toHaveBeenCalled();
    expect(installExtensionFromRegistry).not.toHaveBeenCalled();
  });

  it("a BROKEN prior attempt (row present, op not finalized) is RETRIED through the pipeline against the same row", async () => {
    canonicalRows = [
      defaultRow(),
      defaultRow({ id: "row-sbs", isDefault: false, version: "0.3.0" }),
    ];
    versionOps["0.3.0"] = { installOpId: "sbs-op", phase: "failed" };
    pipelineImpl = async () => {
      versionOps["0.3.0"] = { installOpId: "sbs-op", phase: "finalized" };
      return {};
    };
    const res = await installExtensionVersionSideBySide(INPUT);
    expect(res.rowId).toBe("row-sbs");
    expect(installExtensionManifest).not.toHaveBeenCalled(); // no second placeholder
    expect(installExtensionFromRegistry).toHaveBeenCalledTimes(1);
  });
});

describe("uninstallExtensionVersionSideBySide — version-scoped teardown", () => {
  it("deletes ONLY the non-default row at the exact (org, version) and terminalizes its version-scoped op", async () => {
    canonicalRows = [
      defaultRow(),
      defaultRow({ id: "row-sbs", isDefault: false, version: "0.3.0" }),
    ];
    versionOps["0.3.0"] = { installOpId: "sbs-op", phase: "finalized" };
    const res = await uninstallExtensionVersionSideBySide({
      packageName: PKG,
      version: "0.3.0",
      orgId: null,
    });
    expect(res.removed).toBe(true);
    expect(deleteSideBySideVersionRow).toHaveBeenCalledWith("row-sbs");
    expect(advanceInstallOpPhase).toHaveBeenCalledWith(
      expect.objectContaining({ installOpId: "sbs-op", phase: "rolled_back" }),
    );
  });

  it("is IDEMPOTENT: a missing row is a no-op (still terminalizes a dangling op)", async () => {
    canonicalRows = [defaultRow()];
    versionOps["0.3.0"] = { installOpId: "sbs-op", phase: "failed" };
    const res = await uninstallExtensionVersionSideBySide({
      packageName: PKG,
      version: "0.3.0",
      orgId: null,
    });
    expect(res.removed).toBe(false);
    expect(deleteSideBySideVersionRow).not.toHaveBeenCalled();
    expect(advanceInstallOpPhase).toHaveBeenCalledWith(
      expect.objectContaining({ installOpId: "sbs-op", phase: "rolled_back" }),
    );
  });

  it("REFUSES the '0.0.0' legacy namespace (never a side-by-side row)", async () => {
    await expect(
      uninstallExtensionVersionSideBySide({ packageName: PKG, version: "0.0.0", orgId: null }),
    ).rejects.toBeInstanceOf(SideBySideInstallError);
  });

  it("never targets the DEFAULT row even when it sits at the requested version", async () => {
    canonicalRows = [defaultRow({ version: "0.3.0" })]; // default at the pin
    const res = await uninstallExtensionVersionSideBySide({
      packageName: PKG,
      version: "0.3.0",
      orgId: null,
    });
    expect(res.removed).toBe(false);
    expect(deleteSideBySideVersionRow).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// cinatra#1040 S6 — capability-OWNERSHIP grant UNION + durable capsule
// ===========================================================================

/** Run an install with `grantUnion` and capture the deps the installer built. */
async function captureUnionDeps(
  grantUnion: {
    persistCapsule: (c: unknown) => Promise<void>;
    readSurvivorOwnershipKeys?: (v: string) => Promise<Set<string>>;
    readSiblingDeclaredPorts?: (v: string) => Promise<string[]>;
  },
): Promise<Record<string, (...a: never[]) => Promise<unknown>>> {
  let captured: Record<string, (...a: never[]) => Promise<unknown>> = {};
  pipelineImpl = async (_input, deps) => {
    captured = deps as unknown as typeof captured;
    versionOps["0.3.0"] = { installOpId: "sbs-op", phase: "finalized" };
    return {};
  };
  await installExtensionVersionSideBySide({ ...INPUT, grantUnion });
  return captured;
}

describe("installExtensionVersionSideBySide — ownership grant UNION (S6)", () => {
  it("with a capsule sink: LIFTS the DECLARES_OWNERSHIP_KEYS refusal (records via base)", async () => {
    const deps = await captureUnionDeps({ persistCapsule: vi.fn(async () => {}) });
    // The built recordRequestedOwnershipGrant is base's REAL recorder, not the refuse.
    await expect(
      (deps.recordRequestedOwnershipGrant as (g: unknown) => Promise<void>)({
        packageName: PKG,
        orgId: null,
        tokenConfigKey: "wp_widget_auth",
      }),
    ).resolves.toBeUndefined();
    expect(baseRecordRequestedOwnershipGrant).toHaveBeenCalledTimes(1);
  });

  it("WITHOUT a capsule sink: the S3 DECLARES_OWNERSHIP_KEYS refusal stands", async () => {
    let deps: Record<string, (...a: never[]) => Promise<unknown>> = {};
    pipelineImpl = async (_i, d) => {
      deps = d as never;
      versionOps["0.3.0"] = { installOpId: "sbs-op", phase: "finalized" };
      return {};
    };
    await installExtensionVersionSideBySide(INPUT); // no grantUnion
    await expect(
      (deps.recordRequestedOwnershipGrant as (g: unknown) => Promise<void>)({
        packageName: PKG,
        orgId: null,
        tokenConfigKey: "wp_widget_auth",
      }),
    ).rejects.toMatchObject({ code: "DECLARES_OWNERSHIP_KEYS" });
  });

  it("captures the DECLARATION CAPSULE (persistCapsule) when reading declared keys, BEFORE any mutation", async () => {
    baseTokenKeys = ["b_widget_auth", "a_widget_auth"];
    const persistCapsule = vi.fn(async () => {});
    const deps = await captureUnionDeps({ persistCapsule });
    const keys = await (deps.readWidgetAuthTokenKeys as (s: string) => Promise<string[]>)("/store");
    expect(keys).toEqual(["b_widget_auth", "a_widget_auth"]); // returns base keys unchanged
    expect(persistCapsule).toHaveBeenCalledWith({
      v: 1,
      declaredTokenKeys: ["a_widget_auth", "b_widget_auth"], // sorted/de-duped
    });
  });

  it("does NOT persist a capsule when no ownership keys are declared", async () => {
    baseTokenKeys = [];
    const persistCapsule = vi.fn(async () => {});
    const deps = await captureUnionDeps({ persistCapsule });
    await (deps.readWidgetAuthTokenKeys as (s: string) => Promise<string[]>)("/store");
    expect(persistCapsule).not.toHaveBeenCalled();
  });

  it("SUPPRESSES ownership auto-approve (a side-by-side declarer never auto-becomes owner)", async () => {
    const deps = await captureUnionDeps({ persistCapsule: vi.fn(async () => {}) });
    await (deps.approveOwnershipGrant as (g: unknown) => Promise<void>)({
      packageName: PKG,
      orgId: null,
      tokenConfigKey: "wp_widget_auth",
      approvedBy: "x",
    });
    expect(baseApproveOwnershipGrant).not.toHaveBeenCalled();
  });

  it("revoke is SURVIVOR-AWARE: KEEPS a key a surviving sibling still declares (direct-failure unwind)", async () => {
    const deps = await captureUnionDeps({
      persistCapsule: vi.fn(async () => {}),
      readSurvivorOwnershipKeys: async () => new Set(["wp_widget_auth"]),
    });
    await (deps.revokeOwnershipGrant as (g: unknown) => Promise<void>)({
      packageName: PKG,
      orgId: null,
      tokenConfigKey: "wp_widget_auth",
    });
    expect(baseRevokeOwnershipGrant).not.toHaveBeenCalled(); // survivor declares it → keep
  });

  it("revoke is SURVIVOR-AWARE: REVOKES an orphaned key no surviving sibling declares", async () => {
    const deps = await captureUnionDeps({
      persistCapsule: vi.fn(async () => {}),
      readSurvivorOwnershipKeys: async () => new Set<string>(),
    });
    await (deps.revokeOwnershipGrant as (g: unknown) => Promise<void>)({
      packageName: PKG,
      orgId: null,
      tokenConfigKey: "wp_widget_auth",
    });
    expect(baseRevokeOwnershipGrant).toHaveBeenCalledTimes(1); // no survivor → revoke
  });

  it("DEFERS the coupled widget-metadata axis (record/restore/delete are inert no-ops)", async () => {
    const deps = await captureUnionDeps({ persistCapsule: vi.fn(async () => {}) });
    await expect(
      (deps.recordWidgetStreamMetadataGrant as (g: unknown) => Promise<void>)({}),
    ).resolves.toBeUndefined();
    await expect(
      (deps.restoreOwnershipGrant as (g: unknown) => Promise<void>)({}),
    ).resolves.toBeUndefined();
  });
});

describe("uninstallExtensionVersionSideBySide — ownership reconcile (S6)", () => {
  beforeEach(() => {
    // A non-default side-by-side row at the pin so the teardown proceeds.
    canonicalRows = [
      defaultRow(),
      defaultRow({ id: "row-sbs", isDefault: false, version: "0.3.0" }),
    ];
    versionOps["0.3.0"] = { installOpId: "sbs-op", phase: "finalized" };
  });

  it("REVOKES a declared key no surviving sibling still declares", async () => {
    const res = await uninstallExtensionVersionSideBySide({
      packageName: PKG,
      version: "0.3.0",
      orgId: null,
      capsule: { v: 1, declaredTokenKeys: ["wp_widget_auth"] },
      readSurvivorOwnershipKeys: async () => new Set<string>(), // default declares no keys
    });
    expect(res.removed).toBe(true);
    expect(ownershipRevoke).toHaveBeenCalledWith({
      packageName: PKG,
      orgId: null,
      tokenConfigKey: "wp_widget_auth",
    });
  });

  it("KEEPS a declared key the surviving default still declares (never revoke a live key)", async () => {
    await uninstallExtensionVersionSideBySide({
      packageName: PKG,
      version: "0.3.0",
      orgId: null,
      capsule: { v: 1, declaredTokenKeys: ["wp_widget_auth"] },
      readSurvivorOwnershipKeys: async () => new Set(["wp_widget_auth"]),
    });
    expect(ownershipRevoke).not.toHaveBeenCalled();
  });

  it("no capsule + no declared keys (legacy/no-ownership member) → no reconcile", async () => {
    await uninstallExtensionVersionSideBySide({
      packageName: PKG,
      version: "0.3.0",
      orgId: null,
      readTornDownDeclaredKeys: async () => [], // live fallback finds nothing declared
    });
    expect(ownershipRevoke).not.toHaveBeenCalled();
  });

  it("capsule-ABSENT explicit uninstall FALLS BACK to the live store keys and revokes an orphaned one", async () => {
    await uninstallExtensionVersionSideBySide({
      packageName: PKG,
      version: "0.3.0",
      orgId: null,
      // no capsule (released on batch finalize) → fall back to the version's own store
      readTornDownDeclaredKeys: async () => ["orphan_widget_auth"],
      readSurvivorOwnershipKeys: async () => new Set<string>(), // no survivor declares it
    });
    expect(ownershipRevoke).toHaveBeenCalledWith({
      packageName: PKG,
      orgId: null,
      tokenConfigKey: "orphan_widget_auth",
    });
  });

  it("capsule-ABSENT fallback still KEEPS a key a surviving sibling declares", async () => {
    await uninstallExtensionVersionSideBySide({
      packageName: PKG,
      version: "0.3.0",
      orgId: null,
      readTornDownDeclaredKeys: async () => ["shared_widget_auth"],
      readSurvivorOwnershipKeys: async () => new Set(["shared_widget_auth"]),
    });
    expect(ownershipRevoke).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// cinatra#1391 — host-PORTS grant UNION + durable capsule (install + teardown)
// ===========================================================================

describe("installExtensionVersionSideBySide — ports grant UNION (#1391)", () => {
  it("with a capsule sink: LIFTS PORTS_NOT_COVERED — records the per-scope UNION via base + captures the capsule", async () => {
    const persistCapsule = vi.fn(async () => {});
    const deps = await captureUnionDeps({
      persistCapsule,
      readSiblingDeclaredPorts: async () => ["p1"], // a surviving sibling declares p1
    });
    baseReadGrantForScope.mockResolvedValueOnce(null); // no prior grant row
    await (deps.recordRequestedGrant as (g: unknown) => Promise<void>)({
      packageName: PKG,
      orgId: null,
      requestedPorts: ["p2"],
    });
    // Recorded the UNION (sibling ∪ declared) through base's REAL recorder.
    expect(baseRecordRequestedGrant).toHaveBeenCalledWith({
      packageName: PKG,
      orgId: null,
      requestedPorts: ["p1", "p2"],
    });
    // DURABLE capsule captured (declaredPorts + prior=absent) BEFORE the record.
    expect(persistCapsule).toHaveBeenCalledWith({
      v: 1,
      declaredTokenKeys: [],
      declaredPorts: ["p2"],
      portsPrior: { exists: false },
    });
  });

  it("captures the PRIOR grant state into the capsule when a grant row already exists", async () => {
    const persistCapsule = vi.fn(async () => {});
    const deps = await captureUnionDeps({
      persistCapsule,
      readSiblingDeclaredPorts: async () => ["p1"],
    });
    baseReadGrantForScope.mockResolvedValueOnce({
      status: "approved",
      approvedPorts: ["p1"],
      requestedPortsHash: portsHash(["p1"]),
      approvedBy: "admin",
    });
    await (deps.recordRequestedGrant as (g: unknown) => Promise<void>)({
      packageName: PKG,
      orgId: null,
      requestedPorts: ["p2"],
    });
    expect(persistCapsule).toHaveBeenCalledWith(
      expect.objectContaining({
        declaredPorts: ["p2"],
        portsPrior: {
          exists: true,
          status: "approved",
          approvedPorts: ["p1"],
          requestedPortsHash: portsHash(["p1"]),
          approvedBy: "admin",
        },
      }),
    );
    expect(baseRecordRequestedGrant).toHaveBeenCalledWith({
      packageName: PKG,
      orgId: null,
      requestedPorts: ["p1", "p2"],
    });
  });

  it("union already recorded (the current grant hash covers it) → NO mutation, NO capsule", async () => {
    const persistCapsule = vi.fn(async () => {});
    const deps = await captureUnionDeps({
      persistCapsule,
      readSiblingDeclaredPorts: async () => ["p1"],
    });
    baseReadGrantForScope.mockResolvedValueOnce({
      status: "approved",
      approvedPorts: ["p1", "p2"],
      requestedPortsHash: portsHash(["p1", "p2"]),
      approvedBy: "admin",
    });
    await (deps.recordRequestedGrant as (g: unknown) => Promise<void>)({
      packageName: PKG,
      orgId: null,
      requestedPorts: ["p2"],
    });
    expect(baseRecordRequestedGrant).not.toHaveBeenCalled();
    expect(persistCapsule).not.toHaveBeenCalled();
  });

  it("empty ports request → no shared-grant mutation, no capsule", async () => {
    const persistCapsule = vi.fn(async () => {});
    const deps = await captureUnionDeps({
      persistCapsule,
      readSiblingDeclaredPorts: async () => ["p1"],
    });
    await (deps.recordRequestedGrant as (g: unknown) => Promise<void>)({
      packageName: PKG,
      orgId: null,
      requestedPorts: [],
    });
    expect(baseRecordRequestedGrant).not.toHaveBeenCalled();
    expect(persistCapsule).not.toHaveBeenCalled();
  });

  it("never AUTO-APPROVES the shared grant from a side-by-side install", async () => {
    const deps = await captureUnionDeps({
      persistCapsule: vi.fn(async () => {}),
      readSiblingDeclaredPorts: async () => ["p1"],
    });
    await (deps.approveGrant as (g: unknown) => Promise<void>)({
      packageName: PKG,
      orgId: null,
      approvedPorts: ["p1"],
      requestedPorts: ["p1"],
      approvedBy: "x",
    });
    expect(baseApproveGrant).not.toHaveBeenCalled();
  });

  it("WITHOUT a capsule sink: the S3 PORTS_NOT_COVERED refusal stands", async () => {
    let deps: Record<string, (...a: never[]) => Promise<unknown>> = {};
    pipelineImpl = async (_i, d) => {
      deps = d as never;
      versionOps["0.3.0"] = { installOpId: "sbs-op", phase: "finalized" };
      return {};
    };
    await installExtensionVersionSideBySide(INPUT); // no grantUnion
    baseReadGrantForScope.mockResolvedValueOnce({ status: "approved", approvedPorts: ["p1"] });
    await expect(
      (deps.recordRequestedGrant as (g: unknown) => Promise<void>)({
        packageName: PKG,
        orgId: null,
        requestedPorts: ["p1", "p9"],
      }),
    ).rejects.toMatchObject({ code: "PORTS_NOT_COVERED" });
  });
});

describe("uninstallExtensionVersionSideBySide — ports reconcile (#1391)", () => {
  beforeEach(() => {
    canonicalRows = [
      defaultRow(),
      defaultRow({ id: "row-sbs", isDefault: false, version: "0.3.0" }),
    ];
    versionOps["0.3.0"] = { installOpId: "sbs-op", phase: "finalized" };
  });

  it("reconciles the shared grant from the capsule — LIFO exact prior restore", async () => {
    grantsReadGrantForScope.mockResolvedValue({
      status: "pending",
      approvedPorts: [],
      requestedPortsHash: portsHash(["p1", "p2"]), // grown pending union
      approvedBy: null,
    });
    await uninstallExtensionVersionSideBySide({
      packageName: PKG,
      version: "0.3.0",
      orgId: null,
      capsule: {
        v: 1,
        declaredTokenKeys: [],
        declaredPorts: ["p2"],
        portsPrior: {
          exists: true,
          status: "approved",
          approvedPorts: ["p1"],
          requestedPortsHash: portsHash(["p1"]),
          approvedBy: "admin",
        },
      },
      readSurvivorDeclaredPorts: async () => ["p1"], // the default survives with p1
    });
    expect(grantsRestoreGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: PKG,
        orgId: null,
        status: "approved",
        approvedPorts: ["p1"],
        requestedPortsHash: portsHash(["p1"]),
        approvedBy: "admin",
      }),
    );
    expect(grantsRecordRequestedGrant).not.toHaveBeenCalled();
  });

  it("capsule-ABSENT explicit uninstall falls back to the live declared ports and corrects to a pending survivor union", async () => {
    grantsReadGrantForScope.mockResolvedValue({
      status: "pending",
      approvedPorts: [],
      requestedPortsHash: portsHash(["p1", "p2"]),
      approvedBy: null,
    });
    await uninstallExtensionVersionSideBySide({
      packageName: PKG,
      version: "0.3.0",
      orgId: null,
      // no capsule (released on batch finalize) → live fallback read of own store
      readTornDownDeclaredPorts: async () => ["p2"],
      readSurvivorDeclaredPorts: async () => ["p1"],
    });
    expect(grantsRecordRequestedGrant).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: PKG, orgId: null, requestedPorts: ["p1"] }),
    );
    expect(grantsRestoreGrant).not.toHaveBeenCalled();
  });

  it("no capsule + no declared ports (legacy member) → NO ports reconcile", async () => {
    await uninstallExtensionVersionSideBySide({
      packageName: PKG,
      version: "0.3.0",
      orgId: null,
      readTornDownDeclaredKeys: async () => [],
      readTornDownDeclaredPorts: async () => [],
    });
    expect(grantsRestoreGrant).not.toHaveBeenCalled();
    expect(grantsRecordRequestedGrant).not.toHaveBeenCalled();
  });
});
