import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readDevAppsConfig, syncDevApps } from "../dev-apps.mjs";
import { envOverrideVarFor } from "../dev-repo-sync.mjs";

const URL = "https://github.com/cinatra-ai/wordpress-plugin.git";

/** Minimal injectable deps double (records git invocations). */
function makeDeps(state) {
  const gitNames = [];
  return {
    gitNames,
    exists: (p) => state.existsPaths.has(p),
    readdir: (p) => state.dirEntries?.[p] ?? [],
    mkdirp: () => {},
    git: (args) => {
      const j = args.join(" ");
      gitNames.push(j);
      return "";
    },
  };
}

describe("syncDevApps — flags + config", () => {
  const cfg = {
    "@cinatra-ai/wordpress-plugin": { url: URL, path: "dev/wordpress-plugin", branch: "main" },
  };
  const withConfig = (state) => ({ ...makeDeps(state), readFile: () => JSON.stringify({ cinatra: { devApps: cfg } }) });

  it("--skip-dev-apps → skipped, no git", async () => {
    const deps = withConfig({ existsPaths: new Set() });
    const r = await syncDevApps({ repoRoot: "/repo", targetRoot: "/repo", argv: ["--skip-dev-apps"], deps, log: () => {} });
    expect(r.skipped).toBe(true);
    expect(deps.gitNames.length).toBe(0);
  });

  it("no config → skipped (no-config)", async () => {
    const deps = { ...makeDeps({ existsPaths: new Set() }), readFile: () => JSON.stringify({ cinatra: {} }) };
    const r = await syncDevApps({ repoRoot: "/repo", targetRoot: "/repo", argv: [], deps, log: () => {} });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe("no-config");
  });

  it("env override URL replaces the configured URL", async () => {
    const deps = withConfig({ existsPaths: new Set() });
    await syncDevApps({
      repoRoot: "/repo",
      targetRoot: "/repo",
      argv: [],
      env: { CINATRA_WORDPRESS_PLUGIN_REPO_URL: "git@github.com:me/fork.git" },
      deps,
      log: () => {},
    });
    expect(deps.gitNames.some((g) => g.includes("git@github.com:me/fork.git"))).toBe(true);
  });

  it("resolves the dest under targetRoot (worktree), not repoRoot", async () => {
    const deps = withConfig({ existsPaths: new Set() });
    await syncDevApps({ repoRoot: "/main", targetRoot: "/wt", argv: [], deps, log: () => {} });
    expect(deps.gitNames.some((g) => g.endsWith("/wt/dev/wordpress-plugin"))).toBe(true);
  });
});

describe("readDevAppsConfig", () => {
  it("reads cinatra.devApps from package.json", () => {
    const fake = () => JSON.stringify({ cinatra: { devApps: { a: { url: "u", path: "p" } } } });
    expect(readDevAppsConfig("/repo", fake)).toEqual({ a: { url: "u", path: "p" } });
  });
  it("returns null when absent or unreadable", () => {
    expect(readDevAppsConfig("/repo", () => "{}")).toBeNull();
    expect(readDevAppsConfig("/repo", () => { throw new Error("ENOENT"); })).toBeNull();
  });
});

describe("cinatra.devApps — a2a-servers-dev entry (real root package.json)", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const devApps = pkg?.cinatra?.devApps ?? {};

  it("declares @cinatra-ai/a2a-servers-dev cloned into dev/a2a-peers on main", () => {
    const spec = devApps["@cinatra-ai/a2a-servers-dev"];
    expect(spec, "a2a-servers-dev missing from cinatra.devApps").toBeTruthy();
    expect(spec.path).toBe("dev/a2a-peers");
    expect(spec.branch).toBe("main");
    expect(spec.url).toMatch(/github\.com[:/]cinatra-ai\/a2a-servers-dev(\.git)?$/);
  });

  it("derives the documented CINATRA_A2A_SERVERS_DEV_REPO_URL override var", () => {
    expect(envOverrideVarFor("@cinatra-ai/a2a-servers-dev")).toBe(
      "CINATRA_A2A_SERVERS_DEV_REPO_URL",
    );
  });

  it("keeps the dev/ clone target gitignored (never committed to the monorepo)", () => {
    const gitignore = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^\/dev\/$/m);
  });
});
