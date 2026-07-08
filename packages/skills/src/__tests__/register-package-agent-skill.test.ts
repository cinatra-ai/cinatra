/**
 * cinatra#1088 — a co-located agent-skill bundle
 * (`extensions/<vendor>/<agent>/skills/<slug>/SKILL.md`) must register at boot.
 *
 * Root cause: `registerPackageAgentSkill` used to thread a source-mirror
 * `storagePackagePath` (`deriveStoragePackagePathFromSkillMd` → the 3-segment
 * `<vendor>/<agent>/skills`) into `upsertSkill`. For an AGENT-level upsert the
 * disk layout is the fixed `~agents/<vendor>/<package>/<skill>`, so that
 * 3-segment slug split into a multi-segment `pkg` (`<agent>/skills`) that the
 * fail-closed `assertSafePathSegment` rejected — every co-located agent bundle
 * was skipped.
 *
 * The fix: `registerPackageAgentSkill` no longer passes storagePackagePath, so
 * `upsertSkill` derives the canonical `<vendor>/<package>` from the scoped
 * `packageName`. This test guards the fix at its source — it asserts the
 * collaborator call carries NO storagePackagePath — so a re-introduction of the
 * override is caught even though the path-derivation math is proven separately
 * in skills-store-agent-identity.test.ts.
 *
 * `upsertSkill` (the sole collaborator) and the frontmatter parser are mocked so
 * the test stays a pure unit (no DB/fs-store); the SKILL.md is a real on-disk
 * fixture because `registerPackageAgentSkill` reads it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// `vi.mock` factories are hoisted above all top-level statements, so the mock
// fn must be created via `vi.hoisted` to be referenceable inside the factory.
const { upsertSkillMock } = vi.hoisted(() => ({ upsertSkillMock: vi.fn() }));

// Mock the two module deps register-extension-skill pulls: `../skills-store`
// (for upsertSkill) and `../skills-registry` (for parseFrontmatter — real
// skills-registry drags @/lib/agents-store, which we don't want in this unit).
vi.mock("../skills-store", () => ({ upsertSkill: upsertSkillMock }));
vi.mock("../skills-registry", () => ({
  parseFrontmatter: (content: string) => ({
    attributes: { name: "Reviewer Methodology", description: "How to review." },
    body: content,
  }),
}));

import { registerPackageAgentSkill } from "../register-extension-skill";

let root: string;
let skillMdPath: string;

beforeAll(async () => {
  // Realistic co-located layout:
  //   <tmp>/extensions/acme-vendor/reviewer-agent/skills/reviewer-methodology/SKILL.md
  root = await mkdtemp(path.join(tmpdir(), "cinatra-1088-"));
  skillMdPath = path.join(
    root,
    "extensions",
    "acme-vendor",
    "reviewer-agent",
    "skills",
    "reviewer-methodology",
    "SKILL.md",
  );
  await mkdir(path.dirname(skillMdPath), { recursive: true });
  await writeFile(
    skillMdPath,
    "---\nname: Reviewer Methodology\ndescription: How to review.\n---\nBody.\n",
    "utf8",
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  upsertSkillMock.mockReset();
  upsertSkillMock.mockResolvedValue({
    id: "skill-1",
    sourcePath:
      "/store/workspace/~agents/acme-vendor/reviewer-agent/reviewer-methodology/SKILL.md",
  });
});

describe("registerPackageAgentSkill — co-located agent bundle (cinatra#1088)", () => {
  it("does NOT thread a source-mirror storagePackagePath — upsertSkill derives the canonical ~agents path", async () => {
    await registerPackageAgentSkill({
      skillId: "@acme-vendor/reviewer-agent:reviewer-methodology",
      packageName: "@acme-vendor/reviewer-agent",
      skillMdPath,
      agentId: "@acme-vendor/reviewer-agent",
    });

    expect(upsertSkillMock).toHaveBeenCalledTimes(1);
    const arg = upsertSkillMock.mock.calls[0]![0] as Record<string, unknown>;

    // The fix: the 3-segment `<vendor>/<agent>/skills` slug is NOT passed.
    expect(arg).not.toHaveProperty("storagePackagePath");
    expect(arg.storagePackagePath).toBeUndefined();

    // Still an agent-level upsert bound to the owning agent, with the scoped
    // packageName upsertSkill turns into ~agents/<vendor>/<package>.
    expect(arg.type).toBe("agent");
    expect(arg.packageName).toBe("@acme-vendor/reviewer-agent");
    expect(arg.agentId).toBe("@acme-vendor/reviewer-agent");
    expect(arg.skillId).toBe(
      "@acme-vendor/reviewer-agent:reviewer-methodology",
    );
  });
});
