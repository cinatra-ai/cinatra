/**
 * buildAgentTemplateInstallSeed.
 *
 * Proves the install path seeds the agent_templates row DIRECTLY from
 * `cinatra/oas.json` + the validated `package.json#cinatra` block, with NO
 * materialized `agent.json` formatVersion:2 payload read, synthesized, or
 * re-parsed.
 *
 * The centerpiece case mirrors `@cinatra-ai/media-transcript-agent`: an OAS-only
 * tarball that ships `cinatra/oas.json` and NO root `agent.json`. Previously
 * the installer required a materialized payload and threw `formatVersion expected
 * 2`; now it derives the row seed from the OAS Flow document.
 *
 * The fixture is the hermetic `synthetic-gemini-agent.json` OAS Flow (a Flow with
 * a StartNode → ApiNode(/api/llm-bridge) → EndNode), staged into a tempdir under
 * `cinatra/oas.json` so the test never depends on the gitignored `extensions/`
 * clone target.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/build-agent-template-seed.test.ts
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { buildAgentTemplateInstallSeed } from "../build-agent-template-seed";
import type { AgentPackageManifest } from "../verdaccio/package-contract";

const OAS_FIXTURE = readFileSync(
  join(__dirname, "fixtures", "synthetic-gemini-agent.json"),
  "utf8",
);

const PACKAGE_NAME = "@cinatra-ai/synthetic-gemini-agent";

function manifest(
  overrides: Partial<AgentPackageManifest["cinatra"]> = {},
  topLevel: Partial<AgentPackageManifest> = {},
): AgentPackageManifest {
  return {
    name: PACKAGE_NAME,
    version: "0.1.0",
    description: "A synthetic agent for the seed-builder test.",
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
      ...overrides,
    },
    ...topLevel,
  } as AgentPackageManifest;
}

/**
 * Stage an OAS-only extracted-package tempdir: `<tmp>/cinatra/oas.json` (+
 * `<tmp>/package.json`), with NO root `agent.json`. Optionally write a decoy
 * root `agent.json` to prove the builder never reads it.
 */
async function stageOasOnlyPackage(opts?: {
  oas?: string;
  withDecoyAgentJson?: boolean;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eng378-seed-"));
  await mkdir(join(dir, "cinatra"), { recursive: true });
  await writeFile(join(dir, "cinatra", "oas.json"), opts?.oas ?? OAS_FIXTURE, "utf8");
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: PACKAGE_NAME, version: "0.1.0" }),
    "utf8",
  );
  if (opts?.withDecoyAgentJson) {
    // A bogus root agent.json that is NOT a conformant formatVersion:2 payload.
    // If the builder read this, it would either poison the seed or throw — it
    // must do neither.
    await writeFile(
      join(dir, "agent.json"),
      JSON.stringify({ totally: "not a payload", formatVersion: 99 }),
      "utf8",
    );
  }
  return dir;
}

