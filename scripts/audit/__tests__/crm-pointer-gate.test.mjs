// Regression tests for crm-pointer-gate's directory skip set. The gate scans
// the repo plus the cloned companion extension repos; internal working areas
// hold documentation that quotes the gate's own banned-token list, so the
// walker must never descend into them while still scanning ordinary source
// and markdown files.
//
// Dependency-free (node:test), mirroring actions-pinned-gate.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SKIP_DIRS, walk } from "../crm-pointer-gate.mjs";

const INTERNAL_DIRS = [".planning", ".claude"];

test("SKIP_DIRS covers the internal working areas", () => {
  for (const dir of INTERNAL_DIRS) {
    assert.ok(SKIP_DIRS.has(dir), `SKIP_DIRS must contain ${dir}`);
  }
});

test("walk skips internal working areas but yields ordinary files", async () => {
  const root = mkdtempSync(join(tmpdir(), "crm-gate-walk-"));
  try {
    // Internal docs that legitimately mention retired primitives.
    for (const dir of INTERNAL_DIRS) {
      mkdirSync(join(root, dir, "codebase"), { recursive: true });
      writeFileSync(
        join(root, dir, "codebase", "TESTING.md"),
        "Scans for retired primitives like contacts_get and accounts_get.\n",
      );
    }
    // Ordinary files the gate must keep scanning.
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "real.ts"), "export const ok = true;\n");
    writeFileSync(join(root, "notes.md"), "ordinary notes\n");

    const seen = [];
    for await (const abs of walk(root)) {
      seen.push(abs.slice(root.length + 1));
    }
    seen.sort();

    assert.deepEqual(seen, ["notes.md", "src/real.ts"]);
    for (const path of seen) {
      for (const dir of INTERNAL_DIRS) {
        assert.ok(!path.startsWith(`${dir}/`), `walk must not yield ${path}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
