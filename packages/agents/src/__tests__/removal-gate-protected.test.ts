import { describe, it, expect, vi, beforeEach } from "vitest";

// cinatra#1927 — PATH 2 of 2: the DIRECT agent-registry installer.
//
// `assertAgentTemplateRemovable` is the gate the agent-catalog
// `uninstallRegistryPackage` server action and the agents MCP delete handler
// run before `deleteAgentTemplate`. It does NOT go through
// `extensionRegistry.uninstall`, so the generic dispatcher's refusal does not
// cover it — this test proves the declaration-driven refusal is wired here too,
// with the SAME error contract, and that it fires BEFORE any store read (so a
// forged/direct delete call cannot slip past it by manipulating store state).

const resolveDeclaredProtectionForPackage = vi.fn(async (_pkg: string) => false);
vi.mock("@/lib/extension-protection-host", () => ({
  resolveDeclaredProtectionForPackage: (pkg: string) => resolveDeclaredProtectionForPackage(pkg),
  readDeclaredProtectionFromStore: async () => false,
}));

const listInstalledExtensions = vi.fn();
const readEffectiveStatusByPackageNames = vi.fn();
const readAgentTemplatesDependingOn = vi.fn();

vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: (...a: unknown[]) => listInstalledExtensions(...a),
  readEffectiveStatusByPackageNames: (...a: unknown[]) => readEffectiveStatusByPackageNames(...a),
}));

vi.mock("../store", () => ({
  readAgentTemplatesDependingOn: (...a: unknown[]) => readAgentTemplatesDependingOn(...a),
}));

import { assertAgentTemplateRemovable } from "../removal-gate";

const PROTECTED = "@acme/protected-agent";
const ORDINARY = "@acme/ordinary-agent";

beforeEach(() => {
  vi.clearAllMocks();
  listInstalledExtensions.mockResolvedValue([]);
  readEffectiveStatusByPackageNames.mockResolvedValue(new Map());
  readAgentTemplatesDependingOn.mockResolvedValue([]);
  resolveDeclaredProtectionForPackage.mockImplementation(async (pkg: string) => pkg === PROTECTED);
});

describe("direct agent-registry installer — a PROTECTED extension is refused", () => {
  it("refuses removal with the shared DECLARED_PROTECTED_EXTENSION contract", async () => {
    await expect(assertAgentTemplateRemovable(PROTECTED)).rejects.toMatchObject({
      code: "DECLARED_PROTECTED_EXTENSION",
      name: "ProtectedExtensionRemovalError",
      packageName: PROTECTED,
    });
  });

  it("refuses BEFORE any store read — a forged direct call cannot dodge it", async () => {
    await expect(assertAgentTemplateRemovable(PROTECTED)).rejects.toMatchObject({
      code: "DECLARED_PROTECTED_EXTENSION",
    });
    expect(listInstalledExtensions).not.toHaveBeenCalled();
    expect(readAgentTemplatesDependingOn).not.toHaveBeenCalled();
  });

  it("refuses even when NOTHING depends on it (protection is not a closure fact)", async () => {
    listInstalledExtensions.mockResolvedValue([]);
    readAgentTemplatesDependingOn.mockResolvedValue([]);
    await expect(assertAgentTemplateRemovable(PROTECTED)).rejects.toMatchObject({
      code: "DECLARED_PROTECTED_EXTENSION",
    });
  });

  it("the verdict comes from the package's own declaration, resolved server-side", async () => {
    await expect(assertAgentTemplateRemovable(PROTECTED)).rejects.toBeTruthy();
    expect(resolveDeclaredProtectionForPackage).toHaveBeenCalledWith(PROTECTED);
  });

  it("FAILS CLOSED when the declaration is present but unreadable", async () => {
    resolveDeclaredProtectionForPackage.mockRejectedValue(
      new Error("[extension-protection-host] cinatra/config.json for x exists but is unreadable"),
    );
    await expect(assertAgentTemplateRemovable(ORDINARY)).rejects.toThrow(/unreadable/);
  });
});

describe("direct agent-registry installer — an UNPROTECTED extension is unaffected", () => {
  it("permits removal and still runs the pre-existing closure checks", async () => {
    await expect(assertAgentTemplateRemovable(ORDINARY)).resolves.toBeUndefined();
    expect(listInstalledExtensions).toHaveBeenCalled();
    expect(readAgentTemplatesDependingOn).toHaveBeenCalledWith(ORDINARY);
  });

  it("does not mask the pre-existing dependents refusal", async () => {
    readAgentTemplatesDependingOn.mockResolvedValue([
      { packageName: "@acme/dependent", name: "Dependent" },
    ]);
    readEffectiveStatusByPackageNames.mockResolvedValue(new Map([["@acme/dependent", "active"]]));
    await expect(assertAgentTemplateRemovable(ORDINARY)).rejects.toMatchObject({
      code: "ARCHIVE_BREAKS_CLOSURE",
    });
  });
});
