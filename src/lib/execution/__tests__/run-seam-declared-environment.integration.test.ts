/**
 * REAL-STORE regression for the `/api/llm-bridge` run-seam fail-open
 * (epic #1705; exec-plane S3 A2/A3, cinatra#1708 §1.1).
 *
 * The seam supplied `resolveRunExecutionBinding` with ONLY the live template
 * row, so two of the three declared-environment sources the epic names could
 * never reach it:
 *   - a PACKAGED agent's `cinatra.execution.environment` manifest claim, and
 *   - a PINNED run's immutable version-snapshot recipe.
 * Both resolved ABSENT, so the run silently executed on L0 — the inverse of
 * "a declared environment resolves or the run refuses" — and version pinning
 * was bypassed on this seam.
 *
 * Real stores, no fakes for the sources under test:
 *   - the packaged declaration is read from a REAL materialized extension
 *     store on disk (`<root>/agent/<slug>/<digest>/package.json`), discovered
 *     by the REAL `discoverStoreRecordsV2`;
 *   - the pinned snapshot is read from a REAL Postgres through the REAL
 *     `@cinatra-ai/agents` version store.
 * Only the execution-plane service itself is a DI double — it is the seam's
 * registered slot, and the builder/broker are out of this lane's scope.
 *
 * Skipped without a real SUPABASE_DB_URL (the repo's `*.integration.test.ts`
 * tier contract), so it can never pass vacuously.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SandboxEnvironmentMount, SandboxExecutor } from "@cinatra-ai/llm";
import { resolveRunEnvironmentSources } from "@/lib/execution/resolve-run-environment-sources";
import { resolveRunExecutionBinding } from "@/lib/execution/resolve-run-execution-binding";
import {
  registerExecutionEnvironmentService,
  type ExecutionEnvironmentServiceSlot,
  type ExecutionServiceState,
  type ResolveRunExecutionMountInput,
} from "@/lib/execution/register-execution-environment-service";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused");

const fakeExecutor: SandboxExecutor = async () => [];
const fakeMount: SandboxEnvironmentMount = { imageRef: "cinatra-sandbox-l1:test", provenance: {} };

/** Every spec the seam handed the (doubled) builder, in call order. */
const mountCalls: ResolveRunExecutionMountInput[] = [];

function register(state: ExecutionServiceState, over: Partial<ExecutionEnvironmentServiceSlot> = {}) {
  registerExecutionEnvironmentService({ state, ...over });
}
/** `null` = the builder reports NO layer for a declared spec (the "absent" arm). */
function registerReady(mount: SandboxEnvironmentMount | null = fakeMount) {
  register("ready", {
    resolveRunExecutionMount: async (input) => {
      mountCalls.push(input);
      return mount ?? undefined;
    },
    getRunExecutionExecutor: () => fakeExecutor,
  });
}

// A real 64-hex store digest segment (`isStoreDigestSegment`).
const DIGEST = "a".repeat(64);
const PACKAGE_NAME = "@lane1705/env-agent";
const BARE_PACKAGE_NAME = "@lane1705/plain-agent";

let storeRoot: string;
let priorDataRoot: string | undefined;

async function writeStorePackage(packageName: string, cinatraExtra: Record<string, unknown>) {
  const [scope, name] = packageName.replace(/^@/, "").split("/");
  const dir = path.join(storeRoot, "agent", `@${scope}`, name, DIGEST);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: packageName,
      version: "1.0.0",
      cinatra: { kind: "agent", ...cinatraExtra },
    }),
    "utf8",
  );
}

beforeAll(async () => {
  storeRoot = await mkdtemp(path.join(tmpdir(), "cinatra-lane1705-store-"));
  priorDataRoot = process.env.CINATRA_EXTENSION_DATA_ROOT;
  process.env.CINATRA_EXTENSION_DATA_ROOT = storeRoot;
  // A packaged agent that DECLARES an environment…
  await writeStorePackage(PACKAGE_NAME, {
    execution: { environment: { pip: ["pandas==2.2.1"], os: ["pandoc"] } },
  });
  // …and one that declares none (the L0 control).
  await writeStorePackage(BARE_PACKAGE_NAME, {});
});

afterAll(async () => {
  if (priorDataRoot === undefined) delete process.env.CINATRA_EXTENSION_DATA_ROOT;
  else process.env.CINATRA_EXTENSION_DATA_ROOT = priorDataRoot;
  if (storeRoot) await rm(storeRoot, { recursive: true, force: true });
});

afterEach(() => {
  mountCalls.length = 0;
  registerExecutionEnvironmentService({ state: "unavailable" });
});

