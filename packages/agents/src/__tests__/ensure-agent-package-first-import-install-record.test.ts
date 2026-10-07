/**
 * cinatra#3589 — a FIRST import must write the canonical install record, so ONE
 * start of the application is enough.
 *
 * THE REPRO (the development installation in the issue): three agent packages
 * were imported for the FIRST time at their version, the loader logged a plain
 *
 *   [cinatra:extensions:agent] @cinatra-ai/blog-pipeline-agent {version} upserted
 *
 * with no error — and the agents page listed none of them, its search answering
 * "No agents match pipeline", while a direct visit to the agent's own `new` page
 * answered 200. `cinatra.installed_extension` carried no row for the package: a
 * `guardedOptional` package with no canonical row is classified `not-installed`
 * and dropped from the page. The five agents that WERE listed had each logged
 * the cinatra#2536 repair line first — i.e. only the repair road of a LATER
 * start ever wrote the record.
 *
 * The first two cases below are the RED ones: the import itself happens on both
 * roads, and before the fix the heal seam was never consulted on either, so no
 * canonical record existed. The last two are green-before/green-after arms that
 * pin the repair road's single consultation against being doubled.
 *
 * Run: cd packages/agents && pnpm exec vitest run \
 *   src/__tests__/ensure-agent-package-first-import-install-record.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const OAS_PATH = "/extensions/cinatra-ai/blog-pipeline-agent/cinatra/oas.json";
const PACKAGE = "@cinatra-ai/blog-pipeline-agent";
/** The dir the anchor must be handed — the agent's own manifest dir. */
const PACKAGE_DIR = "/extensions/cinatra-ai/blog-pipeline-agent";
const VERSION = "0.2.4";

const OAS_CONTENT = JSON.stringify({
  agentspec_version: "26.1.0",
  component_type: "Flow",
  name: "Blog Pipeline",
  metadata: { cinatra: { packageName: PACKAGE } },
});

const PKG_CONTENT = JSON.stringify({
  name: PACKAGE,
  version: VERSION,
  license: "Apache-2.0",
  cinatra: { type: "flow" },
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

/** The heal seam's real module — stubbed at the module boundary exactly as the
 *  two existing suites beside this one do, so a case that injects no seam still
 *  reaches a stub and never the database. */
const { healMissingInstallRecordMock } = vi.hoisted(() => ({
  healMissingInstallRecordMock: vi.fn(async () => ({ outcome: "already-live" })),
}));
vi.mock("@/lib/extension-install-anchor", () => ({
  healMissingInstallRecord: healMissingInstallRecordMock,
}));

import { ensureAgentPackageFromGitFile } from "../ensure-agent-package";

/** The DB row the loader compares against — current version, no drift. */
const CURRENT_TEMPLATE = {
  id: "tpl-blog-pipeline",
  packageVersion: VERSION,
  lifecycleConfig: null,
};

type HealCall = { packageName: string; kind: string; packageDir?: string; version?: string };

/**
 * The canonical store as far as this loader can see it: at most ONE active row
 * per package, behind the idempotent heal seam. A probe that finds the row
 * answers `already-live` and writes nothing; an absent record is minted once.
 * So the row list after a run is the answer to "how many active canonical
 * records does this package have, and at which version".
 */
function canonicalStore(initial: { version: string } | null) {
  let row: { version: string } | null = initial;
  const calls: HealCall[] = [];
  const fn = vi.fn(async (input: HealCall) => {
    calls.push(input);
    if (row) return { outcome: "already-live", rowId: "iext_live0001" };
    row = { version: input.version ?? "unknown" };
    return { outcome: "repaired", rowId: "iext_healed01" };
  });
  return { fn, calls, rows: (): Array<{ version: string }> => (row ? [row] : []) };
}

const ANCHOR_CALL = {
  packageName: PACKAGE,
  kind: "agent",
  packageDir: PACKAGE_DIR,
  version: VERSION,
};

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  importAgentTemplateCoreMock.mockClear();
  setAgentTemplatePackageNameMock.mockClear();
  healMissingInstallRecordMock.mockClear();
  readAgentTemplateByPackageNameMock.mockReset();
  readAgentTemplateByPackageNameMock.mockResolvedValue(CURRENT_TEMPLATE);
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
  warnSpy.mockRestore();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("cinatra#3589 — a first import writes the canonical install record", () => {
  it("RED REPRO: a package the installation has NEVER imported is anchored on that first import", async () => {
    readAgentTemplateByPackageNameMock.mockResolvedValue(null);
    const store = canonicalStore(null);

    const result = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      healInstallRecord: store.fn,
    });

    // The import itself DID happen — the defect was never a failed import.
    expect(result.skipped).toBe(false);
    expect(importAgentTemplateCoreMock).toHaveBeenCalledTimes(1);
    // …and the whole defect in one assertion: before the fix the seam was never
    // consulted on this road, so the package ended the start with no row and the
    // agents page dropped it.
    expect(store.calls).toEqual([ANCHOR_CALL]);
    expect(store.rows()).toEqual([{ version: VERSION }]);
  });

  it("RED REPRO: a VERSION BUMP anchors the record at the NEW version", async () => {
    readAgentTemplateByPackageNameMock.mockResolvedValue({
      ...CURRENT_TEMPLATE,
      packageVersion: "0.2.3",
    });
    const store = canonicalStore(null);

    const result = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      healInstallRecord: store.fn,
    });

    expect(result.skipped).toBe(false);
    expect(importAgentTemplateCoreMock).toHaveBeenCalledTimes(1);
    expect(store.calls).toEqual([ANCHOR_CALL]);
    expect(store.rows()).toEqual([{ version: VERSION }]);
  });

  it("IDEMPOTENCE: a second import of the SAME version consults the seam once and asks for no second record", async () => {
    const store = canonicalStore({ version: VERSION });

    const result = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      healInstallRecord: store.fn,
    });

    // The version-skip guard's own gate read the live record and skipped.
    expect(result.skipped).toBe(true);
    expect(importAgentTemplateCoreMock).not.toHaveBeenCalled();
    expect(store.calls).toEqual([ANCHOR_CALL]);
    expect(store.rows()).toEqual([{ version: VERSION }]);
  });

  it("THE REPAIR ROAD still repairs exactly once — the first-import anchor never doubles it", async () => {
    const store = canonicalStore(null);

    const result = await ensureAgentPackageFromGitFile({
      oasSourcePath: OAS_PATH,
      healInstallRecord: store.fn,
    });

    // Repaired at a matching version → re-import, exactly as cinatra#2536 left it.
    expect(result.skipped).toBe(false);
    expect(importAgentTemplateCoreMock).toHaveBeenCalledTimes(1);
    expect(store.calls).toEqual([ANCHOR_CALL]);
    expect(store.rows()).toEqual([{ version: VERSION }]);
  });
});
