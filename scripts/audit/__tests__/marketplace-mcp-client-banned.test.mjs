import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CURRENT_ALLOWLIST,
  scan,
} from "../marketplace-mcp-client-banned.mjs";

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "mmc-ban-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "packages/marketplace-mcp-client/src"), { recursive: true });
  mkdirSync(join(root, "packages/some-other-pkg/src"), { recursive: true });
  return root;
}

describe("CURRENT_ALLOWLIST", () => {
  it("is frozen", () => {
    expect(() => {
      // @ts-expect-error - runtime mutation guard
      CURRENT_ALLOWLIST.push("foo");
    }).toThrow();
  });

  it("contains the known import sites that ship before the swap", () => {
    // These are the call sites whose imports MUST be migrated to the
    // published contract package. The list shrinks as the swap PR
    // migrates each one.
    expect([...CURRENT_ALLOWLIST]).toContain("src/app/configuration/environment/marketplace-publish-actions.ts");
    expect([...CURRENT_ALLOWLIST]).toContain("packages/marketplace-sync/src/sync-worker.ts");
    expect([...CURRENT_ALLOWLIST]).toContain("packages/marketplace-sync/src/package-mapper.ts");
    expect([...CURRENT_ALLOWLIST]).toContain("packages/marketplace-sync/tests/sync-worker.test.ts");
    expect([...CURRENT_ALLOWLIST]).toContain("packages/marketplace-sync/package.json");
  });
});

describe("scan() — passes when only allowlisted files reference the banned name", () => {
  it("returns ok=true when there are no banned imports anywhere", () => {
    const root = makeRepo();
    try {
      writeFileSync(join(root, "src/clean.ts"), "export const x = 1;\n");
      const result = scan(root);
      expect(result.ok).toBe(true);
      expect(result.unallowlistedHits).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns ok=true when only the allowlisted vendored package itself references the name", () => {
    const root = makeRepo();
    try {
      writeFileSync(
        join(root, "packages/marketplace-mcp-client/src/index.ts"),
        'export * from "./client.js";\n',
      );
      writeFileSync(
        join(root, "packages/marketplace-mcp-client/src/client.ts"),
        '// @cinatra-ai/marketplace-mcp-client exports go here\n',
      );
      const result = scan(root);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scan() — rejects new unallowlisted imports of the banned name", () => {
  it("rejects a new file importing the vendored package", () => {
    const root = makeRepo();
    try {
      writeFileSync(
        join(root, "src/new-consumer.ts"),
        'import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client";\n',
      );
      const result = scan(root);
      expect(result.ok).toBe(false);
      expect(result.unallowlistedHits).toHaveLength(1);
      expect(result.unallowlistedHits[0].path).toBe("src/new-consumer.ts");
      expect(result.unallowlistedHits[0].hits.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-allowlisted file with a deep path into packages/marketplace-mcp-client/", () => {
    // Test the `packages/marketplace-mcp-client/...` regex by writing a
    // YAML / config / doc that literally names the path (a realistic
    // regression — e.g. a workflow file naming the vendored path that
    // wasn't allowlisted, or a doc snippet someone wrote that references
    // the path directly without the npm scope prefix).
    const root = makeRepo();
    try {
      writeFileSync(
        join(root, "packages/some-other-pkg/src/regression.yaml"),
        '# This file mentions packages/marketplace-mcp-client/src/client.ts as a regression case\n',
      );
      const result = scan(root);
      expect(result.ok).toBe(false);
      expect(result.unallowlistedHits.some(h => h.path.includes("regression.yaml"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unallowlisted import inside scripts/ (regression: prior SKIP_DIRS bug pruned the whole scripts tree)", () => {
    const root = makeRepo();
    try {
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(
        join(root, "scripts/new-helper.mjs"),
        'import { Foo } from "@cinatra-ai/marketplace-mcp-client";\n',
      );
      const result = scan(root);
      expect(result.ok).toBe(false);
      expect(result.unallowlistedHits.some(h => h.path === "scripts/new-helper.mjs")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores node_modules", () => {
    const root = makeRepo();
    try {
      mkdirSync(join(root, "node_modules/some-dep"), { recursive: true });
      writeFileSync(
        join(root, "node_modules/some-dep/index.js"),
        '// references @cinatra-ai/marketplace-mcp-client deep inside node_modules\n',
      );
      const result = scan(root);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not trip on the audit script's own self-reference", () => {
    // The real script + its real test file are excluded from scanning by
    // the SELF_REFERENCING_FILES allowlist inside the scanner. Build a
    // fixture repo that mirrors the real script's path layout + ensure
    // those files are skipped, while an unallowlisted scripts/ file IS
    // caught.
    const root = makeRepo();
    try {
      mkdirSync(join(root, "scripts/audit/__tests__"), { recursive: true });
      mkdirSync(join(root, ".github/workflows"), { recursive: true });
      writeFileSync(
        join(root, "scripts/audit/marketplace-mcp-client-banned.mjs"),
        '// Real audit script references @cinatra-ai/marketplace-mcp-client by design\n',
      );
      writeFileSync(
        join(root, "scripts/audit/__tests__/marketplace-mcp-client-banned.test.mjs"),
        '// Test file references @cinatra-ai/marketplace-mcp-client in fixtures\n',
      );
      writeFileSync(
        join(root, ".github/workflows/marketplace-mcp-client-banned.yml"),
        '# Workflow doc names @cinatra-ai/marketplace-mcp-client\n',
      );
      const result = scan(root);
      const selfHits = result.unallowlistedHits.filter(h =>
        h.path === "scripts/audit/marketplace-mcp-client-banned.mjs" ||
        h.path === "scripts/audit/__tests__/marketplace-mcp-client-banned.test.mjs" ||
        h.path === ".github/workflows/marketplace-mcp-client-banned.yml",
      );
      expect(selfHits).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
