/**
 * THE GIT-NATIVE AGENT INGEST — the walk, over a real tree.
 *
 * The walk is what the development boot's awaited agent-ingest phase runs, so
 * its claims are the ones that phase rests on: the one layout it reads
 * (`<vendor>/<slug>/cinatra/oas.json`), the old layouts it names instead of
 * passing over (cinatra#4920), the three answers it counts apart (which is how the
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
  root = await mkdtemp(path.join(tmpdir(), "git-native-agent-ingest-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("ingestGitNativeAgentDefinitions", () => {
  it("reads the vendor layout, hands each definition to the loader, and ignores what is no definition", async () => {
    await writeDefinition(path.join("cinatra-ai", "research-agent", "cinatra", "oas.json"));
    await writeDefinition(path.join("example-org", "scrape-agent", "cinatra", "oas.json"));
    // Neither a definition nor a directory: nothing to find here.
    await writeFile(path.join(root, "README.md"), "not a definition", "utf8");
    // A directory with no agent file at all is no definition and no old layout.
    await mkdir(path.join(root, "example-org", "docs-only"), { recursive: true });

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
        path.join("cinatra-ai", "research-agent", "cinatra", "oas.json"),
        path.join("example-org", "scrape-agent", "cinatra", "oas.json"),
      ].sort(),
    );
  });

  // -------------------------------------------------------------------------
  // cinatra#4920: an agent's definition file is cinatra/oas.json. A directory
  // with an agent.json and no oas.json is not read, and it is not skipped
  // silently either: it is named, with the move, and the rest of the tree still
  // ingests.
  // -------------------------------------------------------------------------

  it("does not read an old-layout directory; names it with the move, and still reads the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const current = path.join("cinatra-ai", "research-agent", "cinatra", "oas.json");
    await writeDefinition(current);
    // The three shapes the retired probes read: a transitional agent.json in a
    // vendor slug directory, a flat cinatra/agent.json, a flat root agent.json.
    await writeDefinition(path.join("cinatra-ai", "scrape-agent", "cinatra", "agent.json"));
    await writeDefinition(path.join("legacy-nested", "cinatra", "agent.json"));
    await writeDefinition(path.join("legacy-flat", "agent.json"));

    const loadDefinition = loaderImporting();
    const report = await ingestGitNativeAgentDefinitions({ sourceRoot: root, loadDefinition });

    // The loader is handed the oas.json only; the old layouts never reach it.
    expect(report.found).toBe(1);
    expect(report.imported).toBe(1);
    expect(loadDefinition.paths).toEqual([current]);

    const oldDirs = [
      path.join("cinatra-ai", "scrape-agent"),
      "legacy-nested",
      "legacy-flat",
    ];
    expect(report.failures.map((f) => f.definitionPath).sort()).toEqual([...oldDirs].sort());
    for (const failure of report.failures) {
      expect(failure.reason).toContain(failure.definitionPath);
      expect(failure.reason).toContain("move it to cinatra/oas.json");
    }
    // Logged too, with the directory, once each.
    for (const dir of oldDirs) {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`${path.join(root, dir)} is an agent in the old layout`),
      );
    }
  });

  it("a directory that has both files is read from its oas.json and is not an old layout", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeDefinition(path.join("cinatra-ai", "research-agent", "cinatra", "oas.json"));
    await writeDefinition(path.join("cinatra-ai", "research-agent", "cinatra", "agent.json"));
    await writeDefinition(path.join("legacy-both", "cinatra", "oas.json"));
    await writeDefinition(path.join("legacy-both", "cinatra", "agent.json"));

    const loadDefinition = loaderImporting();
    const report = await ingestGitNativeAgentDefinitions({ sourceRoot: root, loadDefinition });

    expect(report.found).toBe(1);
    expect(loadDefinition.paths).toEqual([
      path.join("cinatra-ai", "research-agent", "cinatra", "oas.json"),
    ]);
    expect(report.failures).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("an old-layout directory alone ingests nothing and does not throw", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeDefinition(path.join("legacy-flat", "agent.json"));

    const loadDefinition = loaderImporting();
    const report = await ingestGitNativeAgentDefinitions({ sourceRoot: root, loadDefinition });

    expect(report.found).toBe(0);
    expect(loadDefinition.paths).toEqual([]);
    expect(report.pending).toEqual([]);
    expect(report.failures).toEqual([
      expect.objectContaining({ definitionPath: "legacy-flat" }),
    ]);
  });

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
    expect(report.failures).toEqual([]);
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
