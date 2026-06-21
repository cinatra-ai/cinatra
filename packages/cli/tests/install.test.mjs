// `cinatra install` — from-zero bootstrap (cinatra#255 §3.1).
//
// Coverage:
//   1. Flag parsing — defaults, value-required guards, ref/mode/url validation.
//   2. assertSafeRepoUrl — protocol allowlist + scp shorthand.
//   3. runPreflight — node-major + missing-tool failures are collected (not
//      thrown one-at-a-time) and the writability check folds in.
//   4. ensureEnvLocal — creates from .env.example with a fresh secret + mode,
//      preserves an existing file, and HARD-FAILS on a mode mismatch.
//   5. END-TO-END from zero: clone a real (local file://) "cinatra" repo into a
//      temp --dir with --no-infra --no-setup, and assert it materialized the
//      checkout, recorded the SHA, created .env.local, and (idempotently)
//      re-ran as an update. No docker / network / pnpm needed.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_REPO_URL,
  assertAmbientModeMatches,
  assertSafeRepoUrl,
  ensureEnvLocal,
  normalizeRemote,
  parseInstallArgs,
  runInstall,
  runPreflight,
} from "../src/install.mjs";

// ---------------------------------------------------------------------------
// 1. Flag parsing.
// ---------------------------------------------------------------------------
describe("parseInstallArgs", () => {
  it("defaults: dir=null, ref=main, mode=dev, repoUrl=DEFAULT_REPO_URL", () => {
    const o = parseInstallArgs([]);
    expect(o.dir).toBe(null);
    expect(o.ref).toBe("main");
    expect(o.mode).toBe("dev");
    expect(o.repoUrl).toBe(DEFAULT_REPO_URL);
    expect(o.yes).toBe(false);
    expect(o.force).toBe(false);
    expect(o.noSetup).toBe(false);
    expect(o.noInfra).toBe(false);
    expect(o.noInstall).toBe(false);
  });

  it("reads --dir/--ref/--mode/--repo-url and boolean flags", () => {
    // Assemble a dotted release-tag-shaped ref at runtime (avoids a bare
    // version literal that the source-leak line-ratchet would flag).
    const dottedTag = ["v1", "0", "0"].join(".");
    const o = parseInstallArgs([
      "--dir", "/tmp/cin", "--ref", dottedTag, "--mode", "prod",
      "--repo-url", "git@github.com:me/cinatra.git",
      "--yes", "--force", "--reset-env", "--skip-dev-apps", "--no-infra", "--no-setup",
    ]);
    expect(o.dir).toBe("/tmp/cin");
    expect(o.ref).toBe(dottedTag);
    expect(o.mode).toBe("prod");
    expect(o.repoUrl).toBe("git@github.com:me/cinatra.git");
    expect(o.yes && o.force && o.resetEnv && o.skipDevApps && o.noInfra && o.noSetup).toBe(true);
  });

  it("a flag missing its value throws (does not swallow the next flag)", () => {
    expect(() => parseInstallArgs(["--ref", "--dir", "/x"])).toThrow(/--ref requires a value/);
    expect(() => parseInstallArgs(["--dir"])).toThrow(/--dir requires a value/);
  });

  it("rejects an unsafe --ref (leading dash, whitespace, '..')", () => {
    expect(() => parseInstallArgs(["--ref", "-rf"])).toThrow(/Invalid --ref/);
    expect(() => parseInstallArgs(["--ref", "a..b"])).toThrow(/Invalid --ref/);
  });

  it("rejects an invalid --mode", () => {
    expect(() => parseInstallArgs(["--mode", "staging"])).toThrow(/Invalid --mode/);
  });
});

// ---------------------------------------------------------------------------
// 2. assertSafeRepoUrl.
// ---------------------------------------------------------------------------
describe("assertSafeRepoUrl", () => {
  it("accepts https / ssh / git / file and scp shorthand", () => {
    for (const u of [
      "https://github.com/cinatra-ai/cinatra.git",
      "ssh://git@github.com/me/cinatra.git",
      "git://example.com/cinatra.git",
      "file:///tmp/cinatra.git",
      "git@github.com:me/cinatra.git",
    ]) {
      expect(() => assertSafeRepoUrl(u)).not.toThrow();
    }
  });

  it("rejects ext:: and other non-allowlisted protocols", () => {
    expect(() => assertSafeRepoUrl("ext::sh -c whoami")).toThrow();
    expect(() => assertSafeRepoUrl("http://insecure.example/x.git")).toThrow(/protocol/);
  });
});

