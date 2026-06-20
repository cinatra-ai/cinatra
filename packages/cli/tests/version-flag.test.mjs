// `cinatra --version` / `-v` reserved for the CLI's own SemVer (cinatra#255
// §6 Q5). Today `--version` falls through to "Unknown command"; this guard pins
// the new behavior: it prints the value of `packages/cli/package.json` `version`
// and exits 0, and is NOT aliased to `--ref` (which selects the app version).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");
const PKG = JSON.parse(
  readFileSync(path.join(HERE, "..", "package.json"), "utf8"),
);

function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("cinatra --version", () => {
  it("prints the CLI package.json version and exits 0", () => {
    const res = runCli(["--version"]);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(PKG.version);
    // Sanity: it is a SemVer-shaped string, not an apiVersion (`cinatra.ai/v1`).
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("`-v` is an alias for `--version`", () => {
    const res = runCli(["-v"]);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(PKG.version);
  });

  it("does not print the help banner for --version", () => {
    const res = runCli(["--version"]);
    expect(res.stdout).not.toContain("Cinatra setup CLI");
    expect(res.stdout).not.toContain("Usage:");
  });

  it("--help still renders the banner (unchanged)", () => {
    const res = runCli(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Cinatra setup CLI");
    expect(res.stdout).toContain("cinatra setup");
  });
});
