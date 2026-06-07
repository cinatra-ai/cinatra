import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { describe, expect, it, afterAll } from "vitest";

import {
  deriveKindFromName,
  destDirForExtension,
  parseDevExtensionFlags,
  selectEntries,
  extensionEnvOverrideVarFor,
  readDevExtensionsConfig,
  syncCinatraDevExtensions,
} from "../cinatra-dev-extensions.mjs";

describe("deriveKindFromName", () => {
  it("derives kind from the package-name suffix (no clone needed)", () => {
    expect(deriveKindFromName("@cinatra-ai/email-outreach-agent")).toBe("agent");
    expect(deriveKindFromName("@cinatra-ai/resend-connector")).toBe("connector");
    expect(deriveKindFromName("@cinatra-ai/default-artifact")).toBe("artifact");
    expect(deriveKindFromName("@cinatra-ai/assistant-skills")).toBe("skill");
    expect(deriveKindFromName("@cinatra-ai/blog-content-workflow")).toBe("workflow");
    expect(deriveKindFromName("@example-vendor/blog-connector")).toBe("connector");
  });
  it("honors a declared kind over the suffix; null when unknown", () => {
    expect(deriveKindFromName("@cinatra-ai/weird", "agent")).toBe("agent");
    expect(deriveKindFromName("@cinatra-ai/weird")).toBe(null);
  });
});

describe("destDirForExtension", () => {
  it("maps @scope/name → <root>/extensions/<scope>/<name>", () => {
    expect(destDirForExtension("@cinatra-ai/resend-connector", {}, "/repo")).toBe(
      path.resolve("/repo/extensions/cinatra-ai/resend-connector"),
    );
    expect(destDirForExtension("@example-vendor/blog-connector", {}, "/repo")).toBe(
      path.resolve("/repo/extensions/example-vendor/blog-connector"),
    );
  });
  it("honors an explicit spec.path", () => {
    expect(destDirForExtension("@x/y", { path: "custom/loc" }, "/repo")).toBe(
      path.resolve("/repo/custom/loc"),
    );
  });

  // Path-traversal containment (security): a malicious config key / spec.path
  // must never resolve outside the repo (spec.path) or extensions/ (derived).
  it("throws on a path-traversal package key", () => {
    expect(() => destDirForExtension("@cinatra-ai/../../outside", {}, "/repo")).toThrow(/invalid extension package name/);
  });
  it("throws on a name segment containing a slash", () => {
    expect(() => destDirForExtension("@cinatra-ai/a/b", {}, "/repo")).toThrow(/invalid extension package name/);
  });
  it("throws on an absolute spec.path that escapes the repo", () => {
    expect(() => destDirForExtension("@x/y", { path: "/etc/passwd" }, "/repo")).toThrow(/outside the repo root/);
  });
  it("throws on a ../ spec.path that escapes the repo", () => {
    expect(() => destDirForExtension("@x/y", { path: "../../escape" }, "/repo")).toThrow(/outside the repo root/);
  });
});

describe("extensionEnvOverrideVarFor", () => {
  it("maps to CINATRA_<NAME>_REPO_URL", () => {
    expect(extensionEnvOverrideVarFor("@cinatra-ai/resend-connector")).toBe("CINATRA_RESEND_CONNECTOR_REPO_URL");
  });
});

describe("parseDevExtensionFlags + selectEntries", () => {
  const config = {
    "@cinatra-ai/resend-connector": { url: "u1" },
    "@cinatra-ai/email-outreach-agent": { url: "u2" },
    "@cinatra-ai/default-artifact": { url: "u3" },
  };
  it("--kind filters by derived kind", () => {
    const flags = parseDevExtensionFlags(["--kind", "connector,artifact"]);
    const sel = selectEntries(config, flags).map((e) => e.pkgName);
    expect(sel.sort()).toEqual(["@cinatra-ai/default-artifact", "@cinatra-ai/resend-connector"]);
  });
  it("--select matches full OR short name", () => {
    const flags = parseDevExtensionFlags(["--select", "resend-connector"]);
    expect(selectEntries(config, flags).map((e) => e.pkgName)).toEqual(["@cinatra-ai/resend-connector"]);
  });
  it("--exclude drops matches", () => {
    const flags = parseDevExtensionFlags(["--exclude", "@cinatra-ai/email-outreach-agent"]);
    const sel = selectEntries(config, flags).map((e) => e.pkgName);
    expect(sel).not.toContain("@cinatra-ai/email-outreach-agent");
    expect(sel).toHaveLength(2);
  });
  it("--jobs parses to a positive int (default 1)", () => {
    expect(parseDevExtensionFlags(["--jobs", "4"]).jobs).toBe(4);
    expect(parseDevExtensionFlags([]).jobs).toBe(1);
    expect(parseDevExtensionFlags(["--jobs", "0"]).jobs).toBe(1);
  });
});

describe("readDevExtensionsConfig", () => {
  it("returns null for an empty cinatra.devExtensions (the inert default)", () => {
    const readFile = () => JSON.stringify({ cinatra: { devExtensions: {} } });
    expect(readDevExtensionsConfig("/repo", readFile)).toEqual({});
    // syncCinatraDevExtensions then no-ops:
  });
  it("no-ops (skipped:no-config) when devExtensions is empty", async () => {
    const readFile = () => JSON.stringify({ cinatra: { devExtensions: {} } });
    const r = await syncCinatraDevExtensions({ repoRoot: "/repo", targetRoot: "/repo", deps: { readFile } });
    expect(r).toEqual({ skipped: true, reason: "no-config" });
  });
});

