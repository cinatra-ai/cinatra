// cinatra#3745 (criterion 5b) at the core/extension border (cinatra#3821).
//
// The boundary module names no pack's tool in a tool-admission set. The
// person-decision road moved to the tool's registration
// (src/lib/authz/person-decision-declaration.ts), so the border gate's
// passthrough rule finds no crossing in src/lib/authz/mcp-boundary.ts. The
// second case keeps the first from passing vacuously: the same rule, with the
// same pack universe, flags the set the boundary used to carry.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadPackUniverse, scanScopedToolAdmissions } from "../core-extension-border-gate.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BOUNDARY = "src/lib/authz/mcp-boundary.ts";

function packUniverse() {
  const ledger = JSON.parse(readFileSync(join(REPO_ROOT, "config", "core-extension-border-baseline.json"), "utf8"));
  return loadPackUniverse(REPO_ROOT, ledger.entries).packs;
}

describe("the boundary names no pack tool for the person-decision road (cinatra#3745, #3821)", () => {
  it("finds no passthrough crossing in the boundary module", () => {
    const text = readFileSync(join(REPO_ROOT, BOUNDARY), "utf8");
    expect(text).not.toMatch(/PERSON_DECISION_EVALUATING_TOOLS/);
    expect(scanScopedToolAdmissions({ file: BOUNDARY, text, packs: packUniverse() })).toEqual([]);
  });

  it("flags the tool set the boundary used to carry", () => {
    const text = 'export const PERSON_DECISION_EVALUATING_TOOLS: ReadonlySet<string> = new Set([\n  "email_test_delivery_run_send",\n]);\n';
    const found = scanScopedToolAdmissions({ file: BOUNDARY, text, packs: packUniverse() });
    expect(found.map((f) => f.rule)).toEqual(["pack-named-passthrough"]);
  });
});
