/**
 * cinatra#4264 slice A1: `compileOasAgentJson` runs the regenerate check on the
 * sibling manifest's `cinatra.lifecycle.regenerate` (and, with no readable
 * sibling, on the entries a writer retains from the stored row), and the
 * registry install seed persists a valid declaration and refuses an invalid one.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/oas-compile-regenerate-4264.test.ts
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildAgentTemplateInstallSeed } from "../build-agent-template-seed";
import { compileOasAgentJson } from "../oas-compiler";
import type { AgentPackageManifest } from "../verdaccio/package-contract";

const PACKAGE_NAME = "@cinatra-ai/synthetic-gemini-agent";
const oas = JSON.parse(readFileSync(join(__dirname, "fixtures", "synthetic-gemini-agent.json"), "utf8"));
for (const input of [...oas.inputs, ...oas.$referenced_components.start.inputs]) input.default ??= "";
// The fixture's ApiNode files its own output from the start's `user` input.
const VALID = [{ artifactNode: "call_llm_bridge", step: "call_llm_bridge", noteInput: "user" }];
const BROKEN = [{ artifactNode: "file_image", step: "image_flow", noteInput: "prompt" }];

/** `<tmp>/cinatra/oas.json` plus, unless `manifest` is null, `<tmp>/package.json`. */
function stage(manifest: Record<string, unknown> | null): { dir: string; oasPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "regen-4264-"));
  mkdirSync(join(dir, "cinatra"));
  const oasPath = join(dir, "cinatra", "oas.json");
  writeFileSync(oasPath, JSON.stringify(oas));
  if (manifest) writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  return { dir, oasPath };
}
const pkg = (lifecycle?: Record<string, unknown>) => ({
  name: PACKAGE_NAME,
  version: "0.1.0",
  cinatra: lifecycle ? { lifecycle } : {},
});
const compile = (oasPath: string, retainedRegenerate?: unknown) =>
  compileOasAgentJson({ packageName: PACKAGE_NAME, oasSourcePath: oasPath, retainedRegenerate });

describe("cinatra#4264 A1: compileOasAgentJson and the regenerate declaration", () => {
  it("a valid declaration compiles to the same object as no declaration (A1 adds no compiled field)", async () => {
    const declared = await compile(stage(pkg({ regenerate: VALID })).oasPath);
    const absent = await compile(stage(pkg()).oasPath);
    expect(declared.ok).toBe(true);
    expect(absent.ok).toBe(true);
    expect(declared).toEqual(absent);
  });

  it("an invalid declaration fails the compile with the code", async () => {
    const result = await compile(stage(pkg({ regenerate: BROKEN })).oasPath);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("REGENERATE_DECLARATION_INVALID");
  });

  it("no readable sibling: no check unless the writer retains entries; then the new flow must keep them", async () => {
    const { oasPath } = stage(null);
    expect((await compile(oasPath)).ok).toBe(true);
    expect((await compile(oasPath, VALID)).ok).toBe(true);
    const stale = await compile(oasPath, BROKEN);
    expect(stale.ok).toBe(false);
    expect((stale as { error: string }).error).toContain("REGENERATE_DECLARATION_INVALID");
  });

  it("a readable sibling decides: retained entries are not checked when it declares none (clear)", async () => {
    expect((await compile(stage(pkg()).oasPath, BROKEN)).ok).toBe(true);
  });
});

describe("cinatra#4264 A1: buildAgentTemplateInstallSeed", () => {
  function manifest(regenerate: unknown): AgentPackageManifest {
    return {
      name: PACKAGE_NAME,
      version: "0.1.0",
      description: "seed",
      cinatra: {
        packageType: "agent",
        manifestVersion: 1,
        sourceTemplateId: "synthetic-gemini",
        sourceVersionId: "00000000-0000-0000-0000-000000000001",
        sourceVersionNumber: 1,
        type: "node",
        riskLevel: "low",
        hasApprovalGates: false,
        toolAccess: [],
        ownerOrgId: null,
        lifecycle: { regenerate },
      },
    } as unknown as AgentPackageManifest;
  }
  const seed = (regenerate: unknown) => {
    const m = manifest(regenerate);
    return buildAgentTemplateInstallSeed({
      extractedTempDir: stage(m as unknown as Record<string, unknown>).dir,
      packageName: PACKAGE_NAME,
      packageVersion: "0.1.0",
      manifest: m,
    });
  };

  it("persists a valid list", async () => {
    expect((await seed(VALID)).lifecycleConfig).toBe(
      '{"regenerate":[{"artifactNode":"call_llm_bridge","step":"call_llm_bridge","noteInput":"user"}]}',
    );
  });

  it("throws on an invalid list before a seed exists", async () => {
    await expect(seed(BROKEN)).rejects.toThrow(/REGENERATE_DECLARATION_INVALID/);
  });
});