describe("dirty-tree remediation points at the extension force flag", () => {
  it("a dirty extension checkout is told to use --force (not --force-dev-apps)", async () => {
    const dest = path.resolve("/repo/extensions/cinatra-ai/resend-connector");
    const logs = [];
    const deps = {
      readFile: () =>
        JSON.stringify({ cinatraDevExtensions: { "@cinatra-ai/resend-connector": { url: "https://github.com/cinatra-ai/resend-connector.git", branch: "main" } } }),
      exists: (p) => p === dest || p === path.join(dest, ".git"),
      readdir: () => ["x"],
      mkdirp: () => {},
      git: (args) => {
        const j = args.join(" ");
        if (j === "remote get-url origin") return "https://github.com/cinatra-ai/resend-connector.git";
        if (j === "rev-parse --abbrev-ref HEAD") return "main";
        if (j === "status --porcelain") return " M file\n"; // dirty
        return "";
      },
    };
    const r = await syncCinatraDevExtensions({ repoRoot: "/repo", targetRoot: "/repo", argv: [], env: {}, log: (m) => logs.push(m), deps });
    expect(r.results[0].action).toBe("skipped-dirty");
    const joined = logs.join("\n");
    expect(joined).toContain("--force");
    expect(joined).not.toContain("--force-dev-apps");
  });
});

describe("partial deps injection merges with defaultRepoSyncDeps (regression)", () => {
  it("injecting readFile (NO exists/mkdirp/readdir) still works — fills git ops from defaults", async () => {
    // Regression for a bug where `deps ?? defaultRepoSyncDeps()`
    // used the partial `deps` verbatim, so `syncOneRepo` threw
    // `deps.exists is not a function`. Here we inject ONLY `readFile` + a fake
    // `git` and OMIT exists/mkdirp/readdir. The clone path needs `exists`
    // (→ default real-fs, false on a fresh tmp path → clone) + `mkdirp`; the new
    // merge fills them from defaultRepoSyncDeps, so this passes — the old code would throw.
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "cinatra-merge-"));
    const gitCalls = [];
    const deps = {
      readFile: () =>
        JSON.stringify({ cinatraDevExtensions: { "@cinatra-ai/resend-connector": { url: "/nonexistent/repo.git", branch: "main" } } }),
      git: (args) => {
        gitCalls.push(args.join(" "));
        return "";
      },
    };
    try {
      const r = await syncCinatraDevExtensions({ repoRoot: tmpRoot, targetRoot: tmpRoot, argv: [], env: {}, deps, log: () => {} });
      expect(r.results[0].action).toBe("cloned");
      expect(gitCalls.some((g) => g.startsWith("clone --branch main"))).toBe(true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// One REAL git integration (mocks for the matrix + one real clone/pull).
describe("syncCinatraDevExtensions — real bare-git clone + ff-only pull", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cinatra-devext-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  it("clones an absent slot then fast-forwards on a second run", () => {
    // 1) build an upstream repo + a bare origin
    const upstream = path.join(tmp, "upstream");
    mkdirSync(upstream, { recursive: true });
    git(["init", "-q", "-b", "main"], upstream);
    git(["config", "user.email", "t@t"], upstream);
    git(["config", "user.name", "t"], upstream);
    writeFileSync(path.join(upstream, "package.json"), JSON.stringify({ name: "@cinatra-ai/resend-connector" }));
    git(["add", "-A"], upstream);
    git(["commit", "-q", "-m", "v0.1.0"], upstream);
    const bare = path.join(tmp, "origin.git");
    git(["clone", "-q", "--bare", upstream, bare], tmp);
    // point upstream at the bare so later commits can be pushed to it
    git(["remote", "add", "origin", bare], upstream);

    // 2) repoRoot carries the config; targetRoot is where slots materialize
    const repoRoot = path.join(tmp, "repo");
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ cinatra: { devExtensions: { "@cinatra-ai/resend-connector": { url: bare, branch: "main" } } } }),
    );

    const dest = path.join(repoRoot, "extensions/cinatra-ai/resend-connector");

    // first run → clone
    const logs = [];
    return syncCinatraDevExtensions({ repoRoot, targetRoot: repoRoot, argv: [], env: {}, log: (m) => logs.push(m) }).then((r1) => {
      expect(r1.results[0].action).toBe("cloned");
      expect(existsSync(path.join(dest, "package.json"))).toBe(true);

      // advance upstream → push to bare
      writeFileSync(path.join(upstream, "NEW.txt"), "x");
      git(["add", "-A"], upstream);
      git(["commit", "-q", "-m", "second"], upstream);
      git(["push", "-q", "origin", "main"], upstream);

      // second run on a clean checkout → ff-only update
      return syncCinatraDevExtensions({ repoRoot, targetRoot: repoRoot, argv: [], env: {}, log: () => {} }).then((r2) => {
        expect(r2.results[0].action).toBe("updated"); // ff-only pull, not a re-clone
        expect(existsSync(path.join(dest, "NEW.txt"))).toBe(true);
      });
    });
  });
});
