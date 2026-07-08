// Deploy-compat forwarder (bin/cinatra.mjs) — image-mode schema bootstrap
// ordering (cinatra#1136, prod-deploy surface).
//
// The prod deploy runs `node packages/cli/bin/cinatra.mjs [instance ]setup prod`
// inside the NEW release image BEFORE that image ever boots, so the versioned
// core migration chain would otherwise execute against the PREVIOUS release's
// schema without the bootstrap baseline it assumes (observed on a release
// deploy: core migration `LOCK TABLE nango_connection` → relation does not
// exist → deploy aborts). The forwarder therefore applies the image's baked
// schema-bootstrap bundle FIRST for schema-mutating subcommands, fail-closed.
//
// These tests spawn the REAL forwarder file against a fake published CLI and a
// fake bundle in a temp checkout layout, asserting:
//   1. bundle runs BEFORE the published CLI for `setup prod` (and the
//      namespaced `instance setup prod` / `db migrate` forms);
//   2. a failing bundle aborts with its exit code and the CLI never runs;
//   3. non-schema commands (`--help`) and runs without SUPABASE_DB_URL skip
//      the bundle and forward unchanged;
//   4. a checkout without the bundle forwards unchanged (dev checkouts,
//      images predating the bundle).
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const FORWARDER_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../bin/cinatra.mjs",
);

const tmpDirs = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Build a minimal fake checkout: the real forwarder at packages/cli/bin, a
 * fake published CLI recording its invocation, and (optionally) a fake
 * schema-bootstrap bundle recording its invocation with a controllable exit
 * code. Both fakes append to the same journal file so ORDER is observable.
 */
function makeCheckout({ withBundle = true, bundleExitCode = 0 } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cinatra-forwarder-test-"));
  tmpDirs.push(root);
  const journal = path.join(root, "journal.log");

  mkdirSync(path.join(root, "packages", "cli", "bin"), { recursive: true });
  copyFileSync(FORWARDER_SOURCE, path.join(root, "packages", "cli", "bin", "cinatra.mjs"));

  mkdirSync(path.join(root, "node_modules", "@cinatra-ai", "cinatra", "bin"), { recursive: true });
  writeFileSync(
    path.join(root, "node_modules", "@cinatra-ai", "cinatra", "bin", "cinatra.mjs"),
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(journal)}, "cli " + process.argv.slice(2).join(" ") + "\\n");`,
      "process.exit(0);",
    ].join("\n"),
  );

  if (withBundle) {
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts", "schema-bootstrap.bundle.mjs"),
      [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(journal)}, "bundle db=" + (process.env.SUPABASE_DB_URL || "") + "\\n");`,
        `process.exit(${bundleExitCode});`,
      ].join("\n"),
    );
  }

  return { root, journal };
}

function runForwarder(root, args, env = {}) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [path.join(root, "packages", "cli", "bin", "cinatra.mjs"), ...args],
      { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function journalLines(journal) {
  return existsSync(journal) ? readFileSync(journal, "utf8").trim().split("\n") : [];
}

describe("deploy-compat forwarder: image-mode schema bootstrap", () => {
  it("runs the baked bundle BEFORE the published CLI for `setup prod`", () => {
    const { root, journal } = makeCheckout();
    const res = runForwarder(root, ["setup", "prod"], { SUPABASE_DB_URL: "postgres://x/y" });
    expect(res.status).toBe(0);
    expect(journalLines(journal)).toEqual(["bundle db=postgres://x/y", "cli setup prod"]);
  });

  it("covers the namespaced `instance setup prod` and `instance db migrate` forms", () => {
    for (const args of [
      ["instance", "setup", "prod"],
      ["instance", "db", "migrate"],
      ["db", "migrate"],
    ]) {
      const { root, journal } = makeCheckout();
      const res = runForwarder(root, args, { SUPABASE_DB_URL: "postgres://x/y" });
      expect(res.status).toBe(0);
      expect(journalLines(journal)).toEqual(["bundle db=postgres://x/y", `cli ${args.join(" ")}`]);
    }
  });

  it("fail-closed: a failing bundle aborts with its exit code and never reaches the CLI", () => {
    const { root, journal } = makeCheckout({ bundleExitCode: 1 });
    const res = runForwarder(root, ["instance", "setup", "prod"], {
      SUPABASE_DB_URL: "postgres://x/y",
    });
    expect(res.status).toBe(1);
    expect(journalLines(journal)).toEqual(["bundle db=postgres://x/y"]);
    expect(res.stderr).toContain("schema bootstrap DDL failed");
  });

  it("skips the bundle for non-schema commands (probe/--help stays side-effect-free)", () => {
    for (const args of [["--help"], ["instance", "--help"]]) {
      const { root, journal } = makeCheckout();
      const res = runForwarder(root, args, { SUPABASE_DB_URL: "postgres://x/y" });
      expect(res.status).toBe(0);
      expect(journalLines(journal)).toEqual([`cli ${args.join(" ")}`]);
    }
  });

  it("skips the bundle for rollbacks, other db subcommands, and non-prod setup forms (narrow matching)", () => {
    for (const args of [
      ["db", "migrate", "--down"],
      ["instance", "db", "migrate", "--down"],
      ["db", "status"],
      ["setup", "dev"],
      ["instance", "setup", "nango"],
      ["setup", "--help"],
    ]) {
      const { root, journal } = makeCheckout();
      const res = runForwarder(root, args, { SUPABASE_DB_URL: "postgres://x/y" });
      expect(res.status).toBe(0);
      expect(journalLines(journal)).toEqual([`cli ${args.join(" ")}`]);
    }
  });

  it("skips the bundle when SUPABASE_DB_URL is unset (the CLI reports its own canonical error)", () => {
    const { root, journal } = makeCheckout();
    const env = { ...process.env, SUPABASE_DB_URL: undefined };
    delete env.SUPABASE_DB_URL;
    const res = (() => {
      try {
        const stdout = execFileSync(
          process.execPath,
          [path.join(root, "packages", "cli", "bin", "cinatra.mjs"), "setup", "prod"],
          { cwd: root, env, encoding: "utf8" },
        );
        return { status: 0, stdout };
      } catch (err) {
        return { status: err.status, stdout: err.stdout ?? "" };
      }
    })();
    expect(res.status).toBe(0);
    expect(journalLines(journal)).toEqual(["cli setup prod"]);
  });

  it("forwards unchanged when no bundle is present (dev checkouts / older images)", () => {
    const { root, journal } = makeCheckout({ withBundle: false });
    const res = runForwarder(root, ["setup", "prod"], { SUPABASE_DB_URL: "postgres://x/y" });
    expect(res.status).toBe(0);
    expect(journalLines(journal)).toEqual(["cli setup prod"]);
  });
});
