/**
 * THE GIT-NATIVE AGENT INGEST — the walk, over a real tree.
 *
 * The walk is what the development boot's awaited agent-ingest phase runs, so
 * its claims are the ones that phase rests on: the layouts it recognises, the
 * order it probes them in, the three answers it counts apart (which is how the
 * phase says "nothing to do" truthfully), the budget that keeps a stuck loader
 * from becoming a boot the watchdog exits, and that one definition the loader
 * cannot read is named and does not cost the tree its other definitions.
 *
 * The per-definition loader is the seam. It is injected here because these are
 * claims about the WALK; the claims about rows are the real-database tier's
 * (`git-native-agent-ingest.integration.test.ts`).
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GIT_NATIVE_AGENT_INGEST_BUDGET_MS,
  ingestGitNativeAgentDefinitions,
  type GitNativeAgentDefinitionLoader,
} from "@/lib/git-native-agent-ingest";

let root = "";
// The operator's own vendor directory: the ingest asks the instance identity
// which vendors a by-slug read walks (the real store reaches the database).
const identity = vi.hoisted(() => ({ namespace: null as string | null }));
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: () => (identity.namespace ? { instanceNamespace: identity.namespace } : null),
}));

/** Write a definition at `relativePath`, creating the directories above it. */
async function writeDefinition(relativePath: string): Promise<string> {
  const full = path.join(root, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify({ name: path.basename(path.dirname(full)) }), "utf8");
  return relativePath;
}

/** The loader's answers, by name, exactly as `ensure-agent-package` returns them. */
const IMPORTED = { templateId: "tpl-1", upserted: true, skipped: false } as const;
/** A create: nothing was UPDATED, but a row was written. */
const IMPORTED_FIRST_TIME = { templateId: "tpl-1", upserted: false, skipped: false } as const;
/** The version-skip / downgrade guards: a row stands, nothing was written. */
const ALREADY_ON_FILE = { templateId: "tpl-1", upserted: false, skipped: true } as const;
/** The three refusals: no row, no id. */
const DECLINED = { templateId: "", upserted: false, skipped: true } as const;

/** A loader that imports every definition and records the paths. */
function loaderImporting(): GitNativeAgentDefinitionLoader & { paths: string[] } {
  const paths: string[] = [];
  const fn = vi.fn(async ({ oasSourcePath }: { oasSourcePath: string }) => {
    paths.push(path.relative(root, oasSourcePath));
    return IMPORTED;
  });
  return Object.assign(fn as unknown as GitNativeAgentDefinitionLoader, { paths });
}

