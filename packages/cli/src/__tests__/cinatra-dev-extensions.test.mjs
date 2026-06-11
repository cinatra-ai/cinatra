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
  loadDevExtensionPins,
  readDevExtensionsConfig,
  syncCinatraDevExtensions,
  REQUIRED_EXTENSIONS_LOCK_FILENAME,
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

// ---------------------------------------------------------------------------
// Pinned mode (cinatra#141): lock loading + sha plumbing
// ---------------------------------------------------------------------------

describe("loadDevExtensionPins — fail-closed lock partition", () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);
  const REQ_URL = "https://github.com/cinatra-ai/nango-connector.git";
  const DEV_URL = "https://github.com/cinatra-ai/resend-connector.git";

  /** readFile double serving package.json + the two locks from plain objects. */
  const makeReadFile = ({ config, required, dev }) => (p) => {
    if (p.endsWith("cinatra-required-extensions.lock.json")) {
      if (required === undefined) throw new Error("ENOENT");
      return JSON.stringify(required);
    }
    if (p.endsWith("cinatra-dev-extensions.lock.json")) {
      if (dev === undefined) throw new Error("ENOENT");
      return JSON.stringify(dev);
    }
    return JSON.stringify({ cinatraDevExtensions: config });
  };

  const baseConfig = {
    "@cinatra-ai/nango-connector": { url: REQ_URL },
    "@cinatra-ai/resend-connector": { url: DEV_URL },
  };
  const baseRequired = {
    packages: [{ packageName: "@cinatra-ai/nango-connector", repo: "cinatra-ai/nango-connector", resolvedSha: SHA_A }],
  };
  const baseDev = {
    packages: [{ packageName: "@cinatra-ai/resend-connector", repo: "cinatra-ai/resend-connector", resolvedSha: SHA_B }],
  };

  it("merges both locks; each pin remembers its source lock", () => {
    const pins = loadDevExtensionPins("/repo", makeReadFile({ config: baseConfig, required: baseRequired, dev: baseDev }));
    expect(pins.get("@cinatra-ai/nango-connector")).toMatchObject({ sha: SHA_A, source: "cinatra-required-extensions.lock.json" });
    expect(pins.get("@cinatra-ai/resend-connector")).toMatchObject({ sha: SHA_B, source: "cinatra-dev-extensions.lock.json" });
  });

  it("a missing dev lock is a hard error (never degrades to tip-tracking)", () => {
    expect(() =>
      loadDevExtensionPins("/repo", makeReadFile({ config: baseConfig, required: baseRequired, dev: undefined })),
    ).toThrow(/could not be read/);
  });

  it("a package pinned in BOTH locks is refused (single authority for the required set)", () => {
    const dev = { packages: [...baseDev.packages, { packageName: "@cinatra-ai/nango-connector", repo: "cinatra-ai/nango-connector", resolvedSha: SHA_B }] };
    expect(() => loadDevExtensionPins("/repo", makeReadFile({ config: baseConfig, required: baseRequired, dev }))).toThrow(
      /BOTH locks/,
    );
  });

  it("a dev-lock entry that is not a cinatraDevExtensions entry is a stale pin (refused)", () => {
    const dev = { packages: [...baseDev.packages, { packageName: "@cinatra-ai/gone-connector", repo: "cinatra-ai/gone-connector", resolvedSha: SHA_B }] };
    expect(() => loadDevExtensionPins("/repo", makeReadFile({ config: baseConfig, required: baseRequired, dev }))).toThrow(
      /stale pin/,
    );
  });

  it("a config entry with no pin in either lock is refused (fail-closed completeness)", () => {
    const config = { ...baseConfig, "@cinatra-ai/new-connector": { url: "https://github.com/cinatra-ai/new-connector.git" } };
    expect(() => loadDevExtensionPins("/repo", makeReadFile({ config, required: baseRequired, dev: baseDev }))).toThrow(
      /no pin in/,
    );
  });

  it("a lock repo slug contradicting the COMMITTED config URL is refused (retarget without re-pin)", () => {
    const dev = { packages: [{ packageName: "@cinatra-ai/resend-connector", repo: "cinatra-ai/other-repo", resolvedSha: SHA_B }] };
    expect(() => loadDevExtensionPins("/repo", makeReadFile({ config: baseConfig, required: baseRequired, dev }))).toThrow(
      /retargeted/,
    );
  });

  it("a local (file://) config URL skips the slug cross-check (test fixtures)", () => {
    const config = { ...baseConfig, "@cinatra-ai/resend-connector": { url: "file:///tmp/fixture.git" } };
    const pins = loadDevExtensionPins("/repo", makeReadFile({ config, required: baseRequired, dev: baseDev }));
    expect(pins.get("@cinatra-ai/resend-connector").sha).toBe(SHA_B);
  });

  it("a DUPLICATE pin within one lock is refused (the merge must never be order-dependent)", () => {
    const dev = { packages: [...baseDev.packages, { ...baseDev.packages[0], resolvedSha: SHA_A }] };
    expect(() => loadDevExtensionPins("/repo", makeReadFile({ config: baseConfig, required: baseRequired, dev }))).toThrow(
      /duplicate pin/,
    );
  });

  it("a malformed resolvedSha is refused at lock-read time", () => {
    const dev = { packages: [{ packageName: "@cinatra-ai/resend-connector", repo: "cinatra-ai/resend-connector", resolvedSha: "deadbeef" }] };
    expect(() => loadDevExtensionPins("/repo", makeReadFile({ config: baseConfig, required: baseRequired, dev }))).toThrow(
      /40-hex/,
    );
  });

  it("an EMPTY dev lock is legal when the required lock covers the whole universe", () => {
    const config = { "@cinatra-ai/nango-connector": { url: REQ_URL } };
    const pins = loadDevExtensionPins("/repo", makeReadFile({ config, required: baseRequired, dev: { packages: [] } }));
    expect(pins.size).toBe(1);
  });

  it("lock filename constants stay in lockstep with prod acquisition", async () => {
    const prod = await import("../prod-extension-acquisition.mjs");
    expect(REQUIRED_EXTENSIONS_LOCK_FILENAME).toBe(prod.LOCK_FILENAME);
  });
});