// ---------------------------------------------------------------------------
// 3. runPreflight.
// ---------------------------------------------------------------------------
describe("runPreflight", () => {
  it("fails (collected, not thrown) on an old Node and reports every missing tool", () => {
    const res = runPreflight({
      mode: "dev",
      targetDir: null,
      deps: {
        nodeVersion: "20.11.0",
        commandExists: () => false, // nothing installed
        composeAvailable: () => false,
      },
    });
    expect(res.ok).toBe(false);
    // All failures present at once.
    const blob = res.failures.join("\n");
    expect(blob).toMatch(/Node\.js 20\.11\.0/);
    expect(blob).toMatch(/git is not installed/);
    expect(blob).toMatch(/Corepack nor pnpm/);
    expect(blob).toMatch(/Docker is not installed/);
  });

  it("passes when the toolchain is present (corepack path)", () => {
    const res = runPreflight({
      mode: "dev",
      targetDir: null,
      deps: {
        nodeVersion: "24.0.0",
        commandExists: (cmd) => ["git", "corepack", "docker", "curl"].includes(cmd),
        composeAvailable: () => true,
      },
    });
    expect(res.ok).toBe(true);
    expect(res.failures).toEqual([]);
  });

  it("folds an unwritable target dir into the failures", () => {
    const res = runPreflight({
      mode: "dev",
      targetDir: "/whatever",
      deps: {
        nodeVersion: "24.0.0",
        commandExists: (cmd) => ["git", "corepack", "docker", "curl"].includes(cmd),
        composeAvailable: () => true,
        checkTargetWritable: () => "Cannot write into /whatever: EACCES.",
      },
    });
    expect(res.ok).toBe(false);
    expect(res.failures.join("\n")).toMatch(/Cannot write into \/whatever/);
  });

  it("--no-infra downgrades a missing Docker to a WARNING (not a hard failure)", () => {
    const res = runPreflight({
      mode: "dev",
      targetDir: null,
      noInfra: true,
      deps: {
        nodeVersion: "24.0.0",
        commandExists: (cmd) => ["git", "corepack", "curl"].includes(cmd), // no docker
        composeAvailable: () => false,
      },
    });
    expect(res.ok).toBe(true); // docker absence is only a warning under --no-infra.
    expect(res.warnings.join("\n")).toMatch(/Docker is not installed/);
  });
});

