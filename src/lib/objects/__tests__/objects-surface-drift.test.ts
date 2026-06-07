// ---------------------------------------------------------------------------
// Objects-surface CI drift guard.
// ---------------------------------------------------------------------------
//
// Static source-scan (the pattern proven by src/__tests__/mcp-server-tool-count.test.ts)
// reading the surface inventory + taxonomy as the MANDATORY source-of-truth.
// Fails CI on:
//   1. ENTITY/ASSET_TYPE_IDS not derived from / not subset of the taxonomy.
//   2. A re-introduced legacy alias (`payload`, top-level identity `type`) or a
//      missing `.strict()` on a locked schema.
//   3. A NEW raw `."objects"` table bypass outside the inventoried allow-list
//      (fail-closed — no carve-out escape).
//   4. The delegated-chat allowlist drifting from the inventory (or a mutation
//      primitive sneaking in).
//   5. The registered legacy-primitive set drifting from the inventory
//      `registered` flags.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import * as path from "node:path";
import {
  LEGACY_PRIMITIVES,
  RAW_OBJECT_ACCESS_ALLOWLIST,
  DELEGATED_CHAT_OBJECT_ALLOWLIST,
  CARVE_OUT_MODE,
} from "../surface-inventory";
// Import the taxonomy via its source file directly (it has only type-only +
// relative imports at runtime — no `server-only`, no heavy barrel).
import {
  OBJECT_TYPE_FAMILY,
  objectTypeIdsForFamily,
  isNamespacedObjectTypeId,
} from "../../../../packages/objects/src/taxonomy";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// 1. Taxonomy gating + lockstep
// ---------------------------------------------------------------------------
describe("taxonomy gating + lockstep", () => {
  it("every locked type id is domain-namespaced", () => {
    for (const id of Object.keys(OBJECT_TYPE_FAMILY)) {
      expect(isNamespacedObjectTypeId(id)).toBe(true);
    }
  });

  it("ENTITY/ASSET_TYPE_IDS are DERIVED from the taxonomy (lockstep, D7)", () => {
    const src = read("src/lib/register-all-object-types.ts");
    expect(src).toMatch(/ENTITY_TYPE_IDS\s*=\s*new Set\(objectTypeIdsForFamily\("entity"\)\)/);
    expect(src).toMatch(/ASSET_TYPE_IDS\s*=\s*new Set\(objectTypeIdsForFamily\("asset"\)\)/);
    // entity family = accounts + contacts ONLY.
    expect(objectTypeIdsForFamily("entity")).toEqual([
      "@cinatra-ai/entity-accounts:account",
      "@cinatra-ai/entity-contacts:contact",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Canonical contract — no re-introduced alias; strict schemas
// ---------------------------------------------------------------------------
describe("objects_* contract lock", () => {
  const schemas = read("packages/objects/src/mcp/schemas.ts");

  it("no `payload` FIELD anywhere in the objects schemas (alias removed)", () => {
    // Match a field declaration `payload:` (not the word in comments / .describe()).
    expect(schemas).not.toMatch(/\n\s*payload:/);
  });

  it("objectsSaveSchema has no top-level identity `type:` alias (typeHint only)", () => {
    const block = schemas.slice(
      schemas.indexOf("export const objectsSaveSchema"),
      schemas.indexOf("export const objectsListSchema"),
    );
    expect(block).not.toMatch(/\btype:/); // typeHint: is fine; bare type: is the removed alias
    expect(block).toContain("typeHint:");
    expect(block).toMatch(/\}\)\.strict\(\);/);
  });

  it("get/update/delete/classify schemas are .strict()", () => {
    for (const name of [
      "objectsGetSchema",
      "objectsUpdateSchema",
      "objectsDeleteSchema",
      "objectsClassifySchema",
    ]) {
      const start = schemas.indexOf(`export const ${name}`);
      expect(start).toBeGreaterThan(-1);
      // the schema's own closing `}).strict();` appears before the next export
      const rest = schemas.slice(start);
      const end = rest.indexOf("export const", 1);
      const block = end === -1 ? rest : rest.slice(0, end);
      expect(block).toMatch(/\}\)\.strict\(\);/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Raw `."objects"` bypass scan — fail-closed
// ---------------------------------------------------------------------------
describe("no NEW raw cinatra.objects bypass (fail-closed)", () => {
  it("carve-out is fail-closed", () => {
    expect(CARVE_OUT_MODE).toBe("fail-closed");
  });

  it("every file touching the raw objects table is inventoried or in the objects substrate package", () => {
    const allowedFiles = new Set(RAW_OBJECT_ACCESS_ALLOWLIST.map((e) => e.file));
    // The inventory module + this gate legitimately DOCUMENT the pattern.
    const SCAN_EXCLUDE = new Set(["src/lib/objects/surface-inventory.ts"]);
    const RAW_TABLE_RE = /\."objects"/;
    const offenders: string[] = [];

    const walk = (absDir: string) => {
      for (const entry of readdirSync(absDir)) {
        if (
          entry === "node_modules" ||
          entry === ".next" ||
          entry === "dist" ||
          entry === "__tests__" ||
          entry === ".git"
        )
          continue;
        const abs = path.join(absDir, entry);
        const st = statSync(abs);
        if (st.isDirectory()) {
          walk(abs);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry) || entry.endsWith(".test.ts") || entry.endsWith(".test.tsx"))
          continue;
        const rel = path.relative(ROOT, abs);
        // The whole objects substrate package is allowed (it IS the table owner).
        if (rel.startsWith("packages/objects/")) continue;
        if (SCAN_EXCLUDE.has(rel)) continue;
        if (!RAW_TABLE_RE.test(readFileSync(abs, "utf8"))) continue;
        if (!allowedFiles.has(rel)) offenders.push(rel);
      }
    };

    for (const top of ["src", "packages"]) {
      const abs = path.join(ROOT, top);
      if (existsSync(abs)) walk(abs);
    }

    expect(offenders, `Uninventoried raw cinatra.objects bypass(es): ${offenders.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Delegated-chat allowlist drift
// ---------------------------------------------------------------------------
describe("delegated-chat allowlist", () => {
  const policy = read("packages/mcp-server/src/delegated-chat-tool-policy.ts");

  it("every inventoried object-allowlist entry is present in the policy", () => {
    for (const p of DELEGATED_CHAT_OBJECT_ALLOWLIST) {
      expect(policy.includes(`"${p}"`)).toBe(true);
    }
  });

  it("no entity MUTATION primitive is in the allowlist (read-only contract)", () => {
    for (const p of [
      "accounts_create",
      "accounts_update",
      "accounts_delete",
      "contacts_create",
      "contacts_update",
      "contacts_delete",
    ]) {
      expect(policy.includes(`"${p}"`)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Tool-count: registered legacy primitives vs inventory
// ---------------------------------------------------------------------------
describe("legacy primitive registration state matches inventory", () => {
  // Registration spans BOTH the registry (TOOL_META / registerTool, e.g.
  // registry.ts `"accounts_list": {`) AND the handler map (handlers.ts
  // `"accounts_list": async (req)=>`). Checking only the registry string would
  // let a re-intro via the handler map slip CI, and would let `registered:true`
  // pass with no handler. Assert BOTH paths.
  it("each legacy primitive is present in registry+handlers iff registered (else absent from both)", () => {
    for (const p of LEGACY_PRIMITIVES) {
      // The entity-accounts / entity-contacts / lists deprecation-stub packages
      // were fully deleted in the Twenty migration, so their registry/handlers
      // files no longer exist. A missing registry file is the terminal retired
      // state — the primitive cannot be registered anywhere, so it must be
      // marked `registered: false`. (Reintroduction anywhere is independently
      // guarded by the crm-pointer-gate banned-token scan.)
      if (!existsSync(path.join(ROOT, p.registry))) {
        expect(
          p.registered,
          `${p.name} registry file is gone (package deleted) but inventory marks it registered`,
        ).toBe(false);
        continue;
      }
      const registrySrc = read(p.registry);
      const handlersSrc = read(p.registry.replace(/registry\.ts$/, "handlers.ts"));
      const key = `"${p.name}"`;
      if (p.registered) {
        expect(registrySrc.includes(key), `${p.name} missing from registry (registration)`).toBe(true);
        expect(handlersSrc.includes(key), `${p.name} missing from handlers (no impl)`).toBe(true);
      } else {
        // Once retired, re-introducing it via the wire registry fails CI.
        expect(registrySrc.includes(key), `${p.name} still in registry (retired)`).toBe(false);
        // Handler presence is gated by `handlerRetained` for primitives in
        // the staged-retirement window (wire dark, handler kept until the
        // package's deprecation-stub slice deletes them alongside the rest
        // of the package source).
        if (p.handlerRetained) {
          // Intentionally retained — the drift test does not assert absence
          // here. The next slice flips this back to false.
          continue;
        }
        expect(handlersSrc.includes(key), `${p.name} still in handlers (retired)`).toBe(false);
      }
    }
  });
});
