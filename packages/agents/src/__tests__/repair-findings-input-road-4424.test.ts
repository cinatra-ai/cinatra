/**
 * cinatra#4424 — the reviewer's findings reach a repair run only through the
 * input its producer declares.
 *
 * 1. No module except the CMS repair bridge itself names
 *    `projectCmsRepairInputParams`: the dispatch drain no longer asks the
 *    bridge for `task` and `instructions` text, for any base. Source text, not
 *    behaviour: the invariant is the absence of a caller (the same technique as
 *    `blog-repair-new-run-road-structural.test.ts`).
 * 2. The development lock pins the Drupal and WordPress agent commits whose
 *    manifests declare `repairFindingsInput: { input: "instructions" }`, and,
 *    where the pinned tree is on disk, that declaration parses through the real
 *    manifest contract and projects the findings into `instructions`.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { agentLifecycleDeclarationSchema } from "../verdaccio/package-contract";
import { normalizeLifecycle, projectRepairFindingsInput } from "@/lib/lifecycle/lifecycle-policy";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const BRIDGE = path.join(REPO_ROOT, "packages/agents/src/lifecycle-repair-cms-production-bridge.ts");
const SELF = path.resolve(__filename);
const SCAN_ROOTS = ["src", "packages", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", ".turbo"]);
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;

function codeFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) codeFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile() && CODE_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe("cinatra#4424 — the dispatch drain no longer calls the CMS repair bridge's projection", () => {
  it("no module except the bridge itself names projectCmsRepairInputParams", () => {
    const files = SCAN_ROOTS.flatMap((root) => codeFiles(path.join(REPO_ROOT, root)));
    // The walk must actually reach the drain and the bridge, or an empty scan passes.
    expect(files).toContain(BRIDGE);
    expect(files).toContain(path.join(REPO_ROOT, "packages/agents/src/lifecycle-repair-dispatch-store.ts"));
    const callers = files
      .filter((file) => file !== BRIDGE && path.resolve(file) !== SELF)
      .filter((file) => readFileSync(file, "utf8").includes("projectCmsRepairInputParams"))
      .map((file) => path.relative(REPO_ROOT, file));
    expect(callers).toEqual([]);
  });

  it("the drain does not load the bridge module at all", () => {
    const drain = readFileSync(path.join(REPO_ROOT, "packages/agents/src/lifecycle-repair-dispatch-store.ts"), "utf8");
    expect(drain).not.toContain("lifecycle-repair-cms-production-bridge");
  });
});

type LockEntry = { packageName: string; resolvedSha: string };
const DECLARED = { repairCapable: true, repairFindingsInput: { input: "instructions" } };
const CMS_AGENTS = [
  { packageName: "@cinatra-ai/drupal-agent", dir: "drupal-agent", sha: "49bd804092915759a151ee6dfb7340c98f88a0e7" },
  { packageName: "@cinatra-ai/wordpress-agent", dir: "wordpress-agent", sha: "b434f0a1535620d100b1609d3426734df05a537a" },
] as const;

function devLock(): LockEntry[] {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, "cinatra-dev-extensions.lock.json"), "utf8")).packages as LockEntry[];
}

describe("cinatra#4424 — the pinned CMS agents declare the input that gets the findings", () => {
  for (const agent of CMS_AGENTS) {
    it(`${agent.packageName}: the dev lock pins the commit that declares instructions`, () => {
      expect(devLock().find((entry) => entry.packageName === agent.packageName)?.resolvedSha).toBe(agent.sha);
    });

    it(`${agent.packageName}: where the pinned tree is on disk, its manifest declares instructions and the drain projects the findings there`, () => {
      const manifestPath = path.join(REPO_ROOT, "extensions", "cinatra-ai", agent.dir, "package.json");
      if (!existsSync(manifestPath)) return;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { cinatra?: { lifecycle?: unknown } };
      expect(manifest.cinatra?.lifecycle).toEqual(DECLARED);
      const parsed = agentLifecycleDeclarationSchema.parse(manifest.cinatra?.lifecycle);
      const compiled = normalizeLifecycle(parsed);
      const projected = projectRepairFindingsInput(compiled, [{ message: "Use the reviewed title", path: "title" }]);
      expect(Object.keys(projected ?? {})).toEqual(["instructions"]);
      expect(projected?.instructions).toContain("Use the reviewed title");
    });
  }
});
