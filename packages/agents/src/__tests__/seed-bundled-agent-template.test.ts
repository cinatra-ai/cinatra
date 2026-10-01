/**
 * ensureBundledAgentTemplateRecord — the chat-resolvable agent record a
 * dev-fleet image seeds at boot.
 *
 * What this pins is the ROAD, not a literal: the row is derived by
 * `buildAgentTemplateInstallSeed` (REAL here, together with the manifest
 * contract parse and the package-id splitter) from the package tree the IMAGE
 * ships in its OAS seed — the same derivation a registry install and a ZIP
 * import run — and written through the shared creation path under the instance
 * operator's identity claim. Only the three DB-touching seams are mocked
 * (the template read, the identity claim and the creation path), so a
 * hand-written template could not pass this suite: the asserted fields come out
 * of the fixture's own OAS bytes.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/seed-bundled-agent-template.test.ts
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readAgentTemplateByPackageName = vi.fn<(p: string) => Promise<unknown>>(async () => null);
const createLocalAgentTemplateVersion = vi.fn(
  async (_input: { seed: Record<string, unknown> }) => ({
    templateId: "tpl_seeded",
    versionId: "ver_seeded",
  }),
);
const claimAgentTemplateIdentity = vi.fn(
  async (
    _input: { packageName: string; claim: unknown },
    ops: { insert: () => Promise<{ templateId: string; versionId: string }> },
  ) => ({ mode: "created" as const, created: await ops.insert() }),
);

vi.mock("../store", () => ({
  readAgentTemplateByPackageName: (p: string) => readAgentTemplateByPackageName(p),
}));
vi.mock("../import-export-actions", () => ({
  createLocalAgentTemplateVersion: (input: { seed: Record<string, unknown> }) =>
    createLocalAgentTemplateVersion(input),
}));
vi.mock("../agent-template-identity", () => ({
  PLATFORM_IDENTITY_CLAIM: { kind: "platform" },
  claimAgentTemplateIdentity: (...args: unknown[]) =>
    claimAgentTemplateIdentity(...(args as Parameters<typeof claimAgentTemplateIdentity>)),
}));

import {
  bundledAgentPackageDir,
  ensureBundledAgentTemplateRecord,
} from "../seed-bundled-agent-template";

const OAS_FIXTURE = readFileSync(
  join(__dirname, "fixtures", "synthetic-gemini-agent.json"),
  "utf8",
);

const PACKAGE_NAME = "@cinatra-ai/synthetic-gemini-agent";
const VERSION = "0.1.0";

const cinatraBlock = {
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
};

/** Stage an image OAS seed root holding ONE package tree, seed-shaped. */
async function stageSeed(opts?: { oas?: string; manifest?: Record<string, unknown> }) {
  const seedDir = await mkdtemp(join(tmpdir(), "bundled-agent-seed-"));
  const packageDir = join(seedDir, "cinatra-ai", "synthetic-gemini-agent");
  await mkdir(join(packageDir, "cinatra"), { recursive: true });
  await writeFile(join(packageDir, "cinatra", "oas.json"), opts?.oas ?? OAS_FIXTURE, "utf8");
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify(
      opts?.manifest ?? {
        name: PACKAGE_NAME,
        version: VERSION,
        description: "A synthetic agent for the bundled-seed test.",
        cinatra: cinatraBlock,
      },
    ),
    "utf8",
  );
  return { seedDir, packageDir };
}

const seedArg = () => createLocalAgentTemplateVersion.mock.calls[0][0].seed;

