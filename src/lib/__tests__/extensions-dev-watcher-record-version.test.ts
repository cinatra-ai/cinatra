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
  // cinatra#3788: the record now REFUSES to rewrite an uploaded or a
  // registry-installed row's provenance and reports each refusal. The watcher
  // has to make that visible, at parity with the line a connector refusal
  // produces, or a skipped record is silent in the scan output.
  it("logs one skip line per skipped row, naming the package", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    recordDevExtensionVersionMock.mockResolvedValueOnce({
      ok: true,
      updated: 0,
      version: "0.0.0-dev.abc1234",
      skipped: [
        {
          id: "ext-upload",
          kind: "agent",
          sourceType: "local",
          hasContentDigest: true,
          reason: "the row carries supplied (uploaded) provenance",
        },
        {
          id: "ext-reg",
          kind: "agent",
          sourceType: "verdaccio",
          hasContentDigest: false,
          reason: "the row carries registry provenance",
        },
      ],
    });
    await recordDevVersionForLoadedPackage(
      { kind: "agent", packageName: "@cinatra-ai/foo-agent" },
      "/tmp/foo",
    );
    const lines = info.mock.calls.map((c) => String(c[0]));
    const skips = lines.filter((l) => l.includes("dev-version record skipped"));
    expect(skips).toHaveLength(2);
    for (const line of skips) {
      expect(line).toContain("@cinatra-ai/foo-agent");
    }
    expect(skips[0]).toContain("ext-upload");
    expect(skips[0]).toContain("supplied");
    expect(skips[1]).toContain("ext-reg");
    expect(skips[1]).toContain("registry");
    info.mockRestore();
  });

  it("logs nothing extra and still returns when the record skipped no row", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    recordDevExtensionVersionMock.mockResolvedValueOnce({
      ok: true,
      updated: 1,
      version: "0.0.0-dev.abc1234",
      skipped: [],
    });
    await expect(
      recordDevVersionForLoadedPackage(
        { kind: "agent", packageName: "@cinatra-ai/foo-agent" },
        "/tmp/foo",
      ),
    ).resolves.toBeUndefined();
    expect(
      info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("dev-version record skipped")),
    ).toEqual([]);
    info.mockRestore();
  });
});
