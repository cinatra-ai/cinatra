/**
 * cinatra#2044 GAP 2, hop 2 of 2 — `importAgentTemplateCore` must compile the
 * import ZIP's `package.json#cinatra.lifecycle` block onto
 * `agent_templates.lifecycle_config`.
 *
 * The wave124 negative proof: `importAgentTemplateCore` never set
 * `lifecycleConfig` at all, so EVERY install that goes through the loader / ZIP
 * path (dev-boot git-file scan, the hot-reload watcher, `cinatra setup`, the
 * `data/downloads` system-agent path, the UI/MCP ZIP import) left the column
 * NULL — even for `@cinatra-ai/wordpress-agent@0.1.6`, whose pinned manifest
 * declares `cinatra.lifecycle.repairCapable: true`. `resolveRepairCapable` reads
 * that NULL as not-repair-capable, so a reviewer's changes-request routed
 * `human_escalation` and the repair round-trip never started.
 *
 * `installAgentFromPackage` (the registry path) already did this correctly —
 * install-from-package.ts:491/596/632, pinned by
 * `install-from-package-lifecycle-config.test.ts`. These cases assert the loader
 * path reaches PARITY with it, including the explicit-clear rule, and pin the
 * one deliberate difference (a manifest-less ZIP leaves the column unchanged
 * rather than clearing it — `package.json` is an explicitly OPTIONAL member of
 * the agent-ZIP shape, unlike a registry tarball's always-present manifest).
 *
 * Harness mirrors `install-from-package-lifecycle-config.test.ts`: the REAL
 * `importAgentTemplateCore` with its collaborators mocked.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/import-agent-core-lifecycle-config.test.ts
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const PKG = "@cinatra-ai/wordpress-agent";

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
      packageVersion: "0.1.6",
      agentDependencies: {},
      type: "leaf",
      compiledPlan: [],
      hitlScreens: [],
      llmConfig: null,
      toolboxes: [],
      agentSpecVersion: "26.1.0",
      triggerMode: "full",
      gatedSteps: [],
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
  updateAgentTemplate: (...a: unknown[]) => updateTemplate(...(a as [])),
  createAgentVersion: vi.fn(async () => {}),
  updateAgentTemplateOrigin: vi.fn(async () => {}),
}));

import { importAgentTemplateCore } from "../import-agent-core";
import { createZipBuffer } from "../zip-helpers";

const OAS = JSON.stringify({
  agentspec_version: "26.1.0",
  component_type: "Flow",
  name: "WordPress Agent",
  metadata: { cinatra: { packageName: PKG } },
});

/** Build the import ZIP the loader hands this function. `lifecycle: undefined`
 * declares no block; omitting `pkg` entirely models a manifest-less ZIP. */
function zip(opts: { pkg?: boolean; lifecycle?: unknown } = {}): string {
  const files = [
    { name: "agent.json", content: OAS },
    { name: "manifest.json", content: JSON.stringify({ version: 1 }) },
  ];
  if (opts.pkg !== false) {
    files.push({
      name: "package.json",
      content: JSON.stringify({
        name: PKG,
        version: "0.1.6",
        license: "Apache-2.0",
        cinatra: {
          type: "flow",
          ...(opts.lifecycle === undefined ? {} : { lifecycle: opts.lifecycle }),
        },
      }),
    });
  }
  return createZipBuffer(files).toString("base64");
}

const importZip = (opts?: { pkg?: boolean; lifecycle?: unknown }) =>
  importAgentTemplateCore(zip(opts), undefined, { redirect: false, status: "published" });

const createInput = () => createTemplate.mock.calls[0]?.[0] as Record<string, unknown>;
const upsertPatch = () => updateTemplate.mock.calls[0]?.[1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  readTemplate.mockReset();
  readTemplate.mockResolvedValue(null);
});

