// Unit tests for the required-extension OAS seed-dir RESOLUTION (cinatra#3169).
//
// `CINATRA_REQUIRED_OAS_SEED_DIR` is the deploy-owned override for the seed the
// boot reconcile reads. These tests pin the resolver: unset ⇒ the image-baked
// default (unchanged production behaviour), set ⇒ the named directory, and a
// path outside the allowed root (relative, dot-segmented, or inside the durable
// user store) is REFUSED rather than silently honoured.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_REQUIRED_OAS_SEED_DIR,
  REQUIRED_OAS_SEED_DIR_ENV,
  resolveRequiredOasSeedDir,
} from "@/lib/required-extension-materialize";

let root: string;
let storeRoot: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "seeddir-3169-"));
  storeRoot = path.join(root, "store");
  for (const key of [REQUIRED_OAS_SEED_DIR_ENV, "CINATRA_EXTENSION_DATA_ROOT"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.CINATRA_EXTENSION_DATA_ROOT = storeRoot;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("resolveRequiredOasSeedDir", () => {
  it("falls back to the image-baked default when the variable is unset", () => {
    delete process.env[REQUIRED_OAS_SEED_DIR_ENV];
    expect(resolveRequiredOasSeedDir()).toEqual({
      seedDir: DEFAULT_REQUIRED_OAS_SEED_DIR,
      source: "image-default",
    });
  });

  it("falls back to the image-baked default when the variable is empty/whitespace", () => {
    process.env[REQUIRED_OAS_SEED_DIR_ENV] = "   ";
    expect(resolveRequiredOasSeedDir().source).toBe("image-default");
  });

  it("reads an absolute directory named by the variable", () => {
    const seedDir = path.join(root, "required-oas-seed");
    process.env[REQUIRED_OAS_SEED_DIR_ENV] = seedDir;
    expect(resolveRequiredOasSeedDir()).toEqual({ seedDir, source: "env" });
  });

  it("refuses a relative path (it would resolve against an unknown cwd)", () => {
    process.env[REQUIRED_OAS_SEED_DIR_ENV] = "state/required-oas-seed";
    expect(() => resolveRequiredOasSeedDir()).toThrow(/CINATRA_REQUIRED_OAS_SEED_DIR/);
    expect(() => resolveRequiredOasSeedDir()).toThrow(/absolute/);
  });

  it("refuses a path carrying '.' or '..' segments", () => {
    // Written unjoined: path.join would normalise the segment away.
    process.env[REQUIRED_OAS_SEED_DIR_ENV] = `${root}/state/../seed`;
    expect(() => resolveRequiredOasSeedDir()).toThrow(/CINATRA_REQUIRED_OAS_SEED_DIR/);
  });

  it("refuses a path at or under the durable user store (the allowed-root guard)", () => {
    process.env[REQUIRED_OAS_SEED_DIR_ENV] = path.join(storeRoot, "agents", "seed");
    expect(() => resolveRequiredOasSeedDir()).toThrow(/CINATRA_REQUIRED_OAS_SEED_DIR/);
    process.env[REQUIRED_OAS_SEED_DIR_ENV] = storeRoot;
    expect(() => resolveRequiredOasSeedDir()).toThrow(/CINATRA_REQUIRED_OAS_SEED_DIR/);
  });

  it("refuses a path that reaches the user store through an ancestor symlink", () => {
    // The lexical check alone is escaped by a symlinked ancestor: /…/link -> store.
    mkdirSync(path.join(storeRoot, "agents"), { recursive: true });
    const link = path.join(root, "seed-link");
    symlinkSync(path.join(storeRoot, "agents"), link, "dir");
    process.env[REQUIRED_OAS_SEED_DIR_ENV] = path.join(link, "planner");
    expect(() => resolveRequiredOasSeedDir()).toThrow(/CINATRA_REQUIRED_OAS_SEED_DIR/);
    expect(() => resolveRequiredOasSeedDir()).toThrow(/durable user store/);
  });

  it("refuses a value carrying a NUL byte", () => {
    // Passed as an explicit environment: assigning to process.env truncates at NUL.
    expect(() =>
      resolveRequiredOasSeedDir({ [REQUIRED_OAS_SEED_DIR_ENV]: `${root}/seed\u0000/etc` }),
    ).toThrow(/NUL byte/);
  });

  it("accepts a trailing-slash value and returns it normalised", () => {
    const seedDir = path.join(root, "trailing-seed");
    process.env[REQUIRED_OAS_SEED_DIR_ENV] = `${seedDir}/`;
    expect(resolveRequiredOasSeedDir()).toEqual({ seedDir, source: "env" });
  });

  it("reads the passed environment rather than only process.env", () => {
    const seedDir = path.join(root, "other-seed");
    expect(resolveRequiredOasSeedDir({ [REQUIRED_OAS_SEED_DIR_ENV]: seedDir })).toEqual({
      seedDir,
      source: "env",
    });
  });
});
