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
vi.mock("@/lib/extension-install-pipeline", () => ({
  installExtensionFromRegistry: (...a: unknown[]) =>
    installExtensionFromRegistry(...(a as [unknown, never])),
  makeDefaultInstallPipelineDeps: async () => ({
    resolveIntegrity: vi.fn(),
    materialize: vi.fn(),
    readRequestedPorts: vi.fn(async () => []),
    preflightMigrations: (...a: unknown[]) => basePreflightMigrations(...(a as [])),
    readGrantForScope: (...a: unknown[]) => baseReadGrantForScope(...(a as [])),
    recordRequestedGrant: vi.fn(),
    approveGrant: vi.fn(),
    activateInProcess: vi.fn(async () => ({ activated: true })),
  }),
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