describe("cinatra#2044 GAP 2 — importAgentTemplateCore compiles cinatra.lifecycle onto the template row", () => {
  it("CREATE: a declared block lands on lifecycleConfig as JSON-as-text", async () => {
    await importZip({ lifecycle: { repairCapable: true } });
    expect(createInput().lifecycleConfig).toBe(JSON.stringify({ repairCapable: true }));
  });

  it("CREATE: the full declaration shape is compiled in the canonical key order", async () => {
    await importZip({
      lifecycle: {
        repairCapable: true,
        producedTypes: ["artifact-blog-post-body"],
        requestedSkips: ["recommendation"],
      },
    });
    // Same stable ordering `installAgentFromPackage` writes, so a re-install
    // through either path produces byte-identical column text.
    expect(createInput().lifecycleConfig).toBe(
      JSON.stringify({
        producedTypes: ["artifact-blog-post-body"],
        repairCapable: true,
        requestedSkips: ["recommendation"],
      }),
    );
  });

  it("CREATE: a manifest declaring no block ⇒ null (back-compat with every published package)", async () => {
    await importZip();
    expect(createInput().lifecycleConfig).toBeNull();
  });

  it("UPSERT (re-import): the declaration is re-projected onto the existing row", async () => {
    readTemplate.mockResolvedValue({ id: "tpl-existing" });
    await importZip({ lifecycle: { repairCapable: true } });
    expect(upsertPatch().lifecycleConfig).toBe(JSON.stringify({ repairCapable: true }));
  });

  it("UPSERT: a version that DROPS the block CLEARS the column (no stale repairCapable)", async () => {
    readTemplate.mockResolvedValue({ id: "tpl-existing" });
    await importZip();
    // Passed EXPLICITLY as null, not omitted — omitting would leave the stale
    // value on the row and keep routing repairs to a producer that no longer
    // declares the capability. Same rule as install-from-package.ts:491.
    expect(upsertPatch()).toHaveProperty("lifecycleConfig", null);
  });

  it("UPSERT: a MANIFEST-LESS ZIP leaves the column UNCHANGED (omitted, never cleared)", async () => {
    readTemplate.mockResolvedValue({ id: "tpl-existing" });
    await importZip({ pkg: false });
    // package.json is an OPTIONAL member of the agent-ZIP shape. With no
    // manifest there is no declaration to project, so the patch omits the field
    // and updateAgentTemplate's `!== undefined` guard leaves the column alone —
    // a manifest-less archive must never silently wipe a real declaration.
    expect(upsertPatch().lifecycleConfig).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(upsertPatch(), "lifecycleConfig")).toBe(true);
  });

  it("a MALFORMED block does not crash the import (fail-soft ⇒ no declaration)", async () => {
    await importZip({ lifecycle: { repairCapable: "yes", producedTypes: "not-an-array" } });
    expect(createInput().lifecycleConfig).toBeNull();
  });

  it("an ARRAY lifecycle compiles to null (normalizeLifecycle rejects arrays)", async () => {
    await importZip({ lifecycle: [{ repairCapable: true }] });
    expect(createInput().lifecycleConfig).toBeNull();
  });

  it("UPSERT: a NON-AUTHORITATIVE synthesis declaring no block leaves the column UNCHANGED", async () => {
    // codex round 1. The git-file loader ALWAYS synthesizes the ZIP's
    // package.json, so with no sibling manifest on disk that synthesis carries no
    // cinatra.lifecycle for a reason that has nothing to do with the author's
    // intent. Projecting it as an explicit clear would wipe a correct
    // lifecycle_config off an installed row (e.g. one the registry path wrote) on
    // the very next boot scan. The opt-out degrades the absence to "unchanged".
    readTemplate.mockResolvedValue({ id: "tpl-existing" });
    await importAgentTemplateCore(zip(), undefined, {
      redirect: false,
      status: "published",
      lifecycleDeclarationAuthoritative: false,
    });
    expect(upsertPatch().lifecycleConfig).toBeUndefined();
  });

  it("UPSERT: a NON-AUTHORITATIVE synthesis that DOES carry a block still lands it", async () => {
    // The opt-out only suppresses the CLEAR. When the loader did read a sibling
    // manifest and copied its block into the synthesis, that block is the
    // author's and must still reach the column — otherwise the opt-out would
    // silently re-open the very NULL this issue fixes.
    readTemplate.mockResolvedValue({ id: "tpl-existing" });
    await importAgentTemplateCore(zip({ lifecycle: { repairCapable: true } }), undefined, {
      redirect: false,
      status: "published",
      lifecycleDeclarationAuthoritative: false,
    });
    expect(upsertPatch().lifecycleConfig).toBe(JSON.stringify({ repairCapable: true }));
  });

  it("the flag DEFAULTS to authoritative — an unset option still CLEARS on a dropped block", async () => {
    // Every pre-existing caller (UI/MCP ZIP import, cinatra setup, the
    // data/downloads system-agent path) passes a REAL author manifest and must
    // keep the explicit-clear semantics unchanged by this option's introduction.
    readTemplate.mockResolvedValue({ id: "tpl-existing" });
    await importZip();
    expect(upsertPatch()).toHaveProperty("lifecycleConfig", null);
  });

  it("UPSERT: an UNPARSEABLE package.json leaves the column UNCHANGED (never a destructive clear)", async () => {
    // Corrupted bytes are not an authoritative declaration of absence. The
    // identity fields fall through the same catch, so the column follows them:
    // the patch omits the field rather than wiping a real declaration off the
    // row on the strength of a truncated archive.
    readTemplate.mockResolvedValue({ id: "tpl-existing" });
    const files = [
      { name: "agent.json", content: OAS },
      { name: "manifest.json", content: JSON.stringify({ version: 1 }) },
      { name: "package.json", content: "{ not json" },
    ];
    await importAgentTemplateCore(createZipBuffer(files).toString("base64"), undefined, {
      redirect: false,
      status: "published",
    });
    expect(upsertPatch().lifecycleConfig).toBeUndefined();
  });
});
