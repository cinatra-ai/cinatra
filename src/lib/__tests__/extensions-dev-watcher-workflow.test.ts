import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The `kind:"workflow"` dev-watcher branch is a no-op identifier — workflow
// templates are installed by the workflow marketplace install path
// (`installWorkflowTemplate` in `packages/workflows/src/extension-ops.ts`),
// NOT by the per-package boot scan. The scanner just needs to classify them
// so the boot log says "workflow template" instead of "unknown".

const { registerExtensionSkillMock } = vi.hoisted(() => ({
  registerExtensionSkillMock: vi.fn(),
}));

vi.mock("@cinatra-ai/skills", () => ({
  registerExtensionSkill: registerExtensionSkillMock,
  registerPackageAgentSkill: vi.fn(),
}));

vi.mock("@cinatra-ai/objects/register-artifact-extensions", () => ({
  registerArtifactExtensions: vi.fn(() => 0),
}));

import { __loadOnePackageForTests as loadOnePackage } from "@/lib/extensions-dev-watcher";

let tmpRoot: string;

function writePkg(
  dirName: string,
  pkgJson: Record<string, unknown>,
  skills: Array<{ slug: string; body: string }> = [],
): string {
  const pkgDir = path.join(tmpRoot, dirName);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify(pkgJson, null, 2),
  );
  for (const s of skills) {
    const sd = path.join(pkgDir, "skills", s.slug);
    mkdirSync(sd, { recursive: true });
    writeFileSync(path.join(sd, "SKILL.md"), s.body);
  }
  return pkgDir;
}

describe("loadOnePackage — kind:workflow", () => {
  beforeEach(() => {
    registerExtensionSkillMock.mockReset();
    registerExtensionSkillMock.mockResolvedValue(undefined);
    tmpRoot = mkdtempSync(path.join(tmpdir(), "ext-watcher-workflow-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("classifies a kind:workflow package as workflow without registering skills", async () => {
    const pkgDir = writePkg("major-release-workflow", {
      name: "@cinatra-ai/major-release-workflow",
      version: "1.0.0",
      cinatra: {
        apiVersion: "cinatra.ai/v1",
        kind: "workflow",
        workflow: { key: "major-release", version: 1, name: "Major Release" },
      },
    });

    const res = await loadOnePackage(pkgDir);

    expect(res.kind).toBe("workflow");
    expect(res.skillsRegistered).toBe(0);
    expect(res.agentChanged).toBe(false);
    expect(res.packageName).toBe("@cinatra-ai/major-release-workflow");
    expect(res.packageVersion).toBe("1.0.0");
    expect(registerExtensionSkillMock).not.toHaveBeenCalled();
  });

  it("does not register co-located SKILL.md files for a kind:workflow package", async () => {
    const pkgDir = writePkg(
      "workflow-with-skills-dir",
      {
        name: "@cinatra-ai/workflow-with-skills-dir",
        version: "0.1.0",
        cinatra: { kind: "workflow" },
      },
      [
        { slug: "should-not-register", body: "---\nname: ignored\n---\n" },
      ],
    );

    const res = await loadOnePackage(pkgDir);

    expect(res.kind).toBe("workflow");
    expect(res.skillsRegistered).toBe(0);
    expect(registerExtensionSkillMock).not.toHaveBeenCalled();
  });

  it("falls through to unknown for a package with malformed cinatra.kind, populating packageName/packageVersion", async () => {
    const pkgDir = writePkg("bogus-kind-pkg", {
      name: "@cinatra-ai/bogus-kind-pkg",
      version: "0.0.1",
      cinatra: { kind: "not-a-real-kind" },
    });

    const res = await loadOnePackage(pkgDir);

    expect(res.kind).toBe("unknown");
    expect(res.packageName).toBe("@cinatra-ai/bogus-kind-pkg");
    expect(res.packageVersion).toBe("0.0.1");
    expect(registerExtensionSkillMock).not.toHaveBeenCalled();
  });
});