beforeEach(() => {
  vi.clearAllMocks();
  readAgentTemplateByPackageName.mockResolvedValue(null);
  createLocalAgentTemplateVersion.mockResolvedValue({
    templateId: "tpl_seeded",
    versionId: "ver_seeded",
  });
  claimAgentTemplateIdentity.mockImplementation(async (_input, ops) => ({
    mode: "created" as const,
    created: await ops.insert(),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ensureBundledAgentTemplateRecord", () => {
  it("creates the row the chat's run resolver reads, derived from the image's own OAS bytes", async () => {
    const { seedDir } = await stageSeed();
    const outcome = await ensureBundledAgentTemplateRecord({
      packageName: PACKAGE_NAME,
      packageVersion: VERSION,
      seedDir,
    });

    expect(outcome).toEqual({
      outcome: "created",
      templateId: "tpl_seeded",
      versionId: "ver_seeded",
    });
    const seed = seedArg();
    // The identity the resolver looks the row up by.
    expect(seed.packageName).toBe(PACKAGE_NAME);
    expect(seed.packageVersion).toBe(VERSION);
    // Fields that can only come from compiling the fixture's OAS document.
    expect(seed.name).toBe("Synthetic Gemini Agent");
    expect(seed.type).toBe("node");
    expect(seed.inputSchema).toMatchObject({ type: "object" });
    expect(seed.compiledPlan).toEqual([]);
    // The image's catalogue is the instance's own published set.
    expect(seed.status).toBe("published");
  });

  it("writes under the INSTANCE OPERATOR's identity claim, through the shared claim operation", async () => {
    const { seedDir } = await stageSeed();
    await ensureBundledAgentTemplateRecord({
      packageName: PACKAGE_NAME,
      packageVersion: VERSION,
      seedDir,
    });
    expect(claimAgentTemplateIdentity).toHaveBeenCalledTimes(1);
    const [input] = claimAgentTemplateIdentity.mock.calls[0];
    expect(input).toMatchObject({ packageName: PACKAGE_NAME, claim: { kind: "platform" } });
  });

  it("a name a tenant already claimed is ADOPTED, never overwritten", async () => {
    const { seedDir } = await stageSeed();
    claimAgentTemplateIdentity.mockImplementation(
      async () => ({ mode: "adopted", row: { id: "tpl_tenant" } }) as never,
    );
    const outcome = await ensureBundledAgentTemplateRecord({
      packageName: PACKAGE_NAME,
      packageVersion: VERSION,
      seedDir,
    });
    expect(outcome).toEqual({ outcome: "adopted", templateId: "tpl_tenant" });
  });

  it("is idempotent: an existing row is left completely alone — no compile, no write", async () => {
    const { seedDir } = await stageSeed();
    readAgentTemplateByPackageName.mockResolvedValue({ id: "tpl_existing" });
    const outcome = await ensureBundledAgentTemplateRecord({
      packageName: PACKAGE_NAME,
      packageVersion: VERSION,
      seedDir,
    });
    expect(outcome).toEqual({ outcome: "exists" });
    expect(claimAgentTemplateIdentity).not.toHaveBeenCalled();
    expect(createLocalAgentTemplateVersion).not.toHaveBeenCalled();
  });

  it("a package the seed does not carry is reported ABSENT, not thrown", async () => {
    const { seedDir } = await stageSeed();
    const outcome = await ensureBundledAgentTemplateRecord({
      packageName: "@cinatra-ai/not-in-this-image",
      packageVersion: "1.0.0",
      seedDir,
    });
    expect(outcome.outcome).toBe("absent");
    expect(createLocalAgentTemplateVersion).not.toHaveBeenCalled();
  });

  it("an uncompilable OAS THROWS before any write, exactly as it does at install", async () => {
    const { seedDir } = await stageSeed({ oas: JSON.stringify({ not: "an oas flow" }) });
    await expect(
      ensureBundledAgentTemplateRecord({
        packageName: PACKAGE_NAME,
        packageVersion: VERSION,
        seedDir,
      }),
    ).rejects.toThrow();
    expect(createLocalAgentTemplateVersion).not.toHaveBeenCalled();
  });

  it("splits the package name through the canonical splitter — a traversal payload never reaches the join", () => {
    expect(bundledAgentPackageDir("/seed", PACKAGE_NAME)).toBe(
      join("/seed", "cinatra-ai", "synthetic-gemini-agent"),
    );
    expect(bundledAgentPackageDir("/seed", "unscoped-name")).toBeNull();
    expect(bundledAgentPackageDir("/seed", "@cinatra-ai/../../etc")).toBeNull();
  });
});
