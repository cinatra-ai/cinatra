// cinatra#659 CG-1 (HARD) — fresh-instance regression proof for the SKILL
// runtime-discovery predicate. The skills resolver already routes skill
// resolvability through the canonical `installed_extension` lifecycle
// (`filterRetiredSkillExtensions`), flipping fail-OPEN -> drop-on-tombstone. CG-1
// requires that this fail-closed flip NOT blank a BUNDLED metadata-only skill that
// legitimately has NO canonical row on a fresh instance (the boot seeder anchors a
// row only for serverEntry / required-in-prod packages; a bundled skill has none).
//
// This pins the three cases directly on the exported predicate (no disk scan):
//   - a RUNTIME-archived (tombstoned) skill extension is DROPPED (fail-closed);
//   - a BUNDLED skill with NO canonical row is KEPT (CG-1 fresh-instance floor);
//   - a degraded status store keeps ALL scanned extensions (fail-open seed).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { lifecycleStatusMock } = vi.hoisted(() => ({ lifecycleStatusMock: vi.fn() }));
// `filterRetiredSkillExtensions` reads lifecycle status via a fail-soft dynamic
// `import("@cinatra-ai/extensions")`. Mock only that IO boundary.
vi.mock("@cinatra-ai/extensions", () => ({
  readEffectiveStatusByPackageNames: (names: string[]) => lifecycleStatusMock(names),
}));
// Stub the registration module so its transitive skills-store -> mcp-server import
// chain is not pulled into this unit test (filterRetiredSkillExtensions never registers).
vi.mock("../register-extension-skill", () => ({
  registerExtensionSkill: vi.fn(),
  deriveStoragePackagePathFromSkillMd: vi.fn(),
}));

import { filterRetiredSkillExtensions } from "../extension-skill-resolver";
import type { SkillExtensionDescriptor } from "../extension-skill-resolver";

function ext(pkgName: string): SkillExtensionDescriptor {
  return {
    pkgDir: `/img/extensions/cinatra-ai/${pkgName.split("/").pop()}`,
    pkgName,
    pkgDirName: pkgName.split("/").pop() ?? pkgName,
    kind: "skill",
    capabilities: {},
    slugs: ["s1"],
  };
}

describe("skill runtime-lifecycle predicate — CG-1 fresh-instance regression (cinatra#659)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("CG-1: a BUNDLED skill with NO canonical row stays resolvable on a fresh instance", async () => {
    // Fresh instance: the canonical store has NO rows for the bundled skill →
    // empty status map. The fail-closed flip must NOT blank it.
    lifecycleStatusMock.mockResolvedValue(new Map<string, "active" | "archived">());
    const kept = await filterRetiredSkillExtensions([ext("@cinatra-ai/blog-skills")]);
    expect(kept.map((e) => e.pkgName)).toEqual(["@cinatra-ai/blog-skills"]);
  });

  it("fail-CLOSED: a RUNTIME-archived (tombstoned) skill extension is dropped", async () => {
    lifecycleStatusMock.mockResolvedValue(
      new Map<string, "active" | "archived">([["@x/disabled-skill", "archived"]]),
    );
    const kept = await filterRetiredSkillExtensions([ext("@x/disabled-skill")]);
    expect(kept).toEqual([]);
  });

  it("keeps an ACTIVE runtime-installed skill extension", async () => {
    lifecycleStatusMock.mockResolvedValue(
      new Map<string, "active" | "archived">([["@x/live-skill", "active"]]),
    );
    const kept = await filterRetiredSkillExtensions([ext("@x/live-skill")]);
    expect(kept.map((e) => e.pkgName)).toEqual(["@x/live-skill"]);
  });

  it("fail-OPEN on a degraded status store: keeps every scanned extension (seed)", async () => {
    lifecycleStatusMock.mockRejectedValue(new Error("status store down"));
    const kept = await filterRetiredSkillExtensions([ext("@x/a"), ext("@x/b")]);
    expect(kept.map((e) => e.pkgName).sort()).toEqual(["@x/a", "@x/b"]);
  });
});
