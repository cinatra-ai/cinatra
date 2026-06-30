/**
 * engineering#420 — publishAgentPackage must ship cinatra/oas.json.
 *
 * Verifies the full producer→installer round-trip WITHOUT a live registry:
 *   1. buildAgentPackageFiles emits a `cinatra/oas.json` file.
 *   2. The synthesized OAS is structurally valid (validateOasFlowStructural).
 *   3. Writing the file-set to disk + running the INSTALLER seed builder
 *      (buildAgentTemplateInstallSeed — the exact gate that THREW for
 *      agent.json-only packages post-engineering#378) succeeds and reproduces the
 *      template's row fields (sourceNl, taskSpec, inputSchema, type).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildAgentPackageFiles, buildAgentOasFromTemplate } from "../verdaccio/package-files";
import { validateOasFlowStructural, __resetRegistryCacheForTests } from "../oas-compiler";
import { buildAgentTemplateInstallSeed } from "../build-agent-template-seed";
import { parseAgentPackageManifest } from "../verdaccio/package-contract";
import type { AgentTemplateRecord, AgentVersionRecord } from "../store";
import type { VerdaccioConfig } from "../verdaccio/config";

const CONFIG: VerdaccioConfig = {
  registryUrl: "https://registry.example.test/",
  token: "test-token",
  packageScope: "@test",
} as VerdaccioConfig;

function makeTemplate(overrides: Partial<AgentTemplateRecord> = {}): AgentTemplateRecord {
  return {
    id: "tmpl_abc123",
    orgId: "org_1",
    creatorId: "user_1",
    name: "Lead Researcher",
    description: "Researches leads",
    sourceNl: "Research the given company and produce a summary.",
    compiledPlan: [],
    inputSchema: {
      type: "object",
      required: ["company"],
      properties: {
        company: { type: "string", title: "Company", description: "Target company" },
        depth: { type: "string", title: "Depth", "x-renderer": "@test/x:depth-picker" },
        secret: { type: "string", title: "Secret", "x-hidden": true },
      },
    },
    outputSchema: {
      type: "object",
      properties: { summary: { type: "string", title: "Summary" } },
    },
    approvalPolicy: { steps: [] } as unknown as AgentTemplateRecord["approvalPolicy"],
    status: "published",
    type: "leaf",
    taskSpec: "You are a research assistant. Summarize the company.",
    packageName: "@test/lead-researcher",
    packageVersion: "1.0.0",
    currentVersionId: null,
    hitlScreens: [],
    hitlRequired: false,
    executionProvider: "wayflow",
    lgGraphCode: null,
    lgGraphId: null,
    sourceType: "internal",
    agentUrl: null,
    connectorSlug: null,
    remoteAgentId: null,
    triggerMode: "full",
    ...overrides,
  } as AgentTemplateRecord;
}

function makeVersion(): AgentVersionRecord {
  return {
    id: "ver_1",
    templateId: "tmpl_abc123",
    versionNumber: 1,
    contentHash: "deadbeef",
    snapshot: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
  } as unknown as AgentVersionRecord;
}

let tempDir: string;
beforeEach(async () => {
  __resetRegistryCacheForTests();
  tempDir = await mkdtemp(path.join(tmpdir(), "publish-oas-rt-"));
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe("engineering#420 publishAgentPackage emits cinatra/oas.json", () => {
  it("includes cinatra/oas.json in the file-set", () => {
    const files = buildAgentPackageFiles(
      {
        template: makeTemplate(),
        version: makeVersion(),
        semver: "1.0.0",
        title: "Lead Researcher",
        riskLevel: "low",
        toolAccess: [],
        hasApprovalGates: false,
      },
      CONFIG,
    );
    expect(files.files["cinatra/oas.json"]).toBeTypeOf("string");
    const parsed = JSON.parse(files.files["cinatra/oas.json"]) as Record<string, unknown>;
    expect(parsed.agentspec_version).toBe("26.1.0");
    expect(parsed.component_type).toBe("Flow");
  });

  it("synthesized OAS is structurally valid", () => {
    const oas = buildAgentOasFromTemplate(makeTemplate());
    expect(validateOasFlowStructural(oas)).toEqual([]);
  });

  it("round-trips through the installer seed builder reproducing template fields", async () => {
    const template = makeTemplate();
    const files = buildAgentPackageFiles(
      {
        template,
        version: makeVersion(),
        semver: "1.0.0",
        title: template.name,
        riskLevel: "low",
        toolAccess: [],
        hasApprovalGates: false,
      },
      CONFIG,
    );

    // Materialize the file-set exactly as publishAgentPackage's tar step does.
    for (const [rel, contents] of Object.entries(files.files)) {
      const dest = path.join(tempDir, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, contents, "utf8");
    }

    const manifest = parseAgentPackageManifest(JSON.parse(files.files["package.json"]));

    // The exact installer gate that THREW for agent.json-only packages.
    const seed = await buildAgentTemplateInstallSeed({
      extractedTempDir: tempDir,
      packageName: files.packageName,
      packageVersion: files.packageVersion,
      manifest,
      registryPath: path.join(tempDir, "no-registry.json"), // falls back to {}
    });

    expect(seed.taskSpec).toBe(template.taskSpec);
    expect(seed.sourceNl).toBe(template.sourceNl);
    expect(seed.type).toBe("leaf");
    const props = (seed.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(Object.keys(props).sort()).toEqual(["company", "depth", "secret"]);
    expect(props.depth["x-renderer"]).toBe("@test/x:depth-picker");
    expect(props.secret["x-hidden"]).toBe(true);
    const required = (seed.inputSchema as { required: string[] }).required;
    expect(required).toContain("company");
    expect(seed.outputSchema).not.toBeNull();
  });

  it("preserves a null taskSpec (does not invent one from sourceNl)", async () => {
    const template = makeTemplate({ taskSpec: null });
    const files = buildAgentPackageFiles(
      {
        template,
        version: makeVersion(),
        semver: "1.0.0",
        title: template.name,
        riskLevel: "low",
        toolAccess: [],
        hasApprovalGates: false,
      },
      CONFIG,
    );
    for (const [rel, contents] of Object.entries(files.files)) {
      const dest = path.join(tempDir, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, contents, "utf8");
    }
    const manifest = parseAgentPackageManifest(JSON.parse(files.files["package.json"]));
    const seed = await buildAgentTemplateInstallSeed({
      extractedTempDir: tempDir,
      packageName: files.packageName,
      packageVersion: files.packageVersion,
      manifest,
      registryPath: path.join(tempDir, "no-registry.json"),
    });
    // taskSpec must round-trip as null — NOT sourceNl or "".
    expect(seed.taskSpec).toBeNull();
    // sourceNl is still preserved independently via the OAS-root field.
    expect(seed.sourceNl).toBe(template.sourceNl);
  });

  it("preserves the 4 OAS-expressible types exactly through install", async () => {
    for (const t of ["leaf", "orchestrator", "node", "flow"] as const) {
      const template = makeTemplate({ type: t, id: `tmpl_${t}` });
      const files = buildAgentPackageFiles(
        {
          template,
          version: makeVersion(),
          semver: "1.0.0",
          title: template.name,
          riskLevel: "low",
          toolAccess: [],
          hasApprovalGates: false,
        },
        CONFIG,
      );
      expect(validateOasFlowStructural(JSON.parse(files.files["cinatra/oas.json"]))).toEqual([]);

      const dir = await mkdtemp(path.join(tmpdir(), `publish-oas-type-${t}-`));
      try {
        for (const [rel, contents] of Object.entries(files.files)) {
          const dest = path.join(dir, rel);
          await mkdir(path.dirname(dest), { recursive: true });
          await writeFile(dest, contents, "utf8");
        }
        const manifest = parseAgentPackageManifest(JSON.parse(files.files["package.json"]));
        const seed = await buildAgentTemplateInstallSeed({
          extractedTempDir: dir,
          packageName: files.packageName,
          packageVersion: files.packageVersion,
          manifest,
          registryPath: path.join(dir, "no-registry.json"),
        });
        // The installed row's type equals the authored type — exact round-trip.
        expect(seed.type).toBe(t);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  it("orchestrator subtype collapse: parallel -> orchestrator in OAS, manifest keeps subtype", async () => {
    const template = makeTemplate({ type: "parallel" });
    const oas = buildAgentOasFromTemplate(template);
    expect((oas.metadata as { cinatra: { type: string } }).cinatra.type).toBe("orchestrator");
    expect(validateOasFlowStructural(oas)).toEqual([]);

    const files = buildAgentPackageFiles(
      {
        template,
        version: makeVersion(),
        semver: "1.0.0",
        title: template.name,
        riskLevel: "low",
        toolAccess: [],
        hasApprovalGates: false,
      },
      CONFIG,
    );
    // Manifest retains the authored subtype.
    const manifest = JSON.parse(files.files["package.json"]) as { cinatra: { type: string } };
    expect(manifest.cinatra.type).toBe("parallel");
  });
});
