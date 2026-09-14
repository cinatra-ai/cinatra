/**
 * cinatra#3462 — the declared-tables ACTIVATION is reached even when the
 * template import is SKIPPED.
 *
 * THE MEASURED DEFECT (twice, on a development installation whose database was
 * created from nothing): the boot importer logged
 *
 *   [cinatra:extensions:agent] @cinatra-ai/{pkg} v{version} skipped — already up to
 *       date (bump packageVersion to force re-import)
 *
 * while `SELECT count(*) FROM pg_roles WHERE rolname LIKE 'ext%'` returned 0 for
 * every one of the installed packages and no declared table existed in the
 * application schema. The role and the tables are created by the host's
 * declared-tables activation, which the install pipeline reaches and this
 * git-file import road never did — so every run of a table-declaring package
 * died at its first passthrough call with `role "ext_<scope>_<pkg>" does not
 * exist`.
 *
 * The first case below is the RED one: before the fix the loader took the
 * "already up to date" early return with no activation call at all.
 *
 * Run: cd packages/agents && pnpm exec vitest run \
 *   src/__tests__/ensure-agent-package-declared-tables-activation.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const OAS_PATH = "/extensions/cinatra-ai/blog-pipeline-agent/cinatra/oas.json";
/** The dir the activation must be handed — the agent's own manifest dir. */
const PACKAGE_DIR = "/extensions/cinatra-ai/blog-pipeline-agent";
const PACKAGE = "@cinatra-ai/blog-pipeline-agent";

const OAS_CONTENT = JSON.stringify({
  agentspec_version: "26.1.0",
  component_type: "Flow",
  name: "Blog Pipeline",
  metadata: { cinatra: { packageName: PACKAGE } },
});

/** The real shape of the package that died: it DECLARES a table. */
const DECLARED_TABLES = [
  {
    name: "idea_drafts",
    organizationColumn: "org_id",
    columns: [
      { name: "org_id", type: "text", notNull: true },
      { name: "run_id", type: "text", notNull: true },
    ],
  },
];

const PKG_WITH_TABLES = JSON.stringify({
  name: PACKAGE,
  version: "0.2.2",
  license: "Apache-2.0",
  cinatra: { type: "flow", declaredTables: DECLARED_TABLES },
});

const PKG_WITHOUT_TABLES = JSON.stringify({
  name: PACKAGE,
  version: "0.2.2",
  license: "Apache-2.0",
  cinatra: { type: "flow" },
});

/** Which sibling manifest the mocked filesystem serves for the case at hand. */
const { manifestBody } = vi.hoisted(() => ({ manifestBody: { current: "" } }));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (p: string) => {
    if (p === OAS_PATH) return OAS_CONTENT;
    if (p.endsWith("/package.json")) return manifestBody.current;
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
    templateId: "tpl-blog-pipeline",
    upserted: true,
  })),
}));
vi.mock("../import-agent-core", () => ({
  importAgentTemplateCore: importAgentTemplateCoreMock,
}));

vi.mock("../reserved-workspace-slugs", () => ({
  isReservedWorkspaceSlug: () => false,
}));

/** The install-record heal seam's real module — the skip branch reads it. */
const { healMissingInstallRecordMock } = vi.hoisted(() => ({
  healMissingInstallRecordMock: vi.fn(async () => ({ outcome: "already-live" })),
}));
vi.mock("@/lib/extension-install-anchor", () => ({
  healMissingInstallRecord: healMissingInstallRecordMock,
}));

/** The REAL host module the loader's DEFAULT activation seam resolves. Stubbed
 *  at the module boundary (not at the call site) so the loader's own
 *  resolution + export name + argument shape are exercised. */
const { ensureDeclaredTablesMock } = vi.hoisted(() => ({
  ensureDeclaredTablesMock: vi.fn(
    async (_input: { packageDir: string; packageName?: string }) => ({ activated: true }),
  ),
}));
vi.mock("@/lib/extension-migration-host", () => ({
  ensureExtensionDeclaredTablesFromPackageDir: ensureDeclaredTablesMock,
}));

import { ensureAgentPackageFromGitFile } from "../ensure-agent-package";

/** The DB row the loader compares against — current version, no drift. */
const CURRENT_TEMPLATE = {
  id: "tpl-blog-pipeline",
  packageVersion: "0.2.2",
  lifecycleConfig: null,
};

type ActivationCall = { packageName: string; packageDir: string; packageVersion?: string };

function activationRecorder(impl?: () => Promise<void>) {
  const calls: ActivationCall[] = [];
  const fn = vi.fn(async (input: ActivationCall) => {
    calls.push(input);
    if (impl) await impl();
  });
  return { fn, calls };
}

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  manifestBody.current = PKG_WITH_TABLES;
  importAgentTemplateCoreMock.mockClear();
  setAgentTemplatePackageNameMock.mockClear();
  ensureDeclaredTablesMock.mockClear();
  healMissingInstallRecordMock.mockClear();
  readAgentTemplateByPackageNameMock.mockReset();
  readAgentTemplateByPackageNameMock.mockResolvedValue(CURRENT_TEMPLATE);
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
  warnSpy.mockRestore();
  vi.clearAllMocks();
});

