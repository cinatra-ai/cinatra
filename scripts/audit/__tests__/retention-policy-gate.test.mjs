// Recurrence guard for the retention-policy completeness gate
// (scripts/audit/retention-policy-gate.mjs). Verifies that:
//   1. The discovery walk EXCLUDES test files (`**/__tests__/**`, `*.test.ts`)
//      so test-fixture object types never get flagged as "missing." A naïve
//      git-grep without test exclusion is the bug class this guard prevents.
//   2. The nine namespaced production types are declared.
//   3. The live tree runs the gate clean (smoke).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadDiscoveredTypes, loadDeclaredTypes, runGate } from "../retention-policy-gate.mjs";

describe("retention-policy-gate — discovery excludes tests (recurrence guard)", () => {
  let synthRoot;

  beforeAll(async () => {
    // Build a synthetic mini-tree under a tempdir that mirrors the real
    // repo's shape, so we can exercise the walker without affecting the
    // live repo. Two siblings: a production file with one type, and a
    // test file with a different type. The test file's type MUST NOT
    // appear in the discovered set.
    synthRoot = await mkdtemp(join(tmpdir(), "retention-gate-test-"));
    // Production registration — must be discovered.
    await mkdir(join(synthRoot, "src", "lib", "prod"), { recursive: true });
    await writeFile(
      join(synthRoot, "src", "lib", "prod", "register.ts"),
      `objectTypeRegistry.register({\n  type: "@cinatra-ai/synthetic-prod:thing",\n});\n`,
    );
    // Test fixture under __tests__/ — must NOT be discovered.
    await mkdir(join(synthRoot, "src", "lib", "prod", "__tests__"), { recursive: true });
    await writeFile(
      join(synthRoot, "src", "lib", "prod", "__tests__", "register.test.ts"),
      `// fixture\nconst spec = { type: "@cinatra-ai/synthetic-test:fixture" };\n`,
    );
    // Sibling *.test.ts (NOT in __tests__/) — must also be skipped.
    await writeFile(
      join(synthRoot, "src", "lib", "prod", "smoke.test.ts"),
      `const spec = { type: "@cinatra-ai/synthetic-smoke:fixture" };\n`,
    );
    // `.d.ts` declarations — must also be skipped (they're not source).
    await writeFile(
      join(synthRoot, "src", "lib", "prod", "shape.d.ts"),
      `export const x = { type: "@cinatra-ai/synthetic-dts:fixture" };\n`,
    );
  });

  afterAll(async () => {
    if (synthRoot) await rm(synthRoot, { recursive: true, force: true });
  });

  it("discovers production `type: \"...\"` registrations under src/", async () => {
    const discovered = await loadDiscoveredTypes(synthRoot, ["src"]);
    expect(discovered.has("@cinatra-ai/synthetic-prod:thing")).toBe(true);
  });

  it("EXCLUDES test files (`__tests__/`, `*.test.ts`, `.d.ts`)", async () => {
    const discovered = await loadDiscoveredTypes(synthRoot, ["src"]);
    expect(discovered.has("@cinatra-ai/synthetic-test:fixture")).toBe(false);
    expect(discovered.has("@cinatra-ai/synthetic-smoke:fixture")).toBe(false);
    expect(discovered.has("@cinatra-ai/synthetic-dts:fixture")).toBe(false);
  });
});

describe("retention-policy-gate — namespaced declarations present", () => {
  const REQUIRED_NAMESPACED = [
    "@cinatra-ai/entity-contacts:contact",
    "@cinatra-ai/entity-accounts:account",
    "@cinatra-ai/agent-builder:agent-template",
    "@cinatra-ai/lists:list",
    "@cinatra-ai/assets:blog-project",
    "@cinatra-ai/assets:blog-idea",
    "@cinatra-ai/assets:blog-post",
    "@cinatra-ai/artifacts:artifact-ref",
    "@cinatra-ai/artifact:object",
  ];

  it("declares every namespaced type the gate would otherwise flag", async () => {
    const declared = await loadDeclaredTypes();
    for (const t of REQUIRED_NAMESPACED) {
      expect(declared, `RETENTION_POLICIES is missing "${t}"`).toContain(t);
    }
  });
});

describe("retention-policy-gate — live tree smoke", () => {
  it("runs clean against the live repo (0 missing)", async () => {
    const { missing } = await runGate();
    expect(missing, `missing types: ${missing.join(", ")}`).toEqual([]);
  });
});