describe("syncCinatraDevExtensions --pinned — sha plumbing + override semantics", () => {
  const SHA_B = "b".repeat(40);
  const DEV_URL = "https://github.com/cinatra-ai/resend-connector.git";
  const config = { "@cinatra-ai/resend-connector": { url: DEV_URL } };
  const required = {
    packages: [{ packageName: "@cinatra-ai/anthropic-connector", repo: "cinatra-ai/anthropic-connector", resolvedSha: "a".repeat(40) }],
  };
  const dev = {
    packages: [{ packageName: "@cinatra-ai/resend-connector", repo: "cinatra-ai/resend-connector", resolvedSha: SHA_B }],
  };
  // Required-lock packages need not be cinatraDevExtensions entries (prod-only
  // packages are simply not cloned back), so `required` above referencing a
  // package outside `config` must be accepted.
  const makeDeps = (gitCalls) => ({
    readFile: (p) => {
      if (p.endsWith("cinatra-required-extensions.lock.json")) return JSON.stringify(required);
      if (p.endsWith("cinatra-dev-extensions.lock.json")) return JSON.stringify(dev);
      return JSON.stringify({ cinatraDevExtensions: config });
    },
    exists: () => false, // absent slot → clone path
    readdir: () => [],
    mkdirp: () => {},
    git: (args) => {
      gitCalls.push(args.join(" "));
      if (args.join(" ") === "rev-parse HEAD") return SHA_B;
      if (args[0] === "cat-file") return ""; // commit present after clone
      return "";
    },
  });

  it("--pinned clones then detaches at the dev-lock sha", async () => {
    const gitCalls = [];
    const r = await syncCinatraDevExtensions({
      repoRoot: "/repo",
      targetRoot: "/repo",
      argv: ["--pinned"],
      env: {},
      log: () => {},
      deps: makeDeps(gitCalls),
    });
    expect(r.results[0]).toMatchObject({ action: "cloned", pinnedSha: SHA_B });
    expect(gitCalls).toContain(`checkout --detach ${SHA_B}`);
  });

  it("a CINATRA_*_REPO_URL override is only an ALTERNATE REMOTE — the pin still applies", async () => {
    const gitCalls = [];
    const override = "https://github.com/somefork/resend-connector.git";
    const r = await syncCinatraDevExtensions({
      repoRoot: "/repo",
      targetRoot: "/repo",
      argv: ["--pinned"],
      env: { CINATRA_RESEND_CONNECTOR_REPO_URL: override },
      log: () => {},
      deps: makeDeps(gitCalls),
    });
    // clone goes to the override remote, but the checkout is still the pin —
    // and the lock-vs-config slug check used the COMMITTED url, not the override.
    expect(gitCalls.some((g) => g.startsWith("clone") && g.includes(override))).toBe(true);
    expect(gitCalls).toContain(`checkout --detach ${SHA_B}`);
    expect(r.results[0].pinnedSha).toBe(SHA_B);
  });

  it("--pinned + --force are mutually exclusive", async () => {
    await expect(
      syncCinatraDevExtensions({
        repoRoot: "/repo",
        targetRoot: "/repo",
        argv: ["--pinned", "--force"],
        env: {},
        log: () => {},
        deps: makeDeps([]),
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("without --pinned the lock files are not even read (tip-tracking unchanged)", async () => {
    const lockReads = [];
    const gitCalls = [];
    const deps = makeDeps(gitCalls);
    const innerRead = deps.readFile;
    deps.readFile = (p) => {
      if (p.includes(".lock.json")) lockReads.push(p);
      return innerRead(p);
    };
    const r = await syncCinatraDevExtensions({ repoRoot: "/repo", targetRoot: "/repo", argv: [], env: {}, log: () => {}, deps });
    expect(r.results[0].action).toBe("cloned");
    expect(lockReads).toEqual([]);
    expect(gitCalls.some((g) => g.startsWith("checkout --detach"))).toBe(false);
  });
});
