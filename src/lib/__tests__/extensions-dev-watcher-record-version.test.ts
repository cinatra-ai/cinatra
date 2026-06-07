import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks so the dev-watcher module loads under vitest (mirrors the
// extensions-dev-watcher-workflow test's top-level mocks), plus the dev-version
// recorder this test asserts on.
vi.mock("@cinatra-ai/skills", () => ({
  registerExtensionSkill: vi.fn(),
  registerPackageAgentSkill: vi.fn(),
  registerColocatedWorkspaceSkills: vi.fn(async () => ({ registered: 0 })),
}));
vi.mock("@cinatra-ai/objects/register-artifact-extensions", () => ({
  registerArtifactExtensions: vi.fn(() => 0),
}));

const { recordDevExtensionVersionMock } = vi.hoisted(() => ({
  recordDevExtensionVersionMock: vi.fn(),
}));
vi.mock("@cinatra-ai/extensions/dev-version", () => ({
  recordDevExtensionVersion: recordDevExtensionVersionMock,
}));

import { recordDevVersionForLoadedPackage } from "@/lib/extensions-dev-watcher";

// The dev watcher records a `0.0.0-dev.<sha>` local-source
// version against the canonical manifest after each package (re)load, so the
// lifecycle UI can render "dev / <sha>". This helper is invoked from BOTH
// loadOnePackage sites — the whole-tree rescan AND the fine-grained file-change
// reload (the common in-editor case). These tests pin the recorder's contract.
describe("recordDevVersionForLoadedPackage (dev-watcher version recording)", () => {
  beforeEach(() => {
    recordDevExtensionVersionMock.mockReset();
    recordDevExtensionVersionMock.mockResolvedValue(undefined);
  });

  it("records a dev version for a recognized kind with a packageName", async () => {
    await recordDevVersionForLoadedPackage(
      { kind: "agent", packageName: "@cinatra-ai/foo-agent" },
      "/tmp/foo",
    );
    expect(recordDevExtensionVersionMock).toHaveBeenCalledTimes(1);
    expect(recordDevExtensionVersionMock).toHaveBeenCalledWith(
      "@cinatra-ai/foo-agent",
      "/tmp/foo",
      { actorSource: "dev-watcher" },
    );
  });

  it("no-ops for an unknown kind", async () => {
    await recordDevVersionForLoadedPackage(
      { kind: "unknown", packageName: "@cinatra-ai/foo" },
      "/tmp/foo",
    );
    expect(recordDevExtensionVersionMock).not.toHaveBeenCalled();
  });

  it("no-ops when packageName is missing", async () => {
    await recordDevVersionForLoadedPackage(
      { kind: "agent", packageName: null },
      "/tmp/foo",
    );
    expect(recordDevExtensionVersionMock).not.toHaveBeenCalled();
  });

  it("is fail-soft — a recorder error never throws (must not break the watcher)", async () => {
    recordDevExtensionVersionMock.mockRejectedValueOnce(new Error("db down"));
    await expect(
      recordDevVersionForLoadedPackage(
        { kind: "skill", packageName: "@cinatra-ai/foo-skills" },
        "/tmp/foo",
      ),
    ).resolves.toBeUndefined();
  });
});