describe.skipIf(!hasDb)("run seam — packaged-manifest declaration (REAL extension store)", () => {
  it("declared + resolvable → BOUND to the manifest's recipe (was: silent L0)", async () => {
    registerReady();
    const sources = await resolveRunEnvironmentSources({
      templateId: "tpl-unpinned",
      versionId: null,
      packageVersion: null,
      packageName: PACKAGE_NAME,
      // The live template row declares nothing — exactly the state the bridge
      // was in, where this run fell through to L0.
      liveTemplateEnvironment: undefined,
    });
    const binding = await resolveRunExecutionBinding({
      ...sources,
      liveTemplateEnvironment: undefined,
      orgId: "org-lane1705",
      holder: { packageName: PACKAGE_NAME },
    });
    expect(binding).toEqual({ kind: "mount", executor: fakeExecutor, environment: fakeMount });
    expect(mountCalls).toHaveLength(1);
    expect(mountCalls[0].spec).toEqual({ os: ["pandoc"], pip: ["pandas==2.2.1"] });
  });

  it("declared + ABSENT (the layer cannot be resolved) → REFUSED, never L0", async () => {
    registerReady(null);
    const sources = await resolveRunEnvironmentSources({
      templateId: "tpl-unpinned",
      versionId: null,
      packageVersion: null,
      packageName: PACKAGE_NAME,
      liveTemplateEnvironment: undefined,
    });
    const binding = await resolveRunExecutionBinding({
      ...sources,
      liveTemplateEnvironment: undefined,
      orgId: "org-lane1705",
      holder: { packageName: PACKAGE_NAME },
    });
    expect(binding.kind).toBe("refuse");
    expect(binding.kind === "refuse" && binding.auditReason).toBe("environment_unavailable");
  });

  it("declared + the plane not ready → REFUSED (today's instances)", async () => {
    register("disabled");
    const sources = await resolveRunEnvironmentSources({
      templateId: "tpl-unpinned",
      versionId: null,
      packageVersion: null,
      packageName: PACKAGE_NAME,
      liveTemplateEnvironment: undefined,
    });
    const binding = await resolveRunExecutionBinding({
      ...sources,
      liveTemplateEnvironment: undefined,
      orgId: "org-lane1705",
      holder: { packageName: PACKAGE_NAME },
    });
    expect(binding.kind).toBe("refuse");
    expect(binding.kind === "refuse" && binding.auditReason).toBe("environment_unavailable");
  });

  it("UNDECLARED packaged agent → L0, unchanged", async () => {
    registerReady();
    const sources = await resolveRunEnvironmentSources({
      templateId: "tpl-unpinned",
      versionId: null,
      packageVersion: null,
      packageName: BARE_PACKAGE_NAME,
      liveTemplateEnvironment: undefined,
    });
    expect(sources.declarationUnreadable).toBeNull();
    const binding = await resolveRunExecutionBinding({
      ...sources,
      liveTemplateEnvironment: undefined,
      orgId: "org-lane1705",
      holder: { packageName: BARE_PACKAGE_NAME },
    });
    expect(binding).toEqual({ kind: "l0" });
    expect(mountCalls).toHaveLength(0);
  });
});


