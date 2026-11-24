/**
 * cinatra#3089: the declaration road admits a tool on the passthrough without
 * naming it. The route reads the owning package's declaration and spells no
 * pack and no tool for it, so the core/extension border check passes with its
 * shrink-only ledger unchanged against the default branch.
 */
// red-first-expect: to contain 'declaresPassthroughPublishingStep(too
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..", "..", "..");
const ROUTE = path.join(REPO_ROOT, "src", "app", "api", "agents", "passthrough", "route.ts");
const GATE = path.join(REPO_ROOT, "scripts", "ci", "core-extension-border-gate.mjs");
const BASELINE = "config/core-extension-border-baseline.json";

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

const base = git(["merge-base", "HEAD", "origin/main"])?.trim() || null;

describe("the declaration road and the core/extension border", () => {
  it("the route reads the declaration and names no tool of it", () => {
    const route = readFileSync(ROUTE, "utf8");
    expect(route).toContain("declaresPassthroughPublishingStep(tool)");
    expect(route).not.toMatch(/email_outreach_send_initial_start/);
  });

  it("the border check passes", () => {
    const env = { ...process.env };
    if (base) env.CORE_EXTENSION_BORDER_BASE = base;
    else delete env.CORE_EXTENSION_BORDER_BASE;
    const out = spawnSync(process.execPath, [GATE], { cwd: REPO_ROOT, encoding: "utf8", env });
    expect(out.status, `${out.stdout}\n${out.stderr}`).toBe(0);
  });

  it.skipIf(base === null)("its ledger is byte-identical to the default branch", () => {
    const committed = git(["show", `${base}:${BASELINE}`]);
    expect(committed).not.toBeNull();
    expect(readFileSync(path.join(REPO_ROOT, BASELINE), "utf8")).toBe(committed);
  });
});
