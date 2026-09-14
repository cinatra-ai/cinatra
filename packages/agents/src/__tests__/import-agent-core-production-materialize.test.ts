import { identityClaimMockFrom } from "./helpers/identity-claim-mock";
/**
 * cinatra#3493 — the SUPPLIED-INSTALL road (a package uploaded through the
 * import screen's File tab, and `agent_import`) must MATERIALIZE the uploaded
 * package under the agent RUNTIME MOUNT and RELOAD the runtime, and must
 * report an honest FAILURE when either step leaves the agent unmounted.
 *
 * The measured defect: `importAgentTemplateCore` staged the archive in a temp
 * dir, compiled the OAS document out of it, `rm`-ed that temp dir BEFORE any
 * durable write, and then wrote the template row and reported success — it
 * never called `materializeAgentPackageToDisk` and never called
 * `triggerWayflowReload`. On a production instance nothing was therefore ever
 * written under `<extension-data-root>/.agent-mount/`, the runtime mounted
 * nothing (a reload answered 0 agents, the agent card answered 404), the
 * person's run could not start — and the screen still said "installed and
 * published".
 *
 * The harness mirrors `import-agent-core-lifecycle-config.test.ts`: the REAL
 * `importAgentTemplateCore` with its DB collaborators mocked. Two things are
 * deliberately REAL here, because they are what the criteria are about:
 *
 *   - `materialize-agent-package.ts` and `agent-runtime-mount.ts` — the mount
 *     tree is written and read on a real (temporary) production-style
 *     extension data root, not asserted through a spy;
 *   - the environment — `NODE_ENV=production`, a temporary
 *     `CINATRA_EXTENSION_DATA_ROOT` holding an `.agent-mount` tree, every
 *     `CINATRA_DEPLOYMENT_REGISTRY_*` key unset and no fixture opt-in, with
 *     `resolvePublishDestination` stubbed to fail closed exactly as the
 *     production loader does under that environment.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/import-agent-core-production-materialize.test.ts
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PKG = "@cinatra-ai/blog-drafter-agent";
const MOUNT_LABEL = "cinatra-ai/blog-drafter-agent";

/** Mutable compile identity — `vi.hoisted` so the hoisted `vi.mock` factory
 *  below can read it without a temporal-dead-zone crash. */
const COMPILED = vi.hoisted(() => ({
  packageName: "@cinatra-ai/blog-drafter-agent",
  packageVersion: "0.3.1",
}));

vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect() must not be reached with { redirect: false }");
  },
}));

// The production WALL this issue named as a candidate cause: on a production
// build with no `CINATRA_DEPLOYMENT_REGISTRY_*` env and no fixture opt-in,
// `loadDeploymentRegistryConfig` throws `DeploymentRegistryConfigNotConfigured`
// and every consumer of it — `resolvePublishDestination` included — fails
// closed. A LOCAL upload writes its own runtime files and must not depend on a
// registry identity to do it, so this throw must not reach the materialize.
vi.mock("@cinatra-ai/extensions/destination-resolver", () => ({
  resolvePublishDestination: async () => {
    throw new Error(
      "DeploymentRegistryConfigNotConfiguredError: the deployment registry is not configured",
    );
  },
}));

vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: () => null,
}));

// `resolveExtensionDataRoot` reads `CINATRA_EXTENSION_DATA_ROOT` FIRST and only
// falls back to a DB metadata key, so the fallback is never reached here. The
// stub exists purely to keep the real Postgres client out of the module graph.
vi.mock("@/lib/database", () => ({
  readMetadataValueFromDatabase: () => null,
  writeMetadataValueToDatabase: () => undefined,
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
      packageName: COMPILED.packageName,
      packageVersion: COMPILED.packageVersion,
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
      hasArtifactBindings: false,
      artifactBindings: null,
    },
  }),
}));

