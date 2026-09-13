import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Mocks so the dev-watcher module loads under vitest (mirrors the sibling
// dev-watcher unit tests' top-level mocks), plus the generic install-record
// heal this test asserts on.
vi.mock("@cinatra-ai/skills", () => ({
  registerExtensionSkill: vi.fn(),
  registerPackageAgentSkill: vi.fn(),
  registerColocatedWorkspaceSkills: vi.fn(async () => ({ registered: 0 })),
}));
vi.mock("@cinatra-ai/objects/register-artifact-extensions", () => ({
  registerArtifactExtensions: vi.fn(() => 0),
}));

const { healMissingInstallRecordMock } = vi.hoisted(() => ({
  healMissingInstallRecordMock: vi.fn(),
}));
vi.mock("@/lib/extension-install-anchor", () => ({
  healMissingInstallRecord: healMissingInstallRecordMock,
  healArtifactInstallRecordAndClaims: vi.fn(),
}));

import { healSkillInstallRecordForLoadedPackage } from "@/lib/extensions-dev-watcher";

/**
 * cinatra#3358 — THE MEASURED CAUSE OF THE 404, AND ITS GENERIC REPAIR.
 *
 * A skill package that loads from the in-tree extension tree had its SKILL.md
 * registered and NOTHING else: no canonical `installed_extension` row. The
 * runtime-lifecycle + provisioning gate every run-start passes through reads
 * exactly that row for an agent's DIRECT REQUIRED dependencies, so an agent
 * package declaring a required skill resolved as `missing-required-dependency`
 * and refused to start — and the generic new-run launcher drew that refusal as
 * a 404. Measured on a development boot with both packages installed: every
 * agent package carried a row (its own scan repairs one) while only the
 * bundled, required-in-prod skills did.
 *
 * The repair fires the SAME generic heal the artifact kind already uses, with
 * `kind: "skill"` — so it is correct for ANY skill package in the tree and
 * singles none of them out.
 */
describe("healSkillInstallRecordForLoadedPackage (cinatra#3358)", () => {
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    healMissingInstallRecordMock.mockReset();
    healMissingInstallRecordMock.mockResolvedValue({ outcome: "already-live", rowId: "r1" });
    info = vi.spyOn(console, "info").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
    vi.restoreAllMocks();
  });

  it("heals a loaded skill package's ABSENT install record, keyed on the skill kind", async () => {
    healMissingInstallRecordMock.mockResolvedValueOnce({ outcome: "repaired", rowId: "row-9" });
    await healSkillInstallRecordForLoadedPackage(
      { kind: "skill", packageName: "@cinatra-ai/some-curation-skill", packageVersion: "0.1.0" },
      "/tmp/extensions/cinatra-ai/some-curation-skill",
    );
    expect(healMissingInstallRecordMock).toHaveBeenCalledTimes(1);
    expect(healMissingInstallRecordMock).toHaveBeenCalledWith({
      packageName: "@cinatra-ai/some-curation-skill",
      kind: "skill",
      packageDir: "/tmp/extensions/cinatra-ai/some-curation-skill",
      version: "0.1.0",
    });
    expect(info).toHaveBeenCalled();
  });

  it("stays quiet when the record is already live (the idempotent re-fire)", async () => {
    await healSkillInstallRecordForLoadedPackage(
      { kind: "skill", packageName: "@cinatra-ai/some-curation-skill", packageVersion: "0.1.0" },
      "/tmp/pkg",
    );
    expect(healMissingInstallRecordMock).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("SURFACES a deliberate refusal, so the reason lands in the boot log and not in a 404", async () => {
    healMissingInstallRecordMock.mockResolvedValueOnce({
      outcome: "refused-archived",
      reason: "a non-live row exists",
    });
    await healSkillInstallRecordForLoadedPackage(
      { kind: "skill", packageName: "@cinatra-ai/some-curation-skill", packageVersion: "0.1.0" },
      "/tmp/pkg",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("refused-archived");
  });

  it("no-ops for every other kind (the artifact heal owns its own)", async () => {
    for (const kind of ["artifact", "agent", "connector", "unknown"]) {
      await healSkillInstallRecordForLoadedPackage(
        { kind, packageName: "@cinatra-ai/x", packageVersion: "1.0.0" },
        "/tmp/pkg",
      );
    }
    expect(healMissingInstallRecordMock).not.toHaveBeenCalled();
  });

  it("no-ops when the loaded package has no packageName", async () => {
    await healSkillInstallRecordForLoadedPackage(
      { kind: "skill", packageName: null, packageVersion: "0.1.0" },
      "/tmp/pkg",
    );
    expect(healMissingInstallRecordMock).not.toHaveBeenCalled();
  });

  it("is fail-soft — a heal error never throws (must not break a boot scan)", async () => {
    healMissingInstallRecordMock.mockRejectedValueOnce(new Error("store down"));
    await expect(
      healSkillInstallRecordForLoadedPackage(
        { kind: "skill", packageName: "@cinatra-ai/some-curation-skill", packageVersion: "0.1.0" },
        "/tmp/pkg",
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe("the heal fires on the paths that actually load a skill package", () => {
  it("is asked on the targeted reload, not only on the whole-tree scan", () => {
    // A skill added or retried after boot reloads through the per-package watcher
    // path. Without the heal there it registers its SKILL.md and stays
    // unrunnable — an agent that requires it is refused on a link the product
    // itself offers — until the next full scan or a restart.
    const SRC = readFileSync(
      fileURLToPath(new URL("../extensions-dev-watcher.ts", import.meta.url)),
      "utf8",
    );
    const targeted = SRC.slice(SRC.indexOf("for (const vendorSlug of targets) {"));
    const skillBranch = targeted.slice(
      targeted.indexOf('} else if (res.kind === "skill") {'),
      targeted.indexOf('} else if (res.kind === "connector") {'),
    );
    expect(skillBranch).toContain("healSkillInstallRecordForLoadedPackage(res, pkgDir)");
  });
});
