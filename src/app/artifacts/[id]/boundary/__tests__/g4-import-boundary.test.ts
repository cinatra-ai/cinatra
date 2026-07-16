/**
 * G4 — artifact-renderer-entry import boundary (epic #1620 / #1624 S6). The
 * ESLint layer-boundary rule: a core module must not import an artifact-extension
 * renderer ENTRY (`@<scope>/<x>-artifact` + subpaths); the SOLE carve-out is the
 * generated map `src/lib/generated/artifact-renderers.ts`. Uses the ESLint Node
 * API `lintText({ filePath })` so the flat-config layers resolve for the given
 * path WITHOUT writing (or mutating) any file — no shared-source mutation, so it
 * is deterministic under Vitest's parallel workers.
 */
import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const BAN_MSG = "artifact-extension renderer ENTRY";

const eslint = new ESLint({ cwd: REPO_ROOT });

async function artifactBans(code: string, relPath: string) {
  const [result] = await eslint.lintText(code, { filePath: join(REPO_ROOT, relPath), warnIgnored: false });
  return (result?.messages ?? []).filter(
    (m) => m.ruleId === "no-restricted-imports" && m.message.includes(BAN_MSG),
  );
}

const ENTRY = `import { X } from "@cinatra-ai/example-artifact/renderers/detail";\nexport const y = X;\n`;

describe("G4 artifact-renderer-entry import boundary", () => {
  it("blocks a CORE app file importing an artifact-extension renderer entry", async () => {
    expect((await artifactBans(ENTRY, "src/app/artifacts/[id]/x.ts")).length).toBeGreaterThan(0);
  });

  it("blocks both the bare package name AND a subpath", async () => {
    const code = `import "@vendor/thing-artifact";\nimport "@vendor/thing-artifact/detail";\n`;
    expect((await artifactBans(code, "packages/objects/src/x.ts")).length).toBe(2);
  });

  it("blocks a core LIB/shell file too — no shell/floor exception", async () => {
    expect((await artifactBans(ENTRY, "src/app/artifacts/[id]/extension-renderer-slot.tsx")).length).toBeGreaterThan(0);
  });

  it("ALLOWS the generated map to import an artifact entry (the SOLE carve-out)", async () => {
    expect(await artifactBans(ENTRY, "src/lib/generated/artifact-renderers.ts")).toEqual([]);
  });

  it("the carve-out is path-specific — a sibling generated file is NOT exempt", async () => {
    expect((await artifactBans(ENTRY, "src/lib/generated/__g4_sibling.ts")).length).toBeGreaterThan(0);
  });
});
