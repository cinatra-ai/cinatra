// Primitives channel for AGENT extensions (cinatra#1625, epic #1620 S8 — M3,
// prereq (b)). The vendoring mechanism is extension-KIND-agnostic: a claiming
// `-agent` extension vendors shadcn registry primitives the SAME way a connector
// does, and the relative-import rewrite keeps the vendored copies clear of the
// (kind-agnostic) `@/` import-ban. This proves the channel generalizes to an
// agent dir using the script's OWN exported building blocks — no connector-only
// assumption anywhere in the path.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  resolveUiClosure,
  rewriteUiImports,
  VENDOR_MANIFEST,
} from "../vendor-extension-primitives.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

// The exact planner logic vendor-extension-primitives.mjs runs, applied to an
// AGENT extensionDir instead of a connector — mirrors plannedFiles() so we prove
// the real transform, not a toy.
function plannedFilesFor(extensionDir, uiItems) {
  const files = [];
  files.push({
    target: join(extensionDir, "src/lib/utils.ts"),
    content: readFileSync(join(REPO_ROOT, "src/lib/utils.ts"), "utf8"),
  });
  for (const item of resolveUiClosure(uiItems)) {
    const source = `src/components/ui/${item}.tsx`;
    files.push({
      target: join(extensionDir, `src/components/ui/${item}.tsx`),
      content: rewriteUiImports(readFileSync(join(REPO_ROOT, source), "utf8"), source),
    });
  }
  return files;
}

// A representative HITL-renderer claimant + the primitives its migrated renderer
// would import directly (field pulls in label/separator; input-group pulls in
// button/input/textarea — the closure is resolved from registry.json).
const AGENT_DIR = "extensions/cinatra-ai/blog-wordpress-publish-agent";
const AGENT_UI_ITEMS = ["button", "card", "field", "input-group"];

describe("primitives vendoring channel — agent applicability", () => {
  it("resolves the same transitive registry closure for an agent's uiItems", () => {
    const closure = resolveUiClosure(AGENT_UI_ITEMS);
    // Direct + transitive (field -> label/separator, input-group -> button/input/textarea).
    for (const expected of ["button", "card", "field", "label", "separator", "input", "input-group"]) {
      expect(closure).toContain(expected);
    }
  });

  it("plans vendored files UNDER the agent dir, mirroring the connector layout", () => {
    const files = plannedFilesFor(AGENT_DIR, AGENT_UI_ITEMS);
    expect(files.some((f) => f.target.endsWith("src/lib/utils.ts"))).toBe(true);
    for (const f of files) {
      expect(f.target.startsWith(AGENT_DIR + "/")).toBe(true);
    }
  });

  it("every vendored primitive an agent ships is FREE of `@/` imports (passes the kind-agnostic @/ ban)", () => {
    const files = plannedFilesFor(AGENT_DIR, AGENT_UI_ITEMS);
    for (const f of files) {
      expect(f.content).not.toMatch(/from\s+['"]@\//);
      expect(f.content).not.toMatch(/import\(\s*['"]@\//);
    }
  });

  it("uses RELATIVE cross-imports between vendored primitives (./sibling, ../../lib/utils)", () => {
    const files = plannedFilesFor(AGENT_DIR, AGENT_UI_ITEMS);
    const field = files.find((f) => f.target.endsWith("src/components/ui/field.tsx"));
    expect(field).toBeDefined();
    // field.tsx imports the shared cn util + its sibling primitives relatively.
    expect(field.content).toMatch(/from\s+["']\.\.\/\.\.\/lib\/utils["']/);
  });

  it("the rewrite guard still REFUSES a non-vendorable host `@/` import for an agent target", () => {
    const hostile = 'import { auth } from "@/lib/auth";\nexport const x = 1;\n';
    expect(() => rewriteUiImports(hostile, "src/components/ui/hostile.tsx")).toThrow(
      /un-vendorable app import/,
    );
  });

  it("the VENDOR_MANIFEST shape is kind-neutral (a plain {extensionDir, uiItems} list)", () => {
    for (const entry of VENDOR_MANIFEST) {
      expect(typeof entry.extensionDir).toBe("string");
      expect(entry.extensionDir.startsWith("extensions/")).toBe(true);
      expect(Array.isArray(entry.uiItems)).toBe(true);
    }
  });
});
