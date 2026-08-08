/**
 * cinatra#2536 — "already up to date" must require a LIVE canonical install
 * record.
 *
 * THE REPRO (the instance in the issue): the blog pipeline's packages were
 * present in the workspace at their current versions and LOADED at boot —
 *
 *   [cinatra:extensions:agent] @cinatra-ai/blog-draft-writer-agent (version 0.1.2)
 *       skipped — already up to date (bump packageVersion to force re-import)
 *
 * — while `SELECT count(*) FROM cinatra.installed_extension WHERE package_name
 * IN ('@cinatra-ai/blog-post-artifact','@cinatra-ai/blog-draft-writer-agent')`
 * returned 0 and `artifact_type_claims` was EMPTY. The version signal lives on
 * `agent_templates`, so it survived a reset/reinstall that the install rows did
 * not, and the loader kept declaring the package healthy on every boot. The
 * agent stayed selectable and runnable and every run failed materialization
 * with a manifest-blaming error.
 *
 * The first case below is the RED one: before the fix `skipped` was `true` and
 * `importAgentTemplateCore` was never called, with NO install-record read at
 * all. The remaining cases pin the guard rails that keep the repair honest and
 * convergent: an archived record is NEVER resurrected, an unreadable canonical
 * store fails closed, and neither state re-imports on every boot.
 *
 * Run: cd packages/agents && pnpm exec vitest run \
 *   src/__tests__/ensure-agent-package-install-record-gate.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const OAS_PATH = "/extensions/cinatra-ai/blog-draft-writer-agent/cinatra/oas.json";
/** The dir the repair must be handed — the agent's own manifest dir. */
const PACKAGE_DIR = "/extensions/cinatra-ai/blog-draft-writer-agent";

const OAS_CONTENT = JSON.stringify({
  agentspec_version: "26.1.0",
  component_type: "Flow",
  name: "Blog Draft Writer",
  metadata: { cinatra: { packageName: "@cinatra-ai/blog-draft-writer-agent" } },
});

/** The real blog-pipeline producer shape: it `produces` the artifact but does
 *  not declare it as a dependency (that catalog-side defect is cinatra#2537 —
 *  this instance-level repair must stand alone regardless of it). */
const PKG_CONTENT = JSON.stringify({
  name: "@cinatra-ai/blog-draft-writer-agent",
  version: "0.1.2",
  license: "Apache-2.0",
  cinatra: {
    type: "flow",
    dependencies: [{ packageName: "@cinatra-ai/context-selection-agent", kind: "agent" }],
    produces: [{ extension: "@cinatra-ai/blog-post-artifact" }],
  },
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (p: string) => {
    if (p === OAS_PATH) return OAS_CONTENT;
    if (p.endsWith("/package.json")) return PKG_CONTENT;
    const err = new Error("ENOENT") as Error & { code: string };
    err.code = "ENOENT";
    throw err;
  }),
}));

const { readAgentTemplateByPackageNameMock, setAgentTemplatePackageNameMock } = vi.hoisted(() => ({
  readAgentTemplateByPackageNameMock: vi.fn(),
  setAgentTemplatePackageNameMock: vi.fn(async () => {}),
}));
vi.mock("../store", () => ({
  readAgentTemplateByPackageName: readAgentTemplateByPackageNameMock,
  setAgentTemplatePackageName: setAgentTemplatePackageNameMock,
}));

const { importAgentTemplateCoreMock } = vi.hoisted(() => ({
  importAgentTemplateCoreMock: vi.fn(async (..._args: unknown[]) => ({
    templateId: "tpl-blog-draft-writer",
    upserted: true,
  })),
}));
vi.mock("../import-agent-core", () => ({
  importAgentTemplateCore: importAgentTemplateCoreMock,
}));

vi.mock("../reserved-workspace-slugs", () => ({
  isReservedWorkspaceSlug: () => false,
}));

/** The REAL module the loader's default seam dynamic-imports. Stubbed at the
 *  module boundary (not at the call site) so the loader's own resolution +
 *  export name + argument shape are exercised — see the DEFAULT-wiring case. */
const { healMissingInstallRecordMock } = vi.hoisted(() => ({
  healMissingInstallRecordMock: vi.fn(async () => ({
    outcome: "repaired",
    rowId: "iext_default01",
  })),
}));
vi.mock("@/lib/extension-install-record-heal", () => ({
  healMissingInstallRecord: healMissingInstallRecordMock,
}));

