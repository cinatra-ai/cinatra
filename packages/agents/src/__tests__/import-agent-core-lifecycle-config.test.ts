import { identityClaimMockFrom } from "./helpers/identity-claim-mock";
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
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// Review 2 note: the real compiler returns a package identity ONLY from a
// readable sibling manifest. The mock reads the staged package.json the same
// way, so a manifest-less or unparseable archive gets no invented name.
vi.mock("../oas-compiler", () => ({
  compileOasAgentJson: async (opts: { oasSourcePath?: string }) => ({
    ok: true,
    value: {
      approvalPolicy: { steps: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: null,
      prompt: null,
      packageName: await stagedManifestName(opts.oasSourcePath),
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

async function stagedManifestName(oasSourcePath?: string): Promise<string | null> {
  if (!oasSourcePath) return null;
  const { readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  for (const candidate of [join(dirname(oasSourcePath), "..", "package.json"), join(dirname(oasSourcePath), "package.json")]) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as { name?: unknown };
      return typeof parsed.name === "string" ? parsed.name : null;
    } catch {
      // try the next candidate, as the real sibling read does
    }
  }
  return null;
}

const readTemplate = vi.fn(async (): Promise<{ id: string } | null> => null);
const createTemplate = vi.fn(async (..._a: unknown[]) => {});
const updateTemplate = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../store", () => ({
  readAgentTemplateByPackageName: (...a: unknown[]) => readTemplate(...(a as [])),
  createAgentTemplate: (...a: unknown[]) => createTemplate(...(a as [])),
  // cinatra#2616: the install/import paths now treat a null result as a
  // REFUSAL, so the stub must return the row it "updated".
  updateAgentTemplate: async (...a: unknown[]) =>
    (await updateTemplate(...(a as []))) ?? { id: (a as [string])[0] },
  createAgentVersion: (...a: unknown[]) => createVersion(...(a as [])),
  updateAgentTemplateOrigin: vi.fn(async () => {}),
}));
// cinatra#4264 A1b review 1 finding 5: the supplied-install road's runtime
// mount, observed so a failure after the row write can be seen to roll the
// files back (and, with them, the lifecycle column).
const createVersion = vi.fn(async (..._a: unknown[]) => {});
const rollbackMaterialize = vi.fn(async (..._a: unknown[]) => {});
vi.mock("../materialize-agent-package", () => ({
  materializeAgentPackageToDisk: async () => ({
    materialized: true,
    targetDir: "/tmp/agents-fixture/pkg",
    wasReinstall: true,
  }),
  commitMaterialize: async () => {},
  rollbackMaterialize: (...a: unknown[]) => rollbackMaterialize(...(a as [])),
}));
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => "/tmp/agents-fixture",
}));
vi.mock("../wayflow-reload-client", () => ({
  triggerWayflowReload: async () => ({ ok: false, reason: "no_base_url" }),
}));
vi.mock("../agent-template-identity", async () => identityClaimMockFrom((n: string) => (readTemplate as (p?: string) => unknown)(n) as never));

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
function zip(opts: { pkg?: boolean; lifecycle?: unknown; oas?: string } = {}): string {
  const files = [
    { name: "agent.json", content: opts.oas ?? OAS },
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

const importZip = (opts?: { pkg?: boolean; lifecycle?: unknown; oas?: string }) =>
  importAgentTemplateCore(zip(opts), undefined, { redirect: false, status: "published" });

const createInput = () => createTemplate.mock.calls[0]?.[0] as Record<string, unknown>;
const upsertPatch = () => updateTemplate.mock.calls[0]?.[1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  createVersion.mockReset();
  createVersion.mockImplementation(async () => {});
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

  it("UPSERT: a NON-AUTHORITATIVE manifest leaves the column UNCHANGED (omitted, never cleared)", async () => {
    // A manifest-less ZIP carries no package identity (the honest compile mock
    // reads none), so it never reaches an existing row; the road that keeps an
    // identified row without a declaration is the loader's synthesis.
    readTemplate.mockResolvedValue({ id: "tpl-existing" });
    await importAgentTemplateCore(zip(), undefined, {
      redirect: false,
      status: "published",
      lifecycleDeclarationAuthoritative: false,
    });
    // package.json is an OPTIONAL member of the agent-ZIP shape. With no
    // manifest there is no declaration to project, so the patch omits the field
    // and updateAgentTemplate's `!== undefined` guard leaves the column alone —
    // a manifest-less archive must never silently wipe a real declaration.
    expect(upsertPatch().lifecycleConfig).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(upsertPatch(), "lifecycleConfig")).toBe(true);
  });

  it("cinatra#4264 A1b: a declared regenerate list is stored on lifecycleConfig (write)", async () => {
    const regenerate = [{ artifactNode: "file_image", step: "image_flow", noteInput: "prompt" }];
    await importZip({ lifecycle: { regenerate } });
    expect(createInput().lifecycleConfig).toBe(
      '{"regenerate":[{"artifactNode":"file_image","step":"image_flow","noteInput":"prompt"}]}',
    );
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

// ---------------------------------------------------------------------------
// cinatra#2616 — the ZIP import is an identity CLAIM, and it must RECORD it.
//
// The authenticated import action supplies `claimantOrgId` (its session's
// active organization) but no `orgId`. Without recording, the row lands
// `org_id NULL` — still UNCLAIMED — and the next organization's import of the
// same package name takes it. Both branches must stamp it.
// ---------------------------------------------------------------------------
describe("cinatra#2616 — the ZIP import records its identity claim", () => {
  it("CREATE: a claimant with no explicit orgId is RECORDED on the fresh row", async () => {
    await importAgentTemplateCore(zip({ lifecycle: undefined }), undefined, {
      redirect: false,
      status: "published",
      claimantOrgId: "org-importer",
    });
    expect(createInput().orgId).toBe("org-importer");
  });

  it("CREATE: an explicit orgId still wins verbatim", async () => {
    await importAgentTemplateCore(zip({ lifecycle: undefined }), undefined, {
      redirect: false,
      status: "published",
      orgId: "org-explicit",
      claimantOrgId: "org-explicit",
    });
    expect(createInput().orgId).toBe("org-explicit");
  });

  it("ADOPT: taking over an org-less row RECORDS the claim on it", async () => {
    readTemplate.mockResolvedValue({ id: "tpl-orgless" } as never);
    await importAgentTemplateCore(zip({ lifecycle: undefined }), undefined, {
      redirect: false,
      status: "published",
      claimantOrgId: "org-importer",
    });
    expect(upsertPatch().orgId).toBe("org-importer");
  });

  it("boot seeding (no claimant at all) leaves the row org-less, exactly as before", async () => {
    await importAgentTemplateCore(zip({ lifecycle: undefined }), undefined, {
      redirect: false,
      status: "published",
    });
    expect(createInput().orgId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cinatra#4264 A1b — the tri-state projection of the import road.
//
// `write` (a manifest with a block) and `clear` (a manifest without one) are
// decided by the manifest, whose list the compile has already checked. `none`
// (no manifest, an unparseable one, or a non-authoritative synthesis) keeps the
// stored column; when that column carries a `regenerate` list, the list is
// checked against the NEW flow first and the whole import refuses before any
// write when the flow no longer honours it.
// ---------------------------------------------------------------------------
describe("cinatra#4264 A1b — the import revalidates a retained regenerate list", () => {
  const gemini = JSON.parse(
    readFileSync(join(__dirname, "fixtures", "synthetic-gemini-agent.json"), "utf8"),
  ) as { metadata: { cinatra: Record<string, unknown> } };
  gemini.metadata.cinatra = { ...gemini.metadata.cinatra, packageName: PKG };
  const GEMINI = JSON.stringify(gemini);
  // The fixture's ApiNode files its own output from the start's `user` input.
  const KEPT = [{ artifactNode: "call_llm_bridge", step: "call_llm_bridge", noteInput: "user" }];
  const STALE = [{ artifactNode: "file_image", step: "image_flow", noteInput: "prompt" }];
  // The none road that keeps an IDENTIFIED row: the loader's synthesized
  // manifest (it names the package) marked non-authoritative for lifecycle.
  const importNonAuthoritative = () =>
    importAgentTemplateCore(zip({ oas: GEMINI }), undefined, {
      redirect: false,
      status: "published",
      lifecycleDeclarationAuthoritative: false,
    });
  const row = (regenerate: unknown) => ({
    id: "tpl-existing",
    lifecycleConfig: JSON.stringify({ repairCapable: true, regenerate }),
  });

  it("manifest-less ZIP: no package identity, so the stored row is never matched or written (a fresh row)", async () => {
    // Review 2 note: the archive carries no name and the compile reads none,
    // so no existing row is kept; the stored list cannot outlive anything.
    readTemplate.mockResolvedValue(row(STALE) as never);
    await importZip({ pkg: false, oas: GEMINI });
    expect(updateTemplate).not.toHaveBeenCalled();
    expect(createTemplate).toHaveBeenCalledTimes(1);
  });

  it("none (non-authoritative synthesis, the ensure/version-bump road): the same stale list REFUSES", async () => {
    readTemplate.mockResolvedValue(row(STALE) as never);
    await expect(
      importAgentTemplateCore(zip({ oas: GEMINI }), undefined, {
        redirect: false,
        status: "published",
        lifecycleDeclarationAuthoritative: false,
      }),
    ).rejects.toThrow(/REGENERATE_DECLARATION_INVALID/);
    expect(updateTemplate).not.toHaveBeenCalled();
  });

  it("unparseable manifest: no package identity either, so the stored row is never written", async () => {
    readTemplate.mockResolvedValue(row(STALE) as never);
    const files = [
      { name: "agent.json", content: GEMINI },
      { name: "manifest.json", content: JSON.stringify({ version: 1 }) },
      { name: "package.json", content: "{ not json" },
    ];
    await importAgentTemplateCore(createZipBuffer(files).toString("base64"), undefined, {
      redirect: false,
      status: "published",
    });
    expect(updateTemplate).not.toHaveBeenCalled();
    expect(createTemplate).toHaveBeenCalledTimes(1);
  });

  it("none: a stored list the new flow still honours is KEPT (the column is left unchanged)", async () => {
    readTemplate.mockResolvedValue(row(KEPT) as never);
    await importNonAuthoritative();
    expect(upsertPatch().lifecycleConfig).toBeUndefined();
  });

  it("none: stored lifecycle text that cannot be read REFUSES the import before any write (review 1 finding 6)", async () => {
    readTemplate.mockResolvedValue({
      id: "tpl-existing",
      lifecycleConfig: '{"regenerate":[{"artifactNode":"file_ima',
    } as never);
    await expect(importNonAuthoritative()).rejects.toThrow(/stored lifecycle declaration cannot be read/);
    expect(updateTemplate).not.toHaveBeenCalled();
    expect(createTemplate).not.toHaveBeenCalled();
  });

  it("clear: a manifest without a block clears the column; the stale stored list is not checked", async () => {
    readTemplate.mockResolvedValue(row(STALE) as never);
    await importZip({ oas: GEMINI });
    expect(upsertPatch()).toHaveProperty("lifecycleConfig", null);
  });
});

// ---------------------------------------------------------------------------
// cinatra#4264 A1b review 1 finding 5 — a failure after the row write rolls the
// runtime files back to the previous flow, so the lifecycle column the same
// import wrote is restored too: a list written for the new flow must not stay
// beside the old flow's files.
// ---------------------------------------------------------------------------
describe("cinatra#4264 A1b — a rolled-back import restores the lifecycle column", () => {
  const PRIOR = JSON.stringify({ regenerate: [{ artifactNode: "file_image", step: "image_flow", noteInput: "prompt" }] });
  const supplied = () =>
    importAgentTemplateCore(zip({ lifecycle: { repairCapable: true } }), undefined, {
      redirect: false,
      status: "published",
      requireRuntimeMount: true,
    });

  beforeEach(() => {
    createVersion.mockReset();
    createVersion.mockRejectedValue(new Error("version insert failed"));
    rollbackMaterialize.mockClear();
  });

  it("UPSERT: version creation fails after the row write -> the files roll back AND the prior column is written back", async () => {
    readTemplate.mockResolvedValue({ id: "tpl-existing", lifecycleConfig: PRIOR } as never);
    await expect(supplied()).rejects.toThrow(/version insert failed/);
    expect(rollbackMaterialize).toHaveBeenCalledTimes(1);
    expect(updateTemplate).toHaveBeenCalledTimes(2);
    expect(updateTemplate.mock.calls[0]?.[1]).toHaveProperty("lifecycleConfig", '{"repairCapable":true}');
    expect(updateTemplate.mock.calls[1]?.[0]).toBe("tpl-existing");
    expect(updateTemplate.mock.calls[1]?.[1]).toEqual({ lifecycleConfig: PRIOR });
  });

  it("CREATE: version creation fails after the fresh row -> the files roll back AND the column is cleared", async () => {
    await expect(supplied()).rejects.toThrow(/version insert failed/);
    expect(rollbackMaterialize).toHaveBeenCalledTimes(1);
    const newId = createInput().id;
    expect(updateTemplate).toHaveBeenCalledTimes(1);
    expect(updateTemplate.mock.calls[0]?.[0]).toBe(newId);
    expect(updateTemplate.mock.calls[0]?.[1]).toEqual({ lifecycleConfig: null });
  });

  it("control: with no runtime mount (nothing rolled back) the column the import wrote is left as written", async () => {
    readTemplate.mockResolvedValue({ id: "tpl-existing", lifecycleConfig: PRIOR } as never);
    await expect(
      importAgentTemplateCore(zip({ lifecycle: { repairCapable: true } }), undefined, {
        redirect: false,
        status: "published",
      }),
    ).rejects.toThrow(/version insert failed/);
    expect(rollbackMaterialize).not.toHaveBeenCalled();
    expect(updateTemplate).toHaveBeenCalledTimes(1);
  });
});
