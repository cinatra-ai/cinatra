import { describe, it, expect, vi, beforeEach } from "vitest";

// cinatra#1927 — PATH 1 of 2: the GENERIC pipeline.
//
// `assertNoLockedCanonicalRow` is the kind-agnostic destructive backstop every
// dispatcher entry point runs (archive / uninstall / force_delete / purge /
// registry_remove). This test proves the declaration-driven refusal is wired
// INTO that choke-point — not merely available as a helper — and that it is
// resolved SERVER-SIDE from the package's own declaration, so a forged request
// (any caller reaching the primitive directly: MCP, CLI, a hand-crafted
// server-action POST) is refused exactly like the UI path.

const resolveDeclaredProtectionForPackage = vi.fn(async (_pkg: string) => false);
vi.mock("@/lib/extension-protection-host", () => ({
  resolveDeclaredProtectionForPackage: (pkg: string) => resolveDeclaredProtectionForPackage(pkg),
  readDeclaredProtectionFromStore: async () => false,
}));

// --- the minimum needed to import the dispatcher barrel DB-free --------------
vi.mock("@cinatra-ai/agents", () => ({
  readAgentTemplateByPackageName: vi.fn(),
  countRunsForTemplate: vi.fn(),
  readAgentTemplatesDependingOn: vi.fn(),
  withInstallLock: vi.fn((_name: string, fn: () => unknown) => fn()),
  removeReferencingRunRows: vi.fn(async () => {}),
}));
vi.mock("../audit-log", () => ({
  computeDanglingReferences: vi.fn(async () => ({})),
  writeExtensionLifecycleAuditEntry: vi.fn(async () => {}),
  writeExtensionLifecycleTransitionAudit: vi.fn(async () => {}),
}));
const readInstalledExtensionsByPackageName = vi.fn(async (_pkg: string) => [] as unknown[]);
vi.mock("../canonical-store", () => ({
  readInstalledExtensionsByPackageName: (pkg: string) => readInstalledExtensionsByPackageName(pkg),
  readInstalledExtensionById: vi.fn(async () => null),
  listInstalledExtensions: vi.fn(async () => []),
  readEffectiveStatusByPackageNames: vi.fn(async () => new Map()),
}));
vi.mock("../lifecycle-primitive", () => ({
  installExtensionManifest: vi.fn(async () => ({})),
  transitionExtensionLifecycle: vi.fn(async () => null),
  deleteNonFinalizedCanonicalRow: vi.fn(async () => {}),
}));
vi.mock("../activate-hook", () => ({
  fireExtensionActivate: vi.fn(async () => ({
    finalized: true,
    activated: false,
    reason: "metadata-only-kind",
  })),
}));

import { assertNoLockedCanonicalRow } from "../index";

const PROTECTED = "@acme/protected-thing";
const ORDINARY = "@acme/ordinary-thing";

const DESTRUCTIVE_OPS = [
  "archive",
  "uninstall",
  "force_delete",
  "purge",
  "registry_remove",
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  readInstalledExtensionsByPackageName.mockResolvedValue([]);
  resolveDeclaredProtectionForPackage.mockImplementation(async (pkg: string) => pkg === PROTECTED);
});

describe("generic pipeline — assertNoLockedCanonicalRow refuses a PROTECTED extension", () => {
  it.each(DESTRUCTIVE_OPS)("refuses `%s`", async (op) => {
    await expect(assertNoLockedCanonicalRow(PROTECTED, op)).rejects.toMatchObject({
      code: "DECLARED_PROTECTED_EXTENSION",
    });
  });

  it("resolves the verdict SERVER-SIDE from the package's own declaration", async () => {
    await expect(assertNoLockedCanonicalRow(PROTECTED, "uninstall")).rejects.toMatchObject({
      code: "DECLARED_PROTECTED_EXTENSION",
    });
    // Nothing about the CALL decided this — only the package name was consulted,
    // and the answer came from the host-side declaration reader.
    expect(resolveDeclaredProtectionForPackage).toHaveBeenCalledWith(PROTECTED);
  });

  it("refuses BEFORE the canonical-store read — a forged request cannot dodge it via row state", async () => {
    await expect(assertNoLockedCanonicalRow(PROTECTED, "uninstall")).rejects.toMatchObject({
      code: "DECLARED_PROTECTED_EXTENSION",
    });
    expect(readInstalledExtensionsByPackageName).not.toHaveBeenCalled();
  });

  it("still refuses when the canonical store is UNREACHABLE (protection is not row state)", async () => {
    readInstalledExtensionsByPackageName.mockRejectedValue(new Error("db down"));
    await expect(assertNoLockedCanonicalRow(PROTECTED, "uninstall")).rejects.toMatchObject({
      code: "DECLARED_PROTECTED_EXTENSION",
    });
  });

  it("FAILS CLOSED when the declaration is present but unreadable", async () => {
    resolveDeclaredProtectionForPackage.mockRejectedValue(
      new Error("[extension-protection-host] cinatra/config.json for x exists but is unreadable"),
    );
    await expect(assertNoLockedCanonicalRow(ORDINARY, "uninstall")).rejects.toThrow(/unreadable/);
  });
});

describe("generic pipeline — an UNPROTECTED extension is unaffected", () => {
  it.each(DESTRUCTIVE_OPS)("permits `%s` and proceeds to the canonical-store check", async (op) => {
    await expect(assertNoLockedCanonicalRow(ORDINARY, op)).resolves.toBeUndefined();
    expect(readInstalledExtensionsByPackageName).toHaveBeenCalledWith(ORDINARY);
  });

  it("does not disturb the pre-existing `locked` refusal", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([
      { status: "locked", requiredInProd: true },
    ]);
    await expect(assertNoLockedCanonicalRow(ORDINARY, "uninstall")).rejects.toThrow(
      /extension is locked \(required-in-prod\)/,
    );
  });
});