import { ensureAgentPackage, ensureAgentPackageFromGitFile } from "../ensure-agent-package";

/** The DB row the loader compares against — current version, no drift. */
const CURRENT_TEMPLATE = {
  id: "tpl-blog-draft-writer",
  packageVersion: "0.1.2",
  lifecycleConfig: null,
};

type HealCall = { packageName: string; kind: string; packageDir?: string; version?: string };

function healerReturning(outcome: string, extra: Record<string, unknown> = {}) {
  const calls: HealCall[] = [];
  const fn = vi.fn(async (input: HealCall) => {
    calls.push(input);
    return { outcome, ...extra };
  });
  return { fn, calls };
}

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  importAgentTemplateCoreMock.mockClear();
  setAgentTemplatePackageNameMock.mockClear();
  readAgentTemplateByPackageNameMock.mockReset();
  readAgentTemplateByPackageNameMock.mockResolvedValue(CURRENT_TEMPLATE);
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
  warnSpy.mockRestore();
});

const logged = (spy: ReturnType<typeof vi.spyOn>): string =>
  spy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");

describe("cinatra#2536 — a version match alone is not 'already up to date'", () => {
  it("RED REPRO: an ABSENT install record at a matching version re-imports and repairs (never 'skipped')", async () => {
    const heal = healerReturning("repaired", { rowId: "iext_healed01" });

    const result = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      healInstallRecord: heal.fn,
    });

    // The whole defect in one assertion: the loader used to return skipped:true
    // here and the package stayed un-installed forever.
    expect(result.skipped).toBe(false);
    expect(importAgentTemplateCoreMock).toHaveBeenCalledTimes(1);
    // The repair is handed the agent's OWN package dir — the manifest there is
    // what proves the package's identity before any row is minted.
    expect(heal.calls).toEqual([
      {
        packageName: "@cinatra-ai/blog-draft-writer-agent",
        kind: "agent",
        packageDir: PACKAGE_DIR,
        version: "0.1.2",
      },
    ]);
    expect(logged(infoSpy)).toContain("installed_extension record was ABSENT");
    expect(logged(infoSpy)).not.toContain("skipped — already up to date");
  });

  it("a LIVE install record keeps the fast skip (no re-import, no repair write)", async () => {
    const heal = healerReturning("already-live", { rowId: "iext_live0001" });

    const result = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      healInstallRecord: heal.fn,
    });

    expect(result.skipped).toBe(true);
    expect(result.templateId).toBe("tpl-blog-draft-writer");
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
    expect(logged(infoSpy)).toContain("skipped — already up to date");
    expect(logged(warnSpy)).toBe("");
  });

  it("CONVERGENCE: the boot after a repair sees a live record and skips again (no re-import loop)", async () => {
    const first = healerReturning("repaired", { rowId: "iext_healed01" });
    const firstRun = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      healInstallRecord: first.fn,
    });
    expect(firstRun.skipped).toBe(false);

    importAgentTemplateCoreMock.mockClear();
    // The repair wrote the row, so the NEXT boot's probe finds it live.
    const second = healerReturning("already-live", { rowId: "iext_healed01" });
    const secondRun = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      healInstallRecord: second.fn,
    });

    expect(secondRun.skipped).toBe(true);
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
  });

  it("an ARCHIVED install record is NEVER resurrected — it skips, loudly", async () => {
    const heal = healerReturning("refused-archived", {
      reason: "installed_extension row is 'archived' — a deliberate archive/uninstall is never resurrected",
    });

    const result = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      healInstallRecord: heal.fn,
    });

    // Skipping is CORRECT here (an operator uninstalled it) — re-importing every
    // boot would be a loop that changes nothing.
    expect(result.skipped).toBe(true);
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
    const warned = logged(warnSpy);
    expect(warned).toContain("loads but is NOT install-active");
    expect(warned).toContain("never resurrected");
    // …and the misleading healthy line is NOT emitted alongside the warning.
    expect(logged(infoSpy)).not.toContain("already up to date");
  });

  it("an UNREADABLE canonical store fails closed — skip + a truthful warning, never a false 'up to date'", async () => {
    const heal = healerReturning("refused-unreadable", { reason: "connection refused" });

    const result = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      healInstallRecord: heal.fn,
    });

    expect(result.skipped).toBe(true);
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
    expect(logged(warnSpy)).toContain("loads but is NOT install-active");
    expect(logged(infoSpy)).not.toContain("already up to date");
  });

  it("an ORG-SCOPED-ONLY install is surfaced, never broadened and never called 'up to date'", async () => {
    const heal = healerReturning("refused-org-scoped", {
      reason: "installed_extension rows exist and are live only for organization(s) [org_b]",
    });

    const result = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      healInstallRecord: heal.fn,
    });

    expect(result.skipped).toBe(true);
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
    expect(logged(warnSpy)).toContain("live only for organization(s) [org_b]");
    expect(logged(infoSpy)).not.toContain("already up to date");
  });

  it("a THROWING repair never breaks the boot importer", async () => {
    const heal = vi.fn(async () => {
      throw new Error("boom");
    });

    const result = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      healInstallRecord: heal,
    });

    expect(result.skipped).toBe(true);
    expect(logged(warnSpy)).toContain("boom");
    expect(logged(infoSpy)).not.toContain("already up to date");
  });

  it("a genuine version bump still re-imports without consulting the install record", async () => {
    readAgentTemplateByPackageNameMock.mockResolvedValue({
      ...CURRENT_TEMPLATE,
      packageVersion: "0.1.1",
    });
    const heal = healerReturning("already-live");

    const result = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      healInstallRecord: heal.fn,
    });

    expect(result.skipped).toBe(false);
    expect(heal.fn).not.toHaveBeenCalled();
  });
});