beforeEach(async () => {
  identity.namespace = null;
  root = await mkdtemp(path.join(tmpdir(), "git-native-agent-ingest-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("ingestGitNativeAgentDefinitions", () => {
  it("hands each cinatra/oas.json under a vendor directory to the loader", async () => {
    await writeDefinition(path.join("cinatra-ai", "research-agent", "cinatra", "oas.json"));
    await writeDefinition(path.join("acme-ops", "scrape-agent", "cinatra", "oas.json"));
    // Neither a definition nor a directory: nothing to find here.
    await writeFile(path.join(root, "README.md"), "not a definition", "utf8");

    const loadDefinition = loaderImporting();
    const report = await ingestGitNativeAgentDefinitions({ sourceRoot: root, loadDefinition });

    expect(report.found).toBe(2);
    expect(report.imported).toBe(2);
    expect(report.alreadyOnFile).toBe(0);
    expect(report.declined).toBe(0);
    expect(report.pending).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.sourceRoot).toBe(root);
    expect([...loadDefinition.paths].sort()).toEqual(
      [
        path.join("acme-ops", "scrape-agent", "cinatra", "oas.json"),
        path.join("cinatra-ai", "research-agent", "cinatra", "oas.json"),
      ].sort(),
    );
  });

  // Every agent source directory is READ (handed to the loader) or REPORTED (a
  // failure naming the directory, the file found and the exact place the
  // definition must be), keyed by path, with no directory name skipped
  // (cinatra#4920). One table; every top-level directory is a vendor here.
  const S = "acme-agent";
  const V = "cinatra-ai";
  const OP = "acme-ops";
  type Row = {
    name: string;
    files: string[];
    read: string[];
    reported?: Array<{ dir: string; found: string[]; at: string; also?: string }>;
    /** directory -> the directory a by-slug read selects instead (report line only) */
    shadowed?: Record<string, string>;
  };
  const ROWS: Row[] = [
    { name: "scoped canonical", files: [`${V}/${S}/cinatra/oas.json`], read: [`${V}/${S}`] },
    { name: "scoped old-only, cinatra/agent.json", files: [`${V}/${S}/cinatra/agent.json`], read: [], reported: [{ dir: `${V}/${S}`, found: ["cinatra/agent.json"], at: `${V}/${S}/cinatra/oas.json` }] },
    { name: "scoped old-only, root agent.json", files: [`${V}/${S}/agent.json`], read: [], reported: [{ dir: `${V}/${S}`, found: ["agent.json"], at: `${V}/${S}/cinatra/oas.json` }] },
    { name: "scoped old-only, both old forms", files: [`${V}/${S}/cinatra/agent.json`, `${V}/${S}/agent.json`], read: [], reported: [{ dir: `${V}/${S}`, found: ["cinatra/agent.json", "agent.json"], at: `${V}/${S}/cinatra/oas.json` }] },
    { name: "scoped both", files: [`${V}/${S}/cinatra/oas.json`, `${V}/${S}/cinatra/agent.json`, `${V}/${S}/agent.json`], read: [`${V}/${S}`] },
    { name: "flat canonical", files: [`${S}/cinatra/oas.json`], read: [], reported: [{ dir: `${S}`, found: ["cinatra/oas.json"], at: `${OP}/${S}/cinatra/oas.json` }] },
    { name: "flat old-only, cinatra/agent.json", files: [`${S}/cinatra/agent.json`], read: [], reported: [{ dir: `${S}`, found: ["cinatra/agent.json"], at: `${OP}/${S}/cinatra/oas.json` }] },
    { name: "flat old-only, root agent.json", files: [`${S}/agent.json`], read: [], reported: [{ dir: `${S}`, found: ["agent.json"], at: `${OP}/${S}/cinatra/oas.json` }] },
    { name: "flat both", files: [`${S}/cinatra/oas.json`, `${S}/cinatra/agent.json`, `${S}/agent.json`], read: [], reported: [{ dir: `${S}`, found: ["cinatra/oas.json", "cinatra/agent.json", "agent.json"], at: `${OP}/${S}/cinatra/oas.json` }] },
    { name: "slug cinatra, scoped", files: [`${V}/cinatra/cinatra/oas.json`], read: [`${V}/cinatra`] },
    { name: "a vendor directory that holds its own definition", files: [`${V}/agent.json`, `${V}/${S}/cinatra/oas.json`], read: [`${V}/${S}`], reported: [{ dir: `${V}`, found: ["agent.json"], at: `${OP}/${V}/cinatra/oas.json` }] },
    { name: "operator canonical + first-party canonical", files: [`${OP}/${S}/cinatra/oas.json`, `${V}/${S}/cinatra/oas.json`], read: [`${OP}/${S}`, `${V}/${S}`], shadowed: { [`${V}/${S}`]: `${OP}/${S}` } },
    { name: "operator old + first-party canonical", files: [`${OP}/${S}/cinatra/agent.json`, `${V}/${S}/cinatra/oas.json`], read: [`${V}/${S}`], reported: [{ dir: `${OP}/${S}`, found: ["cinatra/agent.json"], at: `${OP}/${S}/cinatra/oas.json` }], shadowed: { [`${V}/${S}`]: `${OP}/${S}` } },
    { name: "operator canonical + first-party old", files: [`${OP}/${S}/cinatra/oas.json`, `${V}/${S}/cinatra/agent.json`], read: [`${OP}/${S}`], reported: [{ dir: `${V}/${S}`, found: ["cinatra/agent.json"], at: `${V}/${S}/cinatra/oas.json` }], shadowed: { [`${V}/${S}`]: `${OP}/${S}` } },
    { name: "flat + scoped, same slug", files: [`${V}/${S}/cinatra/oas.json`, `${S}/agent.json`], read: [`${V}/${S}`], reported: [{ dir: `${S}`, found: ["agent.json"], at: `${OP}/${S}/cinatra/oas.json` }], shadowed: { [`${S}`]: `${V}/${S}` } },
    { name: "operator, first-party and flat directories with one slug", files: [`${OP}/${S}/cinatra/oas.json`, `${V}/${S}/cinatra/oas.json`, `${S}/cinatra/oas.json`], read: [`${OP}/${S}`, `${V}/${S}`], reported: [{ dir: `${S}`, found: ["cinatra/oas.json"], at: `${OP}/${S}/cinatra/oas.json`, also: "already holds a definition" }], shadowed: { [`${V}/${S}`]: `${OP}/${S}`, [`${S}`]: `${OP}/${S}` } },
    { name: "legacy renamed slug", files: [`drupal-content-editor/cinatra/agent.json`], read: [], reported: [{ dir: `drupal-content-editor`, found: ["cinatra/agent.json"], at: `${OP}/drupal-agent/cinatra/oas.json` }] },
    { name: "any other vendor directory is walked", files: [`other-vendor/${S}/cinatra/oas.json`], read: [`other-vendor/${S}`] },
  ];

  for (const row of ROWS) {
    it(`table: ${row.name}`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      identity.namespace = OP;
      for (const f of row.files) await writeDefinition(f);
      const loadDefinition = loaderImporting();
      const report = await ingestGitNativeAgentDefinitions({ sourceRoot: root, loadDefinition });

      const canonical = (d: string) => path.join(d, "cinatra", "oas.json");
      expect([...loadDefinition.paths].sort()).toEqual(row.read.map(canonical).sort());
      expect(loadDefinition.paths.filter((p) => path.basename(p) === "agent.json")).toEqual([]);
      expect(report.found).toBe(row.read.length);

      const reported = row.reported ?? [];
      const shadowed = row.shadowed ?? {};
      expect(report.failures).toHaveLength(reported.length);
      for (const r of reported) {
        const failure = report.failures.find((f) => f.definitionPath === path.normalize(r.dir));
        expect(failure).toBeDefined();
        for (const text of [...r.found, path.normalize(r.at), ...(r.also ? [r.also] : [])]) expect(failure!.reason).toContain(text);
        if (shadowed[r.dir]) expect(failure!.reason).toContain("is also shadowed: a read of slug");
      }
      // A READ directory a by-slug read does not select is still loaded (above) and has its line.
      const lines = warn.mock.calls.map((c) => String(c[0]));
      for (const d of row.read.filter((x) => shadowed[x])) {
        expect(lines.find((l) => l.includes(`${path.normalize(d)} is shadowed: a read of slug`))).toContain(path.normalize(shadowed[d]));
      }
    });
  }

  it("counts a definition reaching the database for the FIRST time as read in", async () => {
    // The loader's create road answers `upserted: false` (nothing was updated —
    // a row was minted) with `skipped: false`. Reading the wrong field here
    // reported a whole first ingest as "already current" while 30 rows appeared.
    await writeDefinition(path.join("cinatra-ai", "research-agent", "cinatra", "oas.json"));

    const report = await ingestGitNativeAgentDefinitions({
      sourceRoot: root,
      loadDefinition: async () => IMPORTED_FIRST_TIME,
    });

    expect(report.imported).toBe(1);
    expect(report.alreadyOnFile).toBe(0);
    expect(report.declined).toBe(0);
  });

  it("tells a definition the loader DECLINED apart from one already on file", async () => {
    // Both answer `skipped: true`, and only the template id separates them: the
    // loader's three refusals (unreadable sibling manifest, no package name,
    // reserved workspace slug) return no id, while the version-skip and the
    // downgrade guard both return the standing row's id. Folding them together
    // would report a definition nobody can run as "already current".
    await writeDefinition(path.join("cinatra-ai", "research-agent", "cinatra", "oas.json"));
    await writeDefinition(path.join("cinatra-ai", "scrape-agent", "cinatra", "oas.json"));
    await writeDefinition(path.join("cinatra-ai", "broken-agent", "cinatra", "oas.json"));

    const report = await ingestGitNativeAgentDefinitions({
      sourceRoot: root,
      loadDefinition: async ({ oasSourcePath }) =>
        oasSourcePath.includes("broken-agent") ? DECLINED : ALREADY_ON_FILE,
    });

    expect(report.found).toBe(3);
    expect(report.imported).toBe(0);
    expect(report.alreadyOnFile).toBe(2);
    expect(report.declined).toBe(1);
    expect(report.failures).toEqual([]);
  });

  it("prefers oas.json over the transitional agent.json beside it", async () => {
    await writeDefinition(path.join("cinatra-ai", "research-agent", "cinatra", "oas.json"));
    await writeDefinition(path.join("cinatra-ai", "research-agent", "cinatra", "agent.json"));

    const loadDefinition = loaderImporting();
    const report = await ingestGitNativeAgentDefinitions({ sourceRoot: root, loadDefinition });

    expect(report.found).toBe(1);
    expect(loadDefinition.paths).toEqual([
      path.join("cinatra-ai", "research-agent", "cinatra", "oas.json"),
    ]);
  });

  it("does not fall back to the flat layouts inside a vendor directory that yielded a definition", async () => {
    await writeDefinition(path.join("cinatra-ai", "research-agent", "cinatra", "oas.json"));
    // Would match the fallback layout if the vendor probe had not already hit.
    await writeDefinition(path.join("cinatra-ai", "agent.json"));

    const loadDefinition = loaderImporting();
    const report = await ingestGitNativeAgentDefinitions({ sourceRoot: root, loadDefinition });

    expect(report.found).toBe(1);
    expect(loadDefinition.paths).toEqual([
      path.join("cinatra-ai", "research-agent", "cinatra", "oas.json"),
    ]);
  });

  it("counts an already-current definition apart, so a second run has nothing to report", async () => {
    await writeDefinition(path.join("cinatra-ai", "research-agent", "cinatra", "oas.json"));
    await writeDefinition(path.join("cinatra-ai", "scrape-agent", "cinatra", "oas.json"));

    const first = await ingestGitNativeAgentDefinitions({
      sourceRoot: root,
      loadDefinition: async () => IMPORTED,
    });
    expect(first.imported).toBe(2);
    expect(first.alreadyOnFile).toBe(0);

    // The loader's own version-skip answer on a tree that has not moved.
    const second = await ingestGitNativeAgentDefinitions({
      sourceRoot: root,
      loadDefinition: async () => ALREADY_ON_FILE,
    });
    expect(second.found).toBe(2);
    expect(second.imported).toBe(0);
    expect(second.alreadyOnFile).toBe(2);
    expect(second.declined).toBe(0);
    expect(second.failures).toEqual([]);
  });

  it("names a definition the loader cannot read and still reads the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = path.join("cinatra-ai", "broken-agent", "cinatra", "oas.json");
    await writeDefinition(broken);
    await writeDefinition(path.join("cinatra-ai", "research-agent", "cinatra", "oas.json"));
    await writeDefinition(path.join("cinatra-ai", "scrape-agent", "cinatra", "oas.json"));

    const report = await ingestGitNativeAgentDefinitions({
      sourceRoot: root,
      loadDefinition: async ({ oasSourcePath }) => {
        if (path.relative(root, oasSourcePath) === broken) {
          throw new Error("Unexpected token } in JSON at position 12");
        }
        return IMPORTED;
      },
    });

    expect(report.found).toBe(3);
    expect(report.imported).toBe(2);
    expect(report.pending).toEqual([]);
    expect(report.failures).toEqual([
      { definitionPath: broken, reason: "Unexpected token } in JSON at position 12" },
    ]);
    // The definition is named in the log too, by the same relative path.
    expect(warn).toHaveBeenCalledWith(
      `[agent-builder] git agent load skipped (${broken}):`,
      expect.any(Error),
    );
  });

  // -------------------------------------------------------------------------
  // The budget. Without it a loader that never answers sits in the boot until
  // the stall watchdog collects it, and that watchdog's development arm exits
  // the process.
  // -------------------------------------------------------------------------

  it("stops at its budget and names the definitions it never reached", async () => {
    const first = path.join("cinatra-ai", "a-agent", "cinatra", "oas.json");
    const second = path.join("cinatra-ai", "b-agent", "cinatra", "oas.json");
    const third = path.join("cinatra-ai", "c-agent", "cinatra", "oas.json");
    for (const d of [first, second, third]) await writeDefinition(d);

    const report = await ingestGitNativeAgentDefinitions({
      sourceRoot: root,
      budgetMs: 40,
      loadDefinition: async ({ oasSourcePath }) => {
        if (path.relative(root, oasSourcePath) === first) return IMPORTED;
        // Never answers — the shape the budget exists for.
        return new Promise(() => {});
      },
    });

    expect(report.found).toBe(3);
    expect(report.imported).toBe(1);
    // The stuck definition and everything behind it, named — and NOT filed as a
    // read failure, which would say the loader answered.
    expect(report.pending).toEqual([second, third]);
    expect(report.failures).toEqual([]);
  });

  it("leaves nothing pending on a walk that finishes, and ships a budget under the stall deadline", async () => {
    await writeDefinition(path.join("cinatra-ai", "research-agent", "cinatra", "oas.json"));

    const report = await ingestGitNativeAgentDefinitions({
      sourceRoot: root,
      loadDefinition: async () => IMPORTED,
    });
    expect(report.pending).toEqual([]);

    // 180_000 is BOOT_STALL_DEADLINE_MS; the walk has to give up first or the
    // watchdog exits the development server instead.
    expect(GIT_NATIVE_AGENT_INGEST_BUDGET_MS).toBeLessThan(180_000);
  });

  it("throws when the source root itself cannot be read — that is the caller's question", async () => {
    await expect(
      ingestGitNativeAgentDefinitions({
        sourceRoot: path.join(root, "no-such-tree"),
        loadDefinition: async () => IMPORTED,
      }),
    ).rejects.toThrow();
  });
});