const logged = (spy: ReturnType<typeof vi.spyOn>): string =>
  spy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");

describe("cinatra#3462 — the declared-tables activation is independent of the template-import skip", () => {
  it("RED REPRO: a SKIPPED template import still activates the declared tables", async () => {
    const activation = activationRecorder();

    const result = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      activateDeclaredTables: activation.fn,
    });

    // The skip itself is unchanged — it is about the template row.
    expect(result.skipped).toBe(true);
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
    expect(logged(infoSpy)).toContain("skipped — already up to date");
    // …and the whole defect in one assertion: before the fix this never ran.
    expect(activation.calls).toEqual([
      { packageName: PACKAGE, packageDir: PACKAGE_DIR, packageVersion: "0.2.2" },
    ]);
  });

  it("activates on a FIRST import too (no installed row at all)", async () => {
    readAgentTemplateByPackageNameMock.mockResolvedValue(null);
    const activation = activationRecorder();

    const result = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      activateDeclaredTables: activation.fn,
    });

    expect(result.skipped).toBe(false);
    expect(importAgentTemplateCoreMock).toHaveBeenCalledTimes(1);
    expect(activation.calls).toEqual([
      { packageName: PACKAGE, packageDir: PACKAGE_DIR, packageVersion: "0.2.2" },
    ]);
  });

  it("DEFAULT wiring: with no seam injected the loader resolves the host road and hands it the package dir", async () => {
    const result = await ensureAgentPackageFromGitFile({ oasSourcePath: OAS_PATH });

    expect(result.skipped).toBe(true);
    expect(ensureDeclaredTablesMock).toHaveBeenCalledTimes(1);
    expect(ensureDeclaredTablesMock.mock.calls[0][0]).toEqual({
      packageDir: PACKAGE_DIR,
      packageName: PACKAGE,
    });
  });

  it("a package that declares NO tables never reaches the activation", async () => {
    manifestBody.current = PKG_WITHOUT_TABLES;
    const activation = activationRecorder();

    const result = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      activateDeclaredTables: activation.fn,
    });

    expect(result.skipped).toBe(true);
    expect(activation.calls).toEqual([]);
    expect(ensureDeclaredTablesMock).not.toHaveBeenCalled();
  });

  it("a FAILING activation refuses the import — never an 'already up to date' line", async () => {
    // Codex convergence round 1: swallowing the failure re-created the exact
    // signal this issue is about — a healthy "already up to date" for a package
    // whose database role is missing. The failure is logged AND rethrown; both
    // production callers wrap each package's import in their own try/catch, so
    // the scan continues with the next package.
    const activation = activationRecorder(async () => {
      throw new Error("connection refused");
    });

    await expect(
      ensureAgentPackageFromGitFile({
        oasSourcePath: OAS_PATH,
        activateDeclaredTables: activation.fn,
      }),
    ).rejects.toThrow("connection refused");

    expect(activation.calls).toHaveLength(1);
    expect(logged(warnSpy)).toContain("declared-tables");
    expect(logged(warnSpy)).toContain("connection refused");
    // The false healthy signal never reaches the log, and nothing was imported.
    expect(logged(infoSpy)).not.toContain("already up to date");
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
  });

  it("DEFAULT wiring: a host road that reports NO declaration is a failure, not a success", async () => {
    // The loader only calls the seam for a manifest that DECLARES tables, so
    // `activated: false` means the host re-read a manifest that changed
    // underneath the scan. Discarding it would report a package as imported
    // with no role behind it (codex convergence round 1, SHOULD-FIX).
    ensureDeclaredTablesMock.mockResolvedValueOnce({ activated: false });

    await expect(
      ensureAgentPackageFromGitFile({ oasSourcePath: OAS_PATH }),
    ).rejects.toThrow(/found no declaration/);

    expect(logged(infoSpy)).not.toContain("already up to date");
  });

  it("a DOWNGRADE is refused BEFORE any database object is touched", async () => {
    // Codex convergence round 1, MUST-FIX. The host activation starts from
    // `REVOKE ALL PRIVILEGES ON ALL TABLES` and re-grants only what the CURRENT
    // declaration names. Activating from an older checkout the loader is about
    // to REJECT would therefore strip the installed newer version's grant on
    // every table the old declaration no longer names — the installed version
    // would be "preserved" and broken in the same breath.
    readAgentTemplateByPackageNameMock.mockResolvedValue({
      ...CURRENT_TEMPLATE,
      packageVersion: "0.3.0",
    });
    const activation = activationRecorder();

    const result = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      activateDeclaredTables: activation.fn,
    });

    expect(result.skipped).toBe(true);
    expect(logged(warnSpy)).toContain("UI-installed version preserved");
    expect(activation.calls).toEqual([]);
    expect(ensureDeclaredTablesMock).not.toHaveBeenCalled();
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
  });
});