describe("cinatra#2536 — the DEFAULT wiring (no injected seam) reaches the repair module", () => {
  it("ensureAgentPackageFromGitFile resolves @/lib/extension-install-record-heal and calls it with the agent's identity", async () => {
    // Without this the injected-seam cases above would leave the actual
    // `defaultHealInstallRecord` hop unexecuted (codex round 1/2): the importer
    // could resolve nothing at all and every case would still pass. Here the
    // seam is NOT injected — the loader performs its real dynamic import of the
    // heal module and calls its real export name/signature; the module's
    // DB-backed behaviour behind that call is proven separately by
    // src/lib/__tests__/integration/blog-pipeline-install-record-heal.integration.test.ts.
    healMissingInstallRecordMock.mockClear();

    const result = await ensureAgentPackageFromGitFile({ oasSourcePath: OAS_PATH });

    expect(healMissingInstallRecordMock).toHaveBeenCalledTimes(1);
    expect(healMissingInstallRecordMock).toHaveBeenCalledWith({
      packageName: "@cinatra-ai/blog-draft-writer-agent",
      kind: "agent",
      packageDir: PACKAGE_DIR,
      version: "0.1.2",
    });
    // The stubbed module reports `repaired`, so the loader re-imports.
    expect(result.skipped).toBe(false);
  });
});

describe("cinatra#2536 — the system-ZIP loader surfaces the same state", () => {
  it("ensureAgentPackage cannot prove an on-disk identity, so it SURFACES an absent record instead of repairing it", async () => {
    const heal = healerReturning("refused-unverified", {
      reason: "no on-disk package dir was supplied",
    });

    const result = await ensureAgentPackage({
      zipFileName: "blog-draft-writer-agent.zip",
      packageName: "@cinatra-ai/blog-draft-writer-agent",
      packageVersion: "0.1.2",
      healInstallRecord: heal.fn,
    });

    expect(result.skipped).toBe(true);
    expect(heal.calls[0]?.packageDir).toBeUndefined();
    expect(logged(warnSpy)).toContain("loads but is NOT install-active");
    expect(logged(infoSpy)).not.toContain("already up to date");
  });

  it("a LIVE record still logs the healthy line on the ZIP path", async () => {
    const heal = healerReturning("already-live", { rowId: "iext_live0001" });

    const result = await ensureAgentPackage({
      zipFileName: "blog-draft-writer-agent.zip",
      packageName: "@cinatra-ai/blog-draft-writer-agent",
      packageVersion: "0.1.2",
      healInstallRecord: heal.fn,
    });

    expect(result.skipped).toBe(true);
    expect(logged(infoSpy)).toContain("already up to date");
    expect(logged(warnSpy)).toBe("");
  });
});
