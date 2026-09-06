import { identityClaimMockFrom } from "./helpers/identity-claim-mock";
/**
 * cinatra#3208, hop 2 of 3 — `importAgentTemplateCore` (the loader / ZIP path)
 * must persist the EXECUTED artifact-binding declaration on the template row,
 * exactly as `installAgentFromPackage` (the registry path) does.
 *
 * The negative proof this file pins: this function already re-projects the
 * compiler's `hasArtifactBindings` PRESENCE flag on both of its branches
 * (import-agent-core.ts, the CREATE call and the adopt/UPSERT patch) but never
 * carried the declaration itself. Every install that arrives through the loader
 * / ZIP path — the dev-boot git-file scan, the hot-reload watcher, `cinatra
 * setup`, the `data/downloads` system-agent path, the UI and MCP ZIP imports —
 * therefore landed `has_artifact_bindings = true` beside
 * `artifact_bindings = NULL`. NULL reads as "unknown", so the run-completion
 * materializer fell back to its pre-#3208 registry re-read and could once again
 * resolve a declaration the run never executed: the exact failure #3208
 * reports, on the path a DEV boot installs the blog-idea-generator agent by.
 *
 * The presence flag and the declaration must move TOGETHER or the row is
 * self-contradictory — it claims bindings exist while offering no way to read
 * the ones this version actually compiled.
 *
 * Harness mirrors `import-agent-core-lifecycle-config.test.ts`: the REAL
 * `importAgentTemplateCore` with its collaborators mocked.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/import-agent-core-executed-declaration.test.ts
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const PKG = "@cinatra-ai/blog-idea-generator-agent";

/** The fan-out declaration the fixture compile returns (the shape the real
 * blog-idea-generator agent declares: one member-mode fan-out binding). */
const FAN_OUT_DECLARATION = {
  bindings: [
    {
      nodeId: "endNode",
      outputId: "ideas",
      binding: {
        extension: "@cinatra-ai/blog-idea-artifact",
        contentFrom: "ideas",
        declaredMime: "text/plain",
        fanOut: { mode: "member", titleFrom: "first-line", titlePrefix: "Title:" },
      },
    },
  ],
  producesRefs: [{ extension: "@cinatra-ai/blog-idea-artifact" }],
};

/** Swapped per-case so a compile with no readable sibling manifest can be driven. */
let ARTIFACT_BINDINGS: typeof FAN_OUT_DECLARATION | null = FAN_OUT_DECLARATION;
let HAS_ARTIFACT_BINDINGS = true;
/** Swapped per-case so a VERSIONLESS re-import can be driven (codex round). */
let COMPILED_PACKAGE_VERSION: string | null = "0.1.0";

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
      packageVersion: COMPILED_PACKAGE_VERSION,
      agentDependencies: {},
      type: "leaf",
      compiledPlan: [],
      hitlScreens: [],
      llmConfig: null,
      toolboxes: [],
      agentSpecVersion: "26.1.0",
      triggerMode: "full",
      gatedSteps: [],
      hasArtifactBindings: HAS_ARTIFACT_BINDINGS,
      artifactBindings: ARTIFACT_BINDINGS,
      cinatraConfig: null,
    },
  }),
}));

const readTemplate = vi.fn(async (): Promise<{ id: string } | null> => null);
const createTemplate = vi.fn(async (..._a: unknown[]) => {});
const updateTemplate = vi.fn(async (..._a: unknown[]) => {});
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
import { parseArtifactBindingDeclaration } from "../artifact-binding";

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
  ARTIFACT_BINDINGS = FAN_OUT_DECLARATION;
  HAS_ARTIFACT_BINDINGS = true;
  COMPILED_PACKAGE_VERSION = "0.1.0";
});

describe("cinatra#3208 — importAgentTemplateCore persists the executed artifact-binding declaration", () => {
  it("CREATE: the compile's declaration lands on the fresh row as JSON-as-text", async () => {
    await importZip();
    const parsed = parseArtifactBindingDeclaration(createInput().artifactBindings as string);
    expect(parsed).toEqual(FAN_OUT_DECLARATION);
  });

  it("CREATE: the declaration and the presence flag agree (never true beside an unreadable declaration)", async () => {
    await importZip();
    const row = createInput();
    expect(row.hasArtifactBindings).toBe(true);
    expect(parseArtifactBindingDeclaration(row.artifactBindings as string)).not.toBeNull();
  });

  it("CREATE: a compile with no readable sibling manifest lands null (unknown), not an empty declaration", async () => {
    ARTIFACT_BINDINGS = null;
    HAS_ARTIFACT_BINDINGS = false;
    await importZip();
    expect(createInput().artifactBindings).toBeNull();
  });

  it("UPSERT (re-import): the declaration is re-projected onto the existing row", async () => {
    readTemplate.mockResolvedValue({ id: "tmpl-existing" });
    await importZip();
    const parsed = parseArtifactBindingDeclaration(upsertPatch().artifactBindings as string);
    expect(parsed).toEqual(FAN_OUT_DECLARATION);
  });

  it("UPSERT: the declaration and packageVersion ride the SAME patch (atomic — the version pin is worthless otherwise)", async () => {
    readTemplate.mockResolvedValue({ id: "tmpl-existing" });
    await importZip();
    expect(updateTemplate).toHaveBeenCalledTimes(1);
    const patch = upsertPatch();
    expect(patch.packageVersion).toBe("0.1.0");
    expect(patch.artifactBindings).toEqual(expect.any(String));
  });

  // -------------------------------------------------------------------------
  // Codex convergence round, finding 1. `packageVersion` on the adopt patch is
  // `effectivePackageVersion ?? undefined` — a re-import carrying NO version
  // (package.json absent, or present without a `version`) deliberately LEAVES
  // the existing package_version in place. Writing this compile's declaration
  // beside an unchanged version would pair a NEW declaration with an OLD pin,
  // and the materializer's version-pin guard — which compares only the version —
  // would then hand a run pinned to that old version a declaration it never
  // executed: the two-authority defect #3208 removes, reintroduced in
  // miniature. With no version to confirm against the declaration is OMITTED
  // and the column keeps whatever the last version-paired write set, the same
  // rule the MCP recompile writer already follows.
  // -------------------------------------------------------------------------
  it("UPSERT: a VERSIONLESS re-import leaves the declaration untouched — never a new declaration beside an old pin", async () => {
    readTemplate.mockResolvedValue({ id: "tmpl-existing" });
    COMPILED_PACKAGE_VERSION = null;
    await importAgentTemplateCore(zip({ version: null }), undefined, {
      redirect: false,
      status: "published",
    });
    const patch = upsertPatch();
    expect(patch.packageVersion).toBeUndefined();
    expect(patch.artifactBindings).toBeUndefined();
  });

  it("UPSERT: the declaration is written ONLY when a version rides the SAME patch", async () => {
    readTemplate.mockResolvedValue({ id: "tmpl-existing" });
    COMPILED_PACKAGE_VERSION = null;
    await importAgentTemplateCore(zip({ version: null }), undefined, {
      redirect: false,
      status: "published",
    });
    const patch = upsertPatch();
    expect(patch.artifactBindings !== undefined).toBe(patch.packageVersion !== undefined);
  });
});