describe.skipIf(!hasDb)("run seam — pinned version snapshot (REAL Postgres)", () => {
  /**
   * Seed a real template plus two real immutable `agent_template_versions`
   * snapshots. A REQUIRED pin is `(versionId, packageVersion)` — the exact
   * snapshot id AND its semver — per the merged classifier
   * (`resolvePinnedRunSnapshot`, cinatra#1040 S5/S7).
   */
  async function seedPinnedTemplate(): Promise<{
    templateId: string;
    v1: { id: string; semver: string };
    v2: { id: string; semver: string };
  }> {
    const { createAgentTemplate, createAgentTemplateVersion } = await import(
      "@cinatra-ai/agents/store"
    );
    const templateId = `t_${randomUUID()}`;
    await createAgentTemplate({
      id: templateId,
      name: "lane1705-pin",
      sourceNl: "test",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
    });
    const base = {
      name: "lane1705-pin",
      description: null,
      sourceNl: "test",
      compiledPlan: [],
      inputSchema: {},
      outputSchema: null,
      approvalPolicy: { steps: [] },
      type: "leaf",
      taskSpec: null,
      packageVersion: null,
      lgGraphCode: null,
      lgGraphId: null,
    };
    const v1 = await createAgentTemplateVersion({
      templateId,
      semver: "1.0.0",
      bumpType: "minor",
      changelogLine: null,
      contentHash: `h_${randomUUID()}`,
      snapshot: { ...base, executionEnvironment: { pip: ["pandas==2.0.0"] } },
      createdBy: null,
    });
    const v2 = await createAgentTemplateVersion({
      templateId,
      semver: "2.0.0",
      bumpType: "major",
      changelogLine: null,
      contentHash: `h_${randomUUID()}`,
      snapshot: { ...base, executionEnvironment: { pip: ["numpy"] } },
      createdBy: null,
    });
    return {
      templateId,
      v1: { id: v1.id, semver: v1.semver },
      v2: { id: v2.id, semver: v2.semver },
    };
  }

  it("a REQUIRED-pin run mounts its OWN snapshot's recipe, not the live drift", async () => {
    registerReady();
    const { templateId, v1 } = await seedPinnedTemplate();
    // The live agent has since moved on to `numpy` (v2 is the latest version).
    const sources = await resolveRunEnvironmentSources({
      templateId,
      versionId: v1.id,
      packageVersion: v1.semver,
      packageName: null,
      liveTemplateEnvironment: { pip: ["numpy"] },
    });
    expect(sources.pinnedSnapshot).toEqual({
      executionEnvironment: { pip: ["pandas==2.0.0"] },
    });
    const binding = await resolveRunExecutionBinding({
      ...sources,
      liveTemplateEnvironment: { pip: ["numpy"] },
      orgId: "org-lane1705",
      holder: { templateId },
    });
    expect(binding.kind).toBe("mount");
    expect(mountCalls).toHaveLength(1);
    // Version pinning honored on the seam — the second half of this fix
    // (epic #1705's lifecycle "Versions" clause / AC9).
    expect(mountCalls[0].spec).toEqual({ pip: ["pandas==2.0.0"] });
  });

  it("a run pinned to the LATEST version mounts that version's recipe", async () => {
    registerReady();
    const { templateId, v2 } = await seedPinnedTemplate();
    const sources = await resolveRunEnvironmentSources({
      templateId,
      versionId: v2.id,
      packageVersion: v2.semver,
      packageName: null,
      liveTemplateEnvironment: { pip: ["pandas==2.0.0"] },
    });
    const binding = await resolveRunExecutionBinding({
      ...sources,
      liveTemplateEnvironment: { pip: ["pandas==2.0.0"] },
      orgId: "org-lane1705",
      holder: { templateId },
    });
    expect(binding.kind).toBe("mount");
    expect(mountCalls[0].spec).toEqual({ pip: ["numpy"] });
  });

  it("a BEST-EFFORT semver pin (packageVersion only) resolves through the real store", async () => {
    registerReady();
    const { templateId, v1 } = await seedPinnedTemplate();
    const sources = await resolveRunEnvironmentSources({
      templateId,
      versionId: null,
      packageVersion: v1.semver,
      packageName: null,
      liveTemplateEnvironment: { pip: ["numpy"] },
    });
    const binding = await resolveRunExecutionBinding({
      ...sources,
      liveTemplateEnvironment: { pip: ["numpy"] },
      orgId: "org-lane1705",
      holder: { templateId },
    });
    expect(binding.kind).toBe("mount");
    expect(mountCalls[0].spec).toEqual({ pip: ["pandas==2.0.0"] });
  });

  it("the INERT versionId-only pin every ordinary run carries is NOT a pin", async () => {
    // This is the state EVERY non-A2A run is in (createAgentRunPendingInput,
    // runFromRegistry, the workflow/project dispatch paths). Its versionId points
    // at the legacy `agent_versions` table, so treating it as an
    // `agent_template_versions` pin would make every ordinary run resolve against
    // a row that does not exist.
    registerReady();
    const { templateId } = await seedPinnedTemplate();
    const sources = await resolveRunEnvironmentSources({
      templateId,
      versionId: `agent-versions-row_${randomUUID()}`,
      packageVersion: null,
      packageName: null,
      liveTemplateEnvironment: { pip: ["numpy"] },
    });
    expect(sources.pinnedSnapshot).toBeNull();
    expect(sources.declarationUnreadable).toBeNull();
    const binding = await resolveRunExecutionBinding({
      ...sources,
      liveTemplateEnvironment: { pip: ["numpy"] },
      orgId: "org-lane1705",
      holder: { templateId },
    });
    // The LIVE declaration governs, exactly as the merged classifier says.
    expect(binding.kind).toBe("mount");
    expect(mountCalls[0].spec).toEqual({ pip: ["numpy"] });
  });

  it("a run with no pin and nothing declared stays L0 (byte-identical to today)", async () => {
    registerReady();
    const { templateId } = await seedPinnedTemplate();
    const sources = await resolveRunEnvironmentSources({
      templateId,
      versionId: null,
      packageVersion: null,
      packageName: null,
      liveTemplateEnvironment: undefined,
    });
    const binding = await resolveRunExecutionBinding({
      ...sources,
      liveTemplateEnvironment: undefined,
      orgId: "org-lane1705",
      holder: { templateId },
    });
    expect(binding).toEqual({ kind: "l0" });
    expect(mountCalls).toHaveLength(0);
  });

  it("a REQUIRED pin whose snapshot is PURGED REFUSES rather than swapping the recipe", async () => {
    registerReady();
    const { templateId } = await seedPinnedTemplate();
    const sources = await resolveRunEnvironmentSources({
      templateId,
      versionId: `v_${randomUUID()}`, // never inserted
      packageVersion: "1.0.0",
      packageName: null,
      liveTemplateEnvironment: { pip: ["numpy"] },
    });
    const binding = await resolveRunExecutionBinding({
      ...sources,
      liveTemplateEnvironment: { pip: ["numpy"] },
      orgId: "org-lane1705",
      holder: { templateId },
    });
    expect(binding.kind).toBe("refuse");
    expect(binding.kind === "refuse" && binding.auditReason).toBe(
      "environment_declaration_unreadable",
    );
    expect(mountCalls).toHaveLength(0);
  });

  it("a REQUIRED pin bound to ANOTHER template's snapshot REFUSES", async () => {
    registerReady();
    const a = await seedPinnedTemplate();
    const b = await seedPinnedTemplate();
    const sources = await resolveRunEnvironmentSources({
      templateId: a.templateId,
      versionId: b.v1.id, // a real row — but template B's
      packageVersion: b.v1.semver,
      packageName: null,
      liveTemplateEnvironment: { pip: ["numpy"] },
    });
    const binding = await resolveRunExecutionBinding({
      ...sources,
      liveTemplateEnvironment: { pip: ["numpy"] },
      orgId: "org-lane1705",
      holder: { templateId: a.templateId },
    });
    expect(binding.kind).toBe("refuse");
    expect(binding.kind === "refuse" && binding.auditReason).toBe(
      "environment_declaration_unreadable",
    );
  });

  it("a REQUIRED pin whose snapshot declares NOTHING stays L0 (no live fallback)", async () => {
    registerReady();
    const { createAgentTemplate, createAgentTemplateVersion } = await import(
      "@cinatra-ai/agents/store"
    );
    const templateId = `t_${randomUUID()}`;
    await createAgentTemplate({
      id: templateId,
      name: "lane1705-pin-none",
      sourceNl: "test",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
    });
    const v = await createAgentTemplateVersion({
      templateId,
      semver: "1.0.0",
      bumpType: "minor",
      changelogLine: null,
      contentHash: `h_${randomUUID()}`,
      snapshot: {
        name: "lane1705-pin-none",
        description: null,
        sourceNl: "test",
        compiledPlan: [],
        inputSchema: {},
        outputSchema: null,
        approvalPolicy: { steps: [] },
        type: "leaf",
        taskSpec: null,
        packageVersion: null,
        lgGraphCode: null,
        lgGraphId: null,
      },
      createdBy: null,
    });
    const sources = await resolveRunEnvironmentSources({
      templateId,
      versionId: v.id,
      packageVersion: v.semver,
      packageName: null,
      liveTemplateEnvironment: { pip: ["numpy"] },
    });
    const binding = await resolveRunExecutionBinding({
      ...sources,
      liveTemplateEnvironment: { pip: ["numpy"] },
      orgId: "org-lane1705",
      holder: { templateId },
    });
    expect(binding).toEqual({ kind: "l0" });
    expect(mountCalls).toHaveLength(0);
  });

  it("a packaged manifest OUTRANKS the pinned snapshot (epic D8 review authority)", async () => {
    registerReady();
    const { templateId, v1 } = await seedPinnedTemplate();
    const sources = await resolveRunEnvironmentSources({
      templateId,
      versionId: v1.id,
      packageVersion: v1.semver,
      packageName: PACKAGE_NAME,
      liveTemplateEnvironment: undefined,
    });
    const binding = await resolveRunExecutionBinding({
      ...sources,
      liveTemplateEnvironment: undefined,
      orgId: "org-lane1705",
      holder: { packageName: PACKAGE_NAME },
    });
    expect(binding.kind).toBe("mount");
    expect(mountCalls[0].spec).toEqual({ os: ["pandoc"], pip: ["pandas==2.2.1"] });
  });
});