describe("buildAgentTemplateInstallSeed (OAS-only direct seed)", () => {
  it("seeds the agent_templates row from cinatra/oas.json with NO root agent.json (the OAS-only case)", async () => {
    const dir = await stageOasOnlyPackage();
    const seed = await buildAgentTemplateInstallSeed({
      extractedTempDir: dir,
      packageName: PACKAGE_NAME,
      packageVersion: "0.1.0",
      manifest: manifest(),
    });

    // name comes from the OAS doc top-level `name`.
    expect(seed.name).toBe("Synthetic Gemini Agent");
    // type is derived from the OAS metadata.cinatra.type ("node").
    expect(seed.type).toBe("node");
    // inputSchema / outputSchema / approvalPolicy come from the OAS compile.
    expect(seed.inputSchema).toMatchObject({ type: "object" });
    expect(Object.keys(seed.inputSchema)).toContain("properties");
    expect(seed.outputSchema).not.toBeNull();
    expect(seed.approvalPolicy).toMatchObject({ steps: [] });
    // OAS flows always compile to an empty compiledPlan.
    expect(seed.compiledPlan).toEqual([]);
    expect(seed.hitlScreens).toEqual([]);
    // lgGraph* are not in the OAS → null for a WayFlow/OAS package.
    expect(seed.lgGraphCode).toBeNull();
    expect(seed.lgGraphId).toBeNull();
    // executionProvider sourced from the manifest (absent here → null).
    expect(seed.executionProvider).toBeNull();
    // contentHash is a full 64-char sha256 hex over the snapshot.
    expect(seed.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("snapshot includes outputSchema + lgGraph* + sourceNl (rollback/diff-stable per )", async () => {
    const dir = await stageOasOnlyPackage();
    const seed = await buildAgentTemplateInstallSeed({
      extractedTempDir: dir,
      packageName: PACKAGE_NAME,
      packageVersion: "0.1.0",
      manifest: manifest(),
    });
    expect(Object.keys(seed.snapshot).sort()).toEqual(
      [
        "approvalPolicy",
        "compiledPlan",
        "inputSchema",
        "lgGraphCode",
        "lgGraphId",
        "name",
        "outputSchema",
        "sourceNl",
        "taskSpec",
        "type",
      ].sort(),
    );
    expect(seed.snapshot.outputSchema).toEqual(seed.outputSchema);
    expect(seed.contentHash).toBe(
      // contentHash is sha256(JSON.stringify(seed.snapshot)) — recompute to pin
      // that the hash is over the exact persisted snapshot object.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("node:crypto")
        .createHash("sha256")
        .update(JSON.stringify(seed.snapshot))
        .digest("hex"),
    );
  });

  it("snapshot/contentHash are BRANCH-STABLE: createLocalAgentTemplateVersion's rebuild is a byte-identical identity (codex finding 1)", async () => {
    // The fresh-install branch routes seed.snapshot through
    // createLocalAgentTemplateVersion, which rebuilds it as
    // `{ ...snapshot, sourceNl, compiledPlan, inputSchema, outputSchema,
    // approvalPolicy, taskSpec }` and re-hashes. The upsert / race branches
    // persist seed.snapshot + seed.contentHash directly. They MUST agree, or a
    // fresh install and a later reinstall would write divergent version rows.
    const dir = await stageOasOnlyPackage();
    const seed = await buildAgentTemplateInstallSeed({
      extractedTempDir: dir,
      packageName: PACKAGE_NAME,
      packageVersion: "0.1.0",
      manifest: manifest(),
    });
    // Reproduce createLocalAgentTemplateVersion's snapshot rebuild exactly.
    const si = seed.snapshot as Record<string, unknown>;
    const rebuilt = {
      ...si,
      sourceNl: typeof si.sourceNl === "string" ? si.sourceNl : seed.sourceNl,
      compiledPlan: Array.isArray(si.compiledPlan) ? si.compiledPlan : [],
      inputSchema: si.inputSchema,
      outputSchema: si.outputSchema ?? null,
      approvalPolicy: si.approvalPolicy,
      taskSpec: typeof si.taskSpec === "string" ? si.taskSpec : null,
    };
    // Byte-identical serialization (same keys, same order) → same hash.
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(seed.snapshot));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const freshHash = require("node:crypto")
      .createHash("sha256")
      .update(JSON.stringify(rebuilt))
      .digest("hex");
    expect(freshHash).toBe(seed.contentHash);
  });

  it("description prefers the manifest description (trimmed) over the OAS description", async () => {
    const dir = await stageOasOnlyPackage();
    const seed = await buildAgentTemplateInstallSeed({
      extractedTempDir: dir,
      packageName: PACKAGE_NAME,
      packageVersion: "0.1.0",
      manifest: manifest({}, { description: "   Manifest wins   " }),
    });
    expect(seed.description).toBe("Manifest wins");
  });

  it("NEVER reads a root agent.json: a decoy agent.json next to cinatra/oas.json is ignored", async () => {
    const dir = await stageOasOnlyPackage({ withDecoyAgentJson: true });
    const seed = await buildAgentTemplateInstallSeed({
      extractedTempDir: dir,
      packageName: PACKAGE_NAME,
      packageVersion: "0.1.0",
      manifest: manifest(),
    });
    // The seed is derived purely from the OAS — the decoy agent.json changed
    // nothing (would have thrown or poisoned the seed if read).
    expect(seed.name).toBe("Synthetic Gemini Agent");
    expect(seed.type).toBe("node");
  });

  it("is deterministic: re-running over the same OAS yields a byte-identical seed (no wall-clock)", async () => {
    const dir1 = await stageOasOnlyPackage();
    const dir2 = await stageOasOnlyPackage();
    const seedA = await buildAgentTemplateInstallSeed({
      extractedTempDir: dir1,
      packageName: PACKAGE_NAME,
      packageVersion: "0.1.0",
      manifest: manifest(),
    });
    const seedB = await buildAgentTemplateInstallSeed({
      extractedTempDir: dir2,
      packageName: PACKAGE_NAME,
      packageVersion: "0.1.0",
      manifest: manifest(),
    });
    expect(seedA.contentHash).toBe(seedB.contentHash);
    expect(seedA.snapshot).toEqual(seedB.snapshot);
  });

  it("CONTRACT NOT WEAKENED: a package with no cinatra/oas.json fails install", async () => {
    // A tempdir with only package.json — no cinatra/oas.json, no agent.json.
    const dir = await mkdtemp(join(tmpdir(), "eng378-seed-empty-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: PACKAGE_NAME, version: "0.1.0" }),
      "utf8",
    );
    await expect(
      buildAgentTemplateInstallSeed({
        extractedTempDir: dir,
        packageName: PACKAGE_NAME,
        packageVersion: "0.1.0",
        manifest: manifest(),
      }),
    ).rejects.toThrow(/failed to compile cinatra\/oas\.json/i);
  });

  it("CONTRACT NOT WEAKENED: an uncompilable (structurally invalid) OAS fails install", async () => {
    const dir = await stageOasOnlyPackage({
      oas: JSON.stringify({ agentspec_version: "26.1.0", component_type: "Flow" }),
    });
    await expect(
      buildAgentTemplateInstallSeed({
        extractedTempDir: dir,
        packageName: PACKAGE_NAME,
        packageVersion: "0.1.0",
        manifest: manifest(),
      }),
    ).rejects.toThrow(/failed to compile cinatra\/oas\.json/i);
  });

  it("FAILS install for executionProvider:'langgraph' (OAS cannot supply the graph; do not silently null)", async () => {
    const dir = await stageOasOnlyPackage();
    await expect(
      buildAgentTemplateInstallSeed({
        extractedTempDir: dir,
        packageName: PACKAGE_NAME,
        packageVersion: "0.1.0",
        manifest: manifest({ executionProvider: "langgraph" }),
      }),
    ).rejects.toThrow(/langgraph/i);
  });
});
