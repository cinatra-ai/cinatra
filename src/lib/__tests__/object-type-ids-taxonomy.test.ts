// ENTITY_TYPE_IDS / ASSET_TYPE_IDS are gated against the code-owned taxonomy
// and no longer carry lists / agent templates.
//
// Static source-scan (no import of register-all-object-types.ts — it pulls in
// `server-only` + the full registerAllObjectTypes package chain). The taxonomy
// VALUES are asserted in packages/objects/src/__tests__/taxonomy.test.ts; this
// guards the app/UI registry path's derivation and cleanup.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC = readFileSync(
  path.join(ROOT, "src/lib/register-all-object-types.ts"),
  "utf8",
);

describe("ENTITY_TYPE_IDS / ASSET_TYPE_IDS taxonomy gating", () => {
  it("derives both family sets from the taxonomy (lockstep, not hardcoded)", () => {
    expect(SRC).toMatch(/ASSET_TYPE_IDS\s*=\s*new Set\(objectTypeIdsForFamily\("asset"\)\)/);
    expect(SRC).toMatch(/ENTITY_TYPE_IDS\s*=\s*new Set\(objectTypeIdsForFamily\("entity"\)\)/);
    expect(SRC).toMatch(/import\s*\{[^}]*objectTypeIdsForFamily[^}]*\}\s*from\s*"@cinatra-ai\/objects"/);
  });

  it("no longer hardcodes lists / agent templates as entities", () => {
    // The two family-set assignments must not literally enumerate these ids.
    const setBlock = SRC.slice(
      SRC.indexOf("export const ASSET_TYPE_IDS"),
      SRC.indexOf("export const ENTITY_TYPE_IDS") +
        "export const ENTITY_TYPE_IDS = new Set(objectTypeIdsForFamily(\"entity\"));".length,
    );
    expect(setBlock).not.toContain("@cinatra-ai/agent-builder:agent-template");
    expect(setBlock).not.toContain("@cinatra-ai/lists:list");
  });
});
