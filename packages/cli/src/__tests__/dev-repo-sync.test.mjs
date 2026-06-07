import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  envOverrideVarFor,
  normalizeGitHubRemote,
  syncOneRepo,
  isAllowedGitRemote,
  redactGitUrl,
  isLocalGitRemote,
} from "../dev-repo-sync.mjs";

const DEST = "/repo/dev/wordpress-plugin";
const URL = "https://github.com/cinatra-ai/wordpress-plugin.git";

/**
 * Build an injectable deps double driven by a state object.
 * state: { existsPaths:Set, dirEntries:{}, origin, branch, dirty }
 */
function makeDeps(state) {
  const calls = [];
  const gitNames = [];
  return {
    calls,
    gitNames,
    exists: (p) => state.existsPaths.has(p),
    readdir: (p) => state.dirEntries?.[p] ?? [],
    mkdirp: (p) => calls.push(["mkdirp", p]),
    git: (args) => {
      const j = args.join(" ");
      gitNames.push(j);
      if (j.startsWith("clone")) return "";
      if (j === "remote get-url origin") return state.origin ?? "";
      if (j === "rev-parse --abbrev-ref HEAD") return state.branch ?? "";
      if (j === "status --porcelain") return state.dirty ? " M somefile\n" : "";
      return "";
    },
  };
}

const baseArgs = { pkgName: "@cinatra-ai/wordpress-plugin", url: URL, branch: "main", dest: DEST, log: () => {} };

describe("syncOneRepo — git-arg + remote-allowlist + credential guards", () => {
  // Guards must throw BEFORE touching the filesystem / running git.
  const guardDeps = makeDeps({ existsPaths: new Set() });
  it("refuses a flag-like url (leading dash)", () => {
    expect(() => syncOneRepo({ ...baseArgs, url: "-c", deps: guardDeps })).toThrow(/flag-like/);
    expect(guardDeps.gitNames).toEqual([]); // never reached git
  });
  it("refuses a flag-like branch", () => {
    expect(() => syncOneRepo({ ...baseArgs, branch: "--upload-pack=evil", deps: guardDeps })).toThrow(/flag-like/);
  });
  it("refuses a non-GitHub, non-local remote", () => {
    expect(() => syncOneRepo({ ...baseArgs, url: "https://evil.example.com/x.git", deps: guardDeps })).toThrow(
      /not GitHub or a local path/,
    );
    expect(() => syncOneRepo({ ...baseArgs, url: "http://github.com/x/y", deps: guardDeps })).toThrow(/not GitHub/); // http, not https
  });
  it("allowlist accepts github https/ssh/scp + local paths + file://", () => {
    expect(isAllowedGitRemote("https://github.com/cinatra-ai/x.git")).toBe(true);
    expect(isAllowedGitRemote("ssh://git@github.com/cinatra-ai/x.git")).toBe(true);
    expect(isAllowedGitRemote("git@github.com:cinatra-ai/x.git")).toBe(true);
    expect(isAllowedGitRemote("/tmp/local/bare.git")).toBe(true);
    expect(isAllowedGitRemote("file:///tmp/bare.git")).toBe(true);
    expect(isAllowedGitRemote("https://gitlab.com/x/y.git")).toBe(false);
    expect(isAllowedGitRemote("relative/path")).toBe(false);
    expect(isAllowedGitRemote("")).toBe(false);
  });
  it("redactGitUrl strips embedded credentials", () => {
    expect(redactGitUrl("https://ghp_secrettoken@github.com/cinatra-ai/x.git")).toBe(
      "https://***@github.com/cinatra-ai/x.git",
    );
    expect(redactGitUrl("https://github.com/cinatra-ai/x.git")).toBe("https://github.com/cinatra-ai/x.git");
  });

  it("a CREDENTIALED github url normalizes (so the origin check can't be bypassed)", () => {
    // Regression: a credentialed URL used to return null from normalizeGitHubRemote,
    // degrading the origin check to a raw path compare. It must normalize to owner/repo.
    expect(normalizeGitHubRemote("https://ghp_tok@github.com/cinatra-ai/wordpress-plugin.git")).toBe(
      "cinatra-ai/wordpress-plugin",
    );
    expect(normalizeGitHubRemote("ssh://deploy@github.com/cinatra-ai/wordpress-plugin.git")).toBe(
      "cinatra-ai/wordpress-plugin",
    );
  });

  it("a credentialed github url does NOT match a different existing origin (no path-compare bypass)", () => {
    const deps = makeDeps({
      existsPaths: new Set([DEST, path.join(DEST, ".git")]),
      origin: "https://evil.example/x.git", // unrelated non-github origin
      branch: "main",
    });
    expect(() =>
      syncOneRepo({ ...baseArgs, url: "https://ghp_tok@github.com/cinatra-ai/wordpress-plugin.git", deps }),
    ).toThrow(/expected/);
  });

  it("isLocalGitRemote only treats file:// + absolute paths as local", () => {
    expect(isLocalGitRemote("/tmp/x.git")).toBe(true);
    expect(isLocalGitRemote("file:///tmp/x.git")).toBe(true);
    expect(isLocalGitRemote("https://github.com/x/y.git")).toBe(false);
    expect(isLocalGitRemote("relative/x")).toBe(false);
  });
});

