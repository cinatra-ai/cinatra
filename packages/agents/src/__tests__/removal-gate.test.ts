import { describe, it, expect, vi, beforeEach } from "vitest";

// cinatra#1061 — the agent-catalog removal gate. `uninstallRegistryPackage` and
// the agents MCP delete handler used to `deleteAgentTemplate` directly after
// authz only, bypassing BOTH the #1036 system-extension protection AND the
// dependency-closure gate. `assertAgentTemplateRemovable` re-applies them. These
// tests isolate the gate from the DB by mocking the canonical store + the agent
// reverse-dependency reader; the closure predicate and the system-extension
// inventory are the REAL (pure / host-declared) modules.

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

import {
  assertAgentTemplateRemovable,
  listActiveAgentTemplateDependents,
} from "../removal-gate";

// A host-declared system extension (root package.json cinatra.systemExtensions).
const SYSTEM_AGENT = "@cinatra-ai/code-reviewer-agent";
const NON_SYSTEM = "@cinatra-ai/some-connector";

// Minimal InstalledExtension-shaped row: the closure gate reads only
// packageName / status / dependencies.
function row(
  packageName: string,
  dependencies: Array<{ packageName: string; requirement: "required" | "optional"; edgeType: "runtime" | "install-time" | "peer" }> = [],
  status: "active" | "archived" | "locked" = "active",
) {
  return { packageName, status, dependencies } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  listInstalledExtensions.mockResolvedValue([]);
  readEffectiveStatusByPackageNames.mockResolvedValue(new Map());
  readAgentTemplatesDependingOn.mockResolvedValue([]);
});

describe("assertAgentTemplateRemovable — #1036 system-extension protection", () => {
  it("refuses a host-declared system extension BEFORE any store read", async () => {
    await expect(assertAgentTemplateRemovable(SYSTEM_AGENT)).rejects.toMatchObject({
      code: "SYSTEM_EXTENSION_PROTECTED",
    });
    // Guard ran first — no store round-trip.
    expect(listInstalledExtensions).not.toHaveBeenCalled();
  });
});

describe("assertAgentTemplateRemovable — fail-CLOSED on store outage (#1061 req 3)", () => {
  it("REFUSES with ClosureCheckUnavailableError when the canonical store is unreachable", async () => {
    listInstalledExtensions.mockRejectedValueOnce(new Error("db down"));
    await expect(assertAgentTemplateRemovable(NON_SYSTEM)).rejects.toMatchObject({
      code: "CLOSURE_CHECK_UNAVAILABLE",
    });
    // It did NOT silently permit — the agent reverse-dep reader is never reached
    // because the closure check refused first.
    expect(readAgentTemplatesDependingOn).not.toHaveBeenCalled();
  });
});

describe("assertAgentTemplateRemovable — canonical closure", () => {
  it("refuses, NAMING the active canonical dependent that requires the target", async () => {
    listInstalledExtensions.mockResolvedValueOnce([
      row(NON_SYSTEM),
      row("@cinatra-ai/orchestrator", [
        { packageName: NON_SYSTEM, requirement: "required", edgeType: "runtime" },
      ]),
    ]);
    await expect(assertAgentTemplateRemovable(NON_SYSTEM)).rejects.toMatchObject({
      code: "ARCHIVE_BREAKS_CLOSURE",
      dependents: ["@cinatra-ai/orchestrator"],
    });
  });

  it("permits when the only dependent's edge is optional (non-blocking)", async () => {
    listInstalledExtensions.mockResolvedValueOnce([
      row(NON_SYSTEM),
      row("@cinatra-ai/soft-dep", [
        { packageName: NON_SYSTEM, requirement: "optional", edgeType: "runtime" },
      ]),
    ]);
    await expect(assertAgentTemplateRemovable(NON_SYSTEM)).resolves.toBeUndefined();
  });
});

describe("assertAgentTemplateRemovable — legacy agent_templates dependents", () => {
  it("refuses, NAMING an ACTIVE legacy agent dependent", async () => {
    readAgentTemplatesDependingOn.mockResolvedValueOnce([
      { packageName: "@cinatra-ai/leaf", name: "Leaf Agent" },
    ]);
    // effective status map empty ⇒ defaults to "active" (fail-safe block).
    await expect(assertAgentTemplateRemovable(NON_SYSTEM)).rejects.toMatchObject({
      code: "ARCHIVE_BREAKS_CLOSURE",
      dependents: ["Leaf Agent"],
    });
  });

  it("does NOT block on an ARCHIVED legacy dependent", async () => {
    readAgentTemplatesDependingOn.mockResolvedValueOnce([
      { packageName: "@cinatra-ai/leaf", name: "Leaf Agent" },
    ]);
    readEffectiveStatusByPackageNames.mockResolvedValueOnce(
      new Map([["@cinatra-ai/leaf", "archived"]]),
    );
    await expect(assertAgentTemplateRemovable(NON_SYSTEM)).resolves.toBeUndefined();
  });

  it("resolves (permits) when there are no dependents at all", async () => {
    await expect(assertAgentTemplateRemovable(NON_SYSTEM)).resolves.toBeUndefined();
  });
});

describe("listActiveAgentTemplateDependents — non-throwing preview", () => {
  it("returns the union of canonical + active legacy dependents, de-duped", async () => {
    listInstalledExtensions.mockResolvedValueOnce([
      row(NON_SYSTEM),
      row("@cinatra-ai/orchestrator", [
        { packageName: NON_SYSTEM, requirement: "required", edgeType: "runtime" },
      ]),
    ]);
    readAgentTemplatesDependingOn.mockResolvedValueOnce([
      { packageName: "@cinatra-ai/leaf", name: "Leaf Agent" },
    ]);
    const names = await listActiveAgentTemplateDependents(NON_SYSTEM);
    expect(names).toEqual(expect.arrayContaining(["@cinatra-ai/orchestrator", "Leaf Agent"]));
    expect(names).toHaveLength(2);
  });

  it("is best-effort: a store outage yields [] (no throw — the gate stays authoritative)", async () => {
    listInstalledExtensions.mockRejectedValueOnce(new Error("db down"));
    readAgentTemplatesDependingOn.mockRejectedValueOnce(new Error("db down"));
    await expect(listActiveAgentTemplateDependents(NON_SYSTEM)).resolves.toEqual([]);
  });
});
