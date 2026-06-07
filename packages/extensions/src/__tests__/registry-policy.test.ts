// Registry temp-policy reader contract.
//
// readRegistryPolicy() declares — via config — whether the resolved registry
// is operating under a TEMPORARY policy. The default MUST be off (no banner
// ships by default); it only turns on when explicitly configured via the root
// package.json `cinatraRegistryPolicy` key or the env override.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readRegistryPolicy } from "../registry-policy";

// Write a throwaway package.json with the given top-level keys and return its path.
function writeFixturePackageJson(contents: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-policy-"));
  const file = path.join(dir, "package.json");
  fs.writeFileSync(file, JSON.stringify(contents, null, 2), "utf8");
  return file;
}

describe("readRegistryPolicy", () => {
  const ENV_KEYS = [
    "CINATRA_REGISTRY_POLICY_TEMPORARY",
    "CINATRA_REGISTRY_POLICY_NOTICE",
  ];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Isolate from any ambient env overrides so the file path drives the result.
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("defaults to NOT temporary when the config key is absent", () => {
    const file = writeFixturePackageJson({ name: "fixture" });
    const policy = readRegistryPolicy(file);
    expect(policy.temporary).toBe(false);
    expect(policy.notice.length).toBeGreaterThan(0);
  });

  it("defaults to NOT temporary when configured temporary:false", () => {
    const file = writeFixturePackageJson({
      cinatraRegistryPolicy: { temporary: false, notice: "ignored when off" },
    });
    expect(readRegistryPolicy(file).temporary).toBe(false);
  });

  it("reports temporary with the configured notice when temporary:true", () => {
    const file = writeFixturePackageJson({
      cinatraRegistryPolicy: {
        temporary: true,
        notice: "Private packages may be deleted without notice.",
      },
    });
    const policy = readRegistryPolicy(file);
    expect(policy.temporary).toBe(true);
    expect(policy.notice).toBe("Private packages may be deleted without notice.");
  });

  it("falls back to the default notice when temporary:true but notice missing", () => {
    const file = writeFixturePackageJson({
      cinatraRegistryPolicy: { temporary: true },
    });
    const policy = readRegistryPolicy(file);
    expect(policy.temporary).toBe(true);
    expect(policy.notice.length).toBeGreaterThan(0);
  });

  it("fails safe (not temporary) on a malformed package.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-policy-bad-"));
    const file = path.join(dir, "package.json");
    fs.writeFileSync(file, "{ this is not json", "utf8");
    expect(readRegistryPolicy(file).temporary).toBe(false);
  });

  it("fails safe (not temporary) when the package.json does not exist", () => {
    expect(readRegistryPolicy("/no/such/path/package.json").temporary).toBe(false);
  });

  it("env override CINATRA_REGISTRY_POLICY_TEMPORARY wins over file (on)", () => {
    const file = writeFixturePackageJson({
      cinatraRegistryPolicy: { temporary: false },
    });
    process.env.CINATRA_REGISTRY_POLICY_TEMPORARY = "true";
    process.env.CINATRA_REGISTRY_POLICY_NOTICE = "env notice copy";
    const policy = readRegistryPolicy(file);
    expect(policy.temporary).toBe(true);
    expect(policy.notice).toBe("env notice copy");
  });

  it("env override can force temporary OFF even when file says true", () => {
    const file = writeFixturePackageJson({
      cinatraRegistryPolicy: { temporary: true, notice: "file says on" },
    });
    process.env.CINATRA_REGISTRY_POLICY_TEMPORARY = "false";
    expect(readRegistryPolicy(file).temporary).toBe(false);
  });

  it("reads the real root package.json with temporary:false by default (ships no banner)", () => {
    // No fixture path → reads the actual repo-root package.json. The shipped
    // default MUST be off so no banner appears out of the box.
    expect(readRegistryPolicy().temporary).toBe(false);
  });
});
