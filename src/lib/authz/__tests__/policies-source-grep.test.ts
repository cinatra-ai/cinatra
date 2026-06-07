/**
 * Source-text invariant for policies.ts.
 *
 * The EFFECTIVE_GRANTS-level negative assertion in enforce.test.ts
 * ("member STILL does NOT have registry.install") catches the symptom.
 * This test catches the cause: even with a future INHERITS-edge regression
 * that flips the inheritance direction, a literal `"registry.install"`
 * string appearing inside the `member: new Set<Permission>([...])` block
 * fails CI here. Belt-and-suspenders.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("policies.ts source-text invariants", () => {
  it("member tier does NOT include registry.install", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "policies.ts"),
      "utf-8",
    );
    // Match `member: new Set<Permission>([ ... ])` — non-greedy capture to the
    // matching `])` so we don't accidentally swallow trailing tiers.
    const match = src.match(/^\s*member:\s*new Set<Permission>\(\[([\s\S]*?)\]\)/m);
    expect(match, "member: new Set<Permission>([...]) block must exist in policies.ts").not.toBeNull();
    const body = match![1];
    // Strip out comment lines so a "// no registry.install" comment can't
    // accidentally pass the assertion.
    const codeOnly = body
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toContain("registry.install");
  });
});