describe("normalizeGitHubRemote — HTTPS ↔ SSH equivalence", () => {
  it("treats HTTPS, SSH, and scp-style URLs for the same repo as equal", () => {
    const want = "cinatra-ai/wordpress-plugin";
    expect(normalizeGitHubRemote("https://github.com/cinatra-ai/wordpress-plugin.git")).toBe(want);
    expect(normalizeGitHubRemote("git@github.com:cinatra-ai/wordpress-plugin.git")).toBe(want);
    expect(normalizeGitHubRemote("ssh://git@github.com/cinatra-ai/wordpress-plugin")).toBe(want);
    expect(normalizeGitHubRemote("https://github.com/cinatra-ai/Wordpress-Plugin/")).toBe(want);
  });
  it("returns null for non-GitHub URLs", () => {
    expect(normalizeGitHubRemote("https://gitlab.com/x/y.git")).toBeNull();
    expect(normalizeGitHubRemote("")).toBeNull();
  });
});

describe("envOverrideVarFor", () => {
  it("maps scoped package names to CINATRA_<NAME>_REPO_URL", () => {
    expect(envOverrideVarFor("@cinatra-ai/wordpress-plugin")).toBe("CINATRA_WORDPRESS_PLUGIN_REPO_URL");
    expect(envOverrideVarFor("@cinatra-ai/drupal-module")).toBe("CINATRA_DRUPAL_MODULE_REPO_URL");
  });
});

describe("syncOneRepo — five explicit states", () => {
  it("ABSENT dir → clones", () => {
    const deps = makeDeps({ existsPaths: new Set() });
    const r = syncOneRepo({ ...baseArgs, force: false, deps });
    expect(r.action).toBe("cloned");
    expect(deps.gitNames.some((g) => g.startsWith("clone --branch main --single-branch"))).toBe(true);
  });

  it("EMPTY non-git dir → clones", () => {
    const deps = makeDeps({ existsPaths: new Set([DEST]), dirEntries: { [DEST]: [] } });
    const r = syncOneRepo({ ...baseArgs, force: false, deps });
    expect(r.action).toBe("cloned");
  });

  it("NON-EMPTY non-git dir → fails with remediation", () => {
    const deps = makeDeps({ existsPaths: new Set([DEST]), dirEntries: { [DEST]: ["stray.txt"] } });
    expect(() => syncOneRepo({ ...baseArgs, force: false, deps })).toThrow(/non-empty, non-git/);
  });

  it("WRONG origin → fails, never auto-resets (even with --force)", () => {
    const deps = makeDeps({
      existsPaths: new Set([DEST, path.join(DEST, ".git")]),
      origin: "https://github.com/someone-else/fork.git",
      branch: "main",
    });
    expect(() => syncOneRepo({ ...baseArgs, force: true, deps })).toThrow(/never auto-reset/);
    expect(deps.gitNames).not.toContain("reset --hard origin/main");
  });

  it("WRONG branch → fails", () => {
    const deps = makeDeps({
      existsPaths: new Set([DEST, path.join(DEST, ".git")]),
      origin: URL,
      branch: "feature-x",
    });
    expect(() => syncOneRepo({ ...baseArgs, force: false, deps })).toThrow(/expected/);
  });

  it("CLEAN correct origin+branch → fetch + ff-only (SSH origin still matches)", () => {
    const deps = makeDeps({
      existsPaths: new Set([DEST, path.join(DEST, ".git")]),
      origin: "git@github.com:cinatra-ai/wordpress-plugin.git",
      branch: "main",
      dirty: false,
    });
    const r = syncOneRepo({ ...baseArgs, force: false, deps });
    expect(r.action).toBe("updated");
    expect(deps.gitNames).toContain("fetch origin main");
    expect(deps.gitNames).toContain("merge --ff-only origin/main");
    expect(deps.gitNames.some((g) => g.startsWith("reset --hard"))).toBe(false);
  });

  it("DIRTY without --force → skips, no fetch (never destroys local work)", () => {
    const deps = makeDeps({
      existsPaths: new Set([DEST, path.join(DEST, ".git")]),
      origin: URL,
      branch: "main",
      dirty: true,
    });
    const r = syncOneRepo({ ...baseArgs, force: false, deps });
    expect(r.action).toBe("skipped-dirty");
    expect(deps.gitNames.some((g) => g.startsWith("fetch"))).toBe(false);
    expect(deps.gitNames.some((g) => g.startsWith("stash"))).toBe(false);
  });

  it("DIRTY with --force → stash + fetch + hard-reset", () => {
    const deps = makeDeps({
      existsPaths: new Set([DEST, path.join(DEST, ".git")]),
      origin: URL,
      branch: "main",
      dirty: true,
    });
    const r = syncOneRepo({ ...baseArgs, force: true, deps });
    expect(r.action).toBe("force-reset");
    expect(deps.gitNames.some((g) => g.startsWith("stash push"))).toBe(true);
    expect(deps.gitNames).toContain("fetch origin main");
    expect(deps.gitNames).toContain("reset --hard origin/main");
  });
});
