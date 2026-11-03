import { identityClaimMockFrom } from "./helpers/identity-claim-mock";
/**
 * cinatra#4150: importAgentTemplateCore (the loader and ZIP path) writes the
 * compile's publishingSteps on both of its branches, the CREATE and the
 * adopt/UPSERT patch. The harness is the one of
 * import-agent-core-executed-declaration.test.ts: the REAL function with its
 * collaborators mocked.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/import-agent-core-publishing-steps.test.ts
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const PKG = "@cinatra-ai/blog-idea-generator-agent";

let PUBLISHING_STEPS: string[] = ["publish"];

vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect() must not be reached with { redirect: false }");
  },
}));
vi.mock("@cinatra-ai/extensions/destination-resolver", () => ({
  resolvePublishDestination: async () => ({ registryUrl: "https://registry.test" }),
}));
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: () => null,
}));
vi.mock("@cinatra-ai/extensions/license-detection", () => ({
  detectSpdxLicense: async () => ({ tier: "permissive", spdxId: "Apache-2.0" }),
  LicenseDetectionRejectedError: class extends Error {},
  LicenseAcknowledgementRequiredError: class extends Error {},
}));

vi.mock("../oas-compiler", () => ({
  compileOasAgentJson: async () => ({
    ok: true,
    value: {
      approvalPolicy: { steps: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: null,
      prompt: null,
      packageName: PKG,
      packageVersion: "0.1.0",
      agentDependencies: {},
      type: "leaf",
      compiledPlan: [],
      hitlScreens: [],
      llmConfig: null,
      toolboxes: [],
      agentSpecVersion: "26.1.0",
      triggerMode: "full",
      gatedSteps: [],
      hasArtifactBindings: false,
      artifactBindings: null,
      publishingSteps: PUBLISHING_STEPS,
      cinatraConfig: null,
    },
  }),
}));

const readTemplate = vi.fn(async (): Promise<{ id: string } | null> => null);
const createTemplate = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
const updateTemplate = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
vi.mock("../store", () => ({
  readAgentTemplateByPackageName: (...a: unknown[]) => readTemplate(...(a as [])),
  createAgentTemplate: (...a: unknown[]) => createTemplate(...(a as [])),
  updateAgentTemplate: async (...a: unknown[]) =>
    (await updateTemplate(...(a as []))) ?? { id: (a as [string])[0] },
  createAgentVersion: vi.fn(async () => {}),
  updateAgentTemplateOrigin: vi.fn(async () => {}),
}));
vi.mock("../agent-template-identity", async () =>
  identityClaimMockFrom((n: string) => (readTemplate as (p?: string) => unknown)(n) as never),
);

import { importAgentTemplateCore } from "../import-agent-core";
import { createZipBuffer } from "../zip-helpers";

const OAS = JSON.stringify({
  agentspec_version: "26.1.0",
  component_type: "Flow",
  name: "Blog Idea Generator",
  metadata: { cinatra: { packageName: PKG } },
});

function zip(opts?: { version: string | null }): string {
  const version = opts === undefined ? "0.1.0" : opts.version;
  return createZipBuffer([
    { name: "agent.json", content: OAS },
    { name: "manifest.json", content: JSON.stringify({ version: 1 }) },
    {
      name: "package.json",
      content: JSON.stringify({
        name: PKG,
        ...(version === null ? {} : { version }),
        license: "Apache-2.0",
        cinatra: { type: "flow" },
      }),
    },
  ]).toString("base64");
}

const importZip = () =>
  importAgentTemplateCore(zip(), undefined, { redirect: false, status: "published" });

const createInput = () => createTemplate.mock.calls[0]?.[0] as Record<string, unknown>;
const upsertPatch = () => updateTemplate.mock.calls[0]?.[1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  readTemplate.mockReset();
  readTemplate.mockResolvedValue(null);
  PUBLISHING_STEPS = ["publish"];
});

describe("cinatra#4150 — importAgentTemplateCore persists publishingSteps", () => {
  it("CREATE: the compile's list lands on the fresh row", async () => {
    await importZip();
    expect(createInput().publishingSteps).toEqual(["publish"]);
  });

  it("CREATE: a compile that declares nothing lands an empty list", async () => {
    PUBLISHING_STEPS = [];
    await importZip();
    expect(createInput().publishingSteps).toEqual([]);
  });

  it("UPSERT: the compile's list is re-projected in the one patch, beside packageVersion", async () => {
    readTemplate.mockResolvedValue({ id: "tmpl-existing" });
    await importZip();
    expect(updateTemplate).toHaveBeenCalledTimes(1);
    expect(upsertPatch().publishingSteps).toEqual(["publish"]);
    expect(upsertPatch().packageVersion).toBe("0.1.0");
  });

  it("UPSERT: a version that declares nothing clears the list (an empty list, never omitted)", async () => {
    PUBLISHING_STEPS = [];
    readTemplate.mockResolvedValue({ id: "tmpl-existing" });
    await importZip();
    expect(upsertPatch()).toHaveProperty("publishingSteps", []);
  });
});
