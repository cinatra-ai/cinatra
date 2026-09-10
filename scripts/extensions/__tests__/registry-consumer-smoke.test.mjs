// Build-approval policy of the design-system clean-consumer smoke (cinatra#3366).
//
// `pnpm dlx` installs the shadcn CLI itself before the CLI runs, and
// shadcn@4.8.2 depends on msw, which carries an install script. The consumer
// directory the smoke creates carries no `packageManager` field, so corepack
// resolves the latest pnpm there: measured 2026-09-10, pnpm 12.3.4 fails that
// install with `ERR_PNPM_IGNORED_BUILDS` while pnpm 11.24.0 carries on — so the
// smoke was green on a host whose corepack held the older line and red on a
// runner that downloaded the newer one.
//
// These pin the fix as a POLICY, not just a working command: the allowed set is
// declared, minimal and named, and the suppression shortcuts stay forbidden.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { dlxArgs, DLX_ALLOWED_BUILDS, SHADCN_VERSION } from "../registry-consumer-smoke.mjs";
import { stripComments } from "../inventory.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "registry-consumer-smoke.mjs");
// Comments are stripped so the fix's own prose ("never `--ignore-scripts`")
// is not read as the thing it forbids — the same false-positive guard the
// inventory import scan uses.
const SOURCE = stripComments(readFileSync(SCRIPT, "utf8"));

describe("registry-consumer-smoke dlx build-approval policy", () => {
  it("declares the allowed build scripts as the smallest set the install needs", () => {
    // msw is the only package pnpm reports for shadcn@4.8.2's dlx closure.
    expect(DLX_ALLOWED_BUILDS).toEqual(["msw"]);
  });

  it("passes every allowed package to dlx as an --allow-build flag", () => {
    const args = dlxArgs(["add", "@cinatra-ai/button", "--yes"]);
    for (const pkg of DLX_ALLOWED_BUILDS) {
      expect(args).toContain(`--allow-build=${pkg}`);
    }
  });

  it("places the --allow-build flags before the package spec (they are dlx options)", () => {
    const args = dlxArgs(["add", "@cinatra-ai/button", "--yes"]);
    const spec = args.indexOf(`shadcn@${SHADCN_VERSION}`);
    expect(spec).toBeGreaterThan(-1);
    for (const pkg of DLX_ALLOWED_BUILDS) {
      expect(args.indexOf(`--allow-build=${pkg}`)).toBeLessThan(spec);
    }
    expect(args.slice(0, 2)).toEqual(["pnpm", "dlx"]);
  });

  it("forwards the shadcn arguments after the package spec, unchanged", () => {
    const args = dlxArgs(["add", "@cinatra-ai/field", "--yes"]);
    const spec = args.indexOf(`shadcn@${SHADCN_VERSION}`);
    expect(args.slice(spec + 1)).toEqual(["add", "@cinatra-ai/field", "--yes"]);
  });

  it("never suppresses install scripts wholesale", () => {
    // `--ignore-scripts` or a blanket approval would hide a genuine build failure.
    for (const banned of ["--ignore-scripts", "approve-builds", "--allow-build=*"]) {
      expect(SOURCE).not.toContain(banned);
      expect(dlxArgs(["add", "@cinatra-ai/button", "--yes"])).not.toContain(banned);
    }
  });

  it("routes the smoke's shadcn invocation through the policy composition", () => {
    // A second, inline `pnpm dlx shadcn@...` argv would bypass the allow-list.
    const inlineDlx = SOURCE.match(/"pnpm",\s*"dlx"/g) ?? [];
    expect(inlineDlx).toHaveLength(1);
    expect(SOURCE).toContain("dlxArgs([\"add\"");
  });
});