const reload = vi.fn();
vi.mock("../wayflow-reload-client", () => ({
  triggerWayflowReload: (...a: unknown[]) => reload(...a),
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
import { PUBLISHED_MARKER_FILENAME } from "../materialize-agent-package";

const OAS = JSON.stringify({
  agentspec_version: "26.1.0",
  component_type: "Flow",
  name: "Blog Drafter",
  description: "drafts a blog post",
  metadata: { cinatra: { packageName: PKG } },
});

function zip(): string {
  return createZipBuffer([
    { name: "agent.json", content: OAS },
    { name: "manifest.json", content: JSON.stringify({ version: 1 }) },
    {
      name: "package.json",
      content: JSON.stringify({ name: PKG, version: "0.3.1", license: "Apache-2.0" }),
    },
  ]).toString("base64");
}

/** The supplied-install road: what the import screen's server action calls. */
const suppliedInstall = () =>
  importAgentTemplateCore(zip(), undefined, {
    redirect: false,
    destination: "private",
    requireRuntimeMount: true,
  });

/** The startup seeding road: what `ensureAgentPackage*` calls. */
const startupSeed = () => importAgentTemplateCore(zip(), undefined, { redirect: false });

const mountedReport = {
  ok: true,
  report: {
    added: [MOUNT_LABEL],
    changed: [],
    removed: [],
    failed: [],
    agents: 1,
    last_reload_at: "2026-09-14T22:00:00.000Z",
  },
};

let dataRoot: string;
let agentDir: string;
const savedEnv = new Map<string, string | undefined>();

function stubEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(async () => {
  vi.clearAllMocks();
  COMPILED.packageName = PKG;
  COMPILED.packageVersion = "0.3.1";
  readTemplate.mockReset();
  readTemplate.mockResolvedValue(null);
  reload.mockReset();
  reload.mockResolvedValue(mountedReport);

  // A production-style extension data root: a real directory holding the
  // `.agent-mount` tree the runtime reads.
  dataRoot = await mkdtemp(join(tmpdir(), "cinatra-3493-"));
  agentDir = join(dataRoot, ".agent-mount", "cinatra-ai", "blog-drafter-agent");
  await mkdir(join(dataRoot, ".agent-mount"), { recursive: true });

  stubEnv("NODE_ENV", "production");
  stubEnv("CINATRA_EXTENSION_DATA_ROOT", dataRoot);
  stubEnv("CINATRA_DEPLOYMENT_REGISTRY_ALLOW_FIXTURE", undefined);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CINATRA_DEPLOYMENT_REGISTRY_")) stubEnv(key, undefined);
  }
});

afterEach(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  vi.restoreAllMocks();
  await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe("cinatra#3493 — the supplied-install road materializes and mounts what it reports installed", () => {
  it("materializes the uploaded package's sources and its publish marker under the agent-mount tree, then reloads the runtime", async () => {
    const result = await suppliedInstall();

    expect((await stat(agentDir)).isDirectory()).toBe(true);
    // `cinatra/oas.json` is THE name the runtime mount is keyed by
    // (installed-oas-path.ts resolves `<root>/<vendor>/<slug>/cinatra/oas.json`
    // and nothing else), and it carries the uploaded document verbatim.
    expect(await readFile(join(agentDir, "cinatra", "oas.json"), "utf8")).toBe(OAS);
    // The uploaded sibling manifest rides along.
    expect(JSON.parse(await readFile(join(agentDir, "package.json"), "utf8")).name).toBe(PKG);
    // The publish marker the WayFlow loader gates mounting on.
    const marker = JSON.parse(await readFile(join(agentDir, PUBLISHED_MARKER_FILENAME), "utf8"));
    expect(marker).toMatchObject({ packageName: PKG, packageVersion: "0.3.1" });
    expect(typeof marker.oasSha256).toBe("string");

    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.upserted).toBe(false);
    expect(typeof result.templateId).toBe("string");
  });

  it("materializes on a production build with NO deployment-registry env and no fixture opt-in — the publish-destination loader's fail-closed throw is not on this road's critical path", async () => {
    expect(process.env.NODE_ENV).toBe("production");
    expect(Object.keys(process.env).filter((k) => k.startsWith("CINATRA_DEPLOYMENT_REGISTRY_"))).toEqual([]);

    // `destination: "private"` means `resolvePublishDestination` IS reached —
    // and it throws, exactly as the production loader does here.
    await expect(suppliedInstall()).resolves.toMatchObject({ upserted: false });

    expect((await stat(join(agentDir, "cinatra", "oas.json"))).isFile()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reports FAILURE when the reload answers 0 mounted agents — no row is left claiming installed and published", async () => {
    reload.mockResolvedValue({
      ok: true,
      report: { added: [], changed: [], removed: [], failed: [], agents: 0, last_reload_at: null },
    });

    await expect(suppliedInstall()).rejects.toThrow(/did not mount it/i);

    // The row the screen would have flipped live is still a DRAFT, and the
    // caller's go-live + installed-extensions registration never run: the
    // failure is raised before this function returns.
    expect(createTemplate).toHaveBeenCalledTimes(1);
    expect((createTemplate.mock.calls[0][0] as { status?: string }).status).toBe("draft");
  });

  it("reports FAILURE when the runtime refuses this very package", async () => {
    reload.mockResolvedValue({
      ok: true,
      report: {
        added: [],
        changed: [],
        removed: [],
        failed: [{ label: MOUNT_LABEL, kind: "added", error: "ValueError: bad flow" }],
        agents: 4,
        last_reload_at: null,
      },
    });

    await expect(suppliedInstall()).rejects.toThrow(/ValueError: bad flow/);
  });

  it("reports FAILURE when the runtime could not be reloaded at all", async () => {
    reload.mockResolvedValue({ ok: false, reason: "no_base_url" });

    await expect(suppliedInstall()).rejects.toThrow(/no_base_url/);
  });

  it("writes NO template row at all when the package cannot be materialized under the mount", async () => {
    // An unscoped name has no `<vendor>/<slug>` mount path, so the materializer
    // refuses it — and the refusal lands BEFORE any durable write.
    COMPILED.packageName = "blog-drafter";

    await expect(suppliedInstall()).rejects.toThrow(/could not be materialized/i);

    expect(createTemplate).not.toHaveBeenCalled();
    expect(updateTemplate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  // --- convergence round 1 (codex findings adopted) ---------------------------

  it("reports FAILURE when a FRESH mount is not among the agents the runtime says it mounted", async () => {
    // The runtime answers with a non-zero total that never names this package:
    // it is serving OTHER agents, and the aggregate count proves nothing about
    // this one. A fresh mount is new to the loader, so it must appear in
    // `added` or the install has no confirmation at all.
    reload.mockResolvedValue({
      ok: true,
      report: {
        added: ["cinatra-ai/some-other-agent"],
        changed: [],
        removed: [],
        failed: [],
        agents: 5,
        last_reload_at: null,
      },
    });

    await expect(suppliedInstall()).rejects.toThrow(/did not report cinatra-ai\/blog-drafter-agent/);
    // and the mount is rolled back — nothing is left behind claiming a mount.
    await expect(stat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the PREVIOUS version on disk when a re-import's reload leaves the agent unmounted", async () => {
    // A version the runtime is already serving.
    await mkdir(join(agentDir, "cinatra"), { recursive: true });
    await writeFile(join(agentDir, "cinatra", "oas.json"), "PREVIOUS-VERSION", "utf8");

    reload.mockResolvedValue({
      ok: true,
      report: { added: [], changed: [], removed: [], failed: [], agents: 0, last_reload_at: null },
    });

    await expect(suppliedInstall()).rejects.toThrow(/did not mount it/i);

    // The mount still holds exactly what the runtime is serving — the failed
    // replacement did not survive, and the prior version was not dropped.
    expect(await readFile(join(agentDir, "cinatra", "oas.json"), "utf8")).toBe("PREVIOUS-VERSION");
  });

  it("materializes the archive's OTHER members too, not just the OAS document and package.json", async () => {
    await expect(
      importAgentTemplateCore(
        createZipBuffer([
          { name: "agent.json", content: OAS },
          { name: "package.json", content: JSON.stringify({ name: PKG, version: "0.3.1", license: "Apache-2.0" }) },
          { name: "README.md", content: "# Blog Drafter" },
          { name: "skills/drafting.md", content: "how to draft" },
          { name: "cinatra/sidecar.json", content: '{"k":1}' },
        ]).toString("base64"),
        undefined,
        { redirect: false, destination: "private", requireRuntimeMount: true },
      ),
    ).resolves.toMatchObject({ upserted: false });

    expect(await readFile(join(agentDir, "README.md"), "utf8")).toBe("# Blog Drafter");
    expect(await readFile(join(agentDir, "skills", "drafting.md"), "utf8")).toBe("how to draft");
    expect(await readFile(join(agentDir, "cinatra", "sidecar.json"), "utf8")).toBe('{"k":1}');
  });

  it("refuses an archive entry whose path escapes the package directory", async () => {
    await expect(
      importAgentTemplateCore(
        createZipBuffer([
          { name: "agent.json", content: OAS },
          { name: "package.json", content: JSON.stringify({ name: PKG, version: "0.3.1", license: "Apache-2.0" }) },
          { name: "../escaped.txt", content: "nope" },
        ]).toString("base64"),
        undefined,
        { redirect: false, destination: "private", requireRuntimeMount: true },
      ),
    ).rejects.toThrow(/escapes the package directory/);
    expect(reload).not.toHaveBeenCalled();
  });

  it("writes NOTHING to the mount when the package name is held by another organization", async () => {
    // `resolveAgentTemplateIdentityClaim` refuses a foreign name by throwing —
    // and that refusal has to land while this import is still INERT, or an
    // upload from another organization would replace an owned package's
    // runtime files before being refused.
    // The discriminator is WHEN the refusal lands, not what is on disk after
    // the rollback: the claim resolution reads the mount at the moment it
    // refuses. Before this ordering fix the foreign package's files were
    // already promoted into the mount by then — visible to a concurrent
    // runtime reload, which no rollback can unmount again.
    let mountExistedAtClaimTime: boolean | null = null;
    readTemplate.mockImplementation(async () => {
      mountExistedAtClaimTime = await stat(agentDir).then(
        () => true,
        () => false,
      );
      throw new Error("AgentTemplateIdentityConflict: held by another org");
    });

    await expect(suppliedInstall()).rejects.toThrow(/held by another org/);

    expect(mountExistedAtClaimTime).toBe(false);
    await expect(stat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(createTemplate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("leaves the startup seeding road untouched — no materialize, no reload", async () => {
    await expect(startupSeed()).resolves.toMatchObject({ upserted: false });

    await expect(stat(join(dataRoot, ".agent-mount", "cinatra-ai"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(reload).not.toHaveBeenCalled();
    expect(createTemplate).toHaveBeenCalledTimes(1);
  });
});