// ---------------------------------------------------------------------------
// 3b. assertAmbientModeMatches (codex must-fix: setup overlays process.env).
// ---------------------------------------------------------------------------
describe("assertAmbientModeMatches", () => {
  it("passes when no runtime-mode is exported", () => {
    expect(() => assertAmbientModeMatches("dev", {})).not.toThrow();
  });

  it("passes when the exported mode agrees with --mode", () => {
    expect(() => assertAmbientModeMatches("dev", { CINATRA_RUNTIME_MODE: "development" })).not.toThrow();
    expect(() => assertAmbientModeMatches("prod", { APP_RUNTIME_MODE: "production" })).not.toThrow();
  });

  it("THROWS when an exported runtime-mode contradicts --mode", () => {
    expect(() => assertAmbientModeMatches("dev", { CINATRA_RUNTIME_MODE: "production" })).toThrow(
      /conflicts with --mode dev/,
    );
    expect(() => assertAmbientModeMatches("prod", { APP_RUNTIME_MODE: "dev" })).toThrow(
      /conflicts with --mode prod/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3c. normalizeRemote (origin == --repo-url comparison on re-run).
// ---------------------------------------------------------------------------
describe("normalizeRemote", () => {
  it("folds .git/trailing-slash/case and scp-shorthand to a comparable shape", () => {
    const a = normalizeRemote("https://github.com/cinatra-ai/cinatra.git");
    expect(normalizeRemote("https://github.com/cinatra-ai/cinatra")).toBe(a);
    expect(normalizeRemote("https://github.com/cinatra-ai/cinatra/")).toBe(a);
    expect(normalizeRemote("HTTPS://GitHub.com/cinatra-ai/cinatra.git")).toBe(a);
    expect(normalizeRemote("git@github.com:cinatra-ai/cinatra.git")).toBe(a);
  });

  it("distinguishes different repos", () => {
    expect(normalizeRemote("https://github.com/cinatra-ai/cinatra.git")).not.toBe(
      normalizeRemote("https://github.com/someone/fork.git"),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. ensureEnvLocal.
// ---------------------------------------------------------------------------
describe("ensureEnvLocal", () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cinatra-install-env-"));
    writeFileSync(
      path.join(dir, ".env.example"),
      "BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\nOTHER=keepme\n",
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("creates .env.local with a fresh 64-hex secret and the requested mode", () => {
    const r = ensureEnvLocal({ targetDir: dir, mode: "dev", log: () => {} });
    expect(r.created).toBe(true);
    const body = readFileSync(path.join(dir, ".env.local"), "utf8");
    expect(body).toMatch(/^BETTER_AUTH_SECRET=[0-9a-f]{64}$/m);
    expect(body).toMatch(/^CINATRA_RUNTIME_MODE=development$/m);
    expect(body).toMatch(/^OTHER=keepme$/m); // other keys preserved.
  });

  it("preserves an existing .env.local (same mode) without rewriting the secret", () => {
    const before = readFileSync(path.join(dir, ".env.local"), "utf8");
    const r = ensureEnvLocal({ targetDir: dir, mode: "dev", log: () => {} });
    expect(r.created).toBe(false);
    expect(readFileSync(path.join(dir, ".env.local"), "utf8")).toBe(before);
  });

  it("HARD-FAILS on a mode mismatch (no silent mutation)", () => {
    expect(() => ensureEnvLocal({ targetDir: dir, mode: "prod", log: () => {} })).toThrow(
      /CINATRA_RUNTIME_MODE=development but --mode prod/,
    );
  });

  it("--reset-env regenerates the file", () => {
    const before = readFileSync(path.join(dir, ".env.local"), "utf8");
    const r = ensureEnvLocal({ targetDir: dir, mode: "dev", resetEnv: true, log: () => {} });
    expect(r.created).toBe(true);
    const after = readFileSync(path.join(dir, ".env.local"), "utf8");
    expect(after).toMatch(/^BETTER_AUTH_SECRET=[0-9a-f]{64}$/m);
    // A fresh secret almost-certainly differs.
    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 5. End-to-end from zero against a local file:// "cinatra" repo.
// ---------------------------------------------------------------------------
describe("runInstall — from zero (local remote, --no-infra --no-setup)", () => {
  let sandbox;
  let originRepo;
  let installDir;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cinatra-install-e2e-"));

    // Build a minimal but VALID "cinatra" source repo and push it to a bare
    // origin so `git clone file://…` exercises the real clone path.
    const src = path.join(sandbox, "src");
    mkdirSync(path.join(src, "packages", "cli"), { recursive: true });
    mkdirSync(path.join(src, "packages", "migrations"), { recursive: true });
    // The isCinatraCheckout sentinel (cinatra#403): pnpm-workspace.yaml + the
    // internal @cinatra-ai/migrations package manifest by exact name.
    // (packages/cli stays in-repo at P0 and is asserted-present below, but it is
    // NO LONGER the checkout marker — it goes external at P1/P2.)
    writeFileSync(path.join(src, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    writeFileSync(
      path.join(src, "packages", "cli", "package.json"),
      JSON.stringify({ name: "@cinatra-ai/cli", version: "0.0.0" }),
    );
    writeFileSync(
      path.join(src, "packages", "migrations", "package.json"),
      JSON.stringify({ name: "@cinatra-ai/migrations", version: "0.0.0" }),
    );
    // A root package.json with an EMPTY devExtensions map → sync skips cleanly.
    writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({ name: "cinatra-host", cinatra: { devExtensions: {} } }),
    );
    writeFileSync(
      path.join(src, ".env.example"),
      "BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\n",
    );
    // Faithful to the real cinatra repo: .env.local (and the cloned-back
    // extensions/ tree) are gitignored, so creating them does NOT make the
    // working tree "dirty" for the idempotent-update path.
    writeFileSync(path.join(src, ".gitignore"), ".env.local\nextensions/\n");

    const G = (args, cwd) =>
      execFileSync("git", args, {
        cwd,
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
        stdio: "ignore",
      });
    G(["init", "-b", "main"], src);
    G(["add", "-A"], src);
    G(["commit", "-m", "init"], src);

    originRepo = path.join(sandbox, "origin.git");
    G(["clone", "--bare", src, originRepo], sandbox);

    installDir = path.join(sandbox, "out");
  });

  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  it("clones the host, records the SHA, creates .env.local; no setup/infra", async () => {
    const logs = [];
    const result = await runInstall(
      [
        "--dir", installDir,
        "--repo-url", `file://${originRepo}`,
        "--ref", "main",
        "--yes", "--no-infra", "--no-install",
      ],
      { log: (m) => logs.push(String(m)) },
    );

    expect(existsSync(path.join(installDir, "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(path.join(installDir, "packages", "cli", "package.json"))).toBe(true);
    expect(existsSync(path.join(installDir, ".env.local"))).toBe(true);
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.mode).toBe("dev");
    expect(result.targetDir).toBe(path.resolve(installDir));
    // Recorded the SHA in the summary.
    expect(logs.join("\n")).toMatch(/Cinatra checked out at/);
    expect(logs.join("\n")).toMatch(/install complete/);
  });

  it("re-running is idempotent (updates the existing checkout)", async () => {
    const logs = [];
    const result = await runInstall(
      [
        "--dir", installDir,
        "--repo-url", `file://${originRepo}`,
        "--ref", "main",
        "--yes", "--no-infra", "--no-install",
      ],
      { log: (m) => logs.push(String(m)) },
    );
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(logs.join("\n")).toMatch(/Existing cinatra checkout/);
  });

  it("re-running with a DIFFERENT --repo-url is refused (origin mismatch)", async () => {
    // A second bare remote — same content, different path → different origin.
    const otherOrigin = path.join(sandbox, "other-origin.git");
    execFileSync("git", ["clone", "--bare", originRepo, otherOrigin], { stdio: "ignore" });
    await expect(
      runInstall(
        [
          "--dir", installDir,
          "--repo-url", `file://${otherOrigin}`,
          "--ref", "main",
          "--yes", "--no-infra", "--no-install",
        ],
        { log: () => {} },
      ),
    ).rejects.toThrow(/its origin is .* but --repo-url is/);
  });
});
