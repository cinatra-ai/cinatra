// ---------------------------------------------------------------------------
// Replacement coverage contract.
// ---------------------------------------------------------------------------
//
// For every retired legacy wrapper primitive, assert that its `replacement`
// field in the surface inventory points at a real canonical landing spot:
//   - one of the FIVE canonical objects_* primitives (shared object types), OR
//   - a canonical crm_* primitive on the provider-agnostic CRM facade — the
//     entity (accounts_*/contacts_*) and CRM-list (lists_*) wrappers migrated
//     to the Twenty CRM surface, OR
//   - the explicit "no CRM equivalent" sentinel, for verbs whose surface was
//     intentionally retired with no replacement primitive.
//
// The objects_* primitives are proven real via their schema export in
// `packages/objects/src/mcp/schemas.ts`; the crm_* primitives are proven real
// via their classification entry in `src/lib/authz/inventory-augment.ts`. This
// is the lightweight static-contract proof that there is no "retired but no
// replacement" gap. A replacement that references neither a real canonical
// primitive nor the no-equivalent sentinel still fails this gate.
//
// The full behavioral E2E for per-replacement HTTP+authz round-trips remains
// the responsibility of the broader Playwright suite (`tests/e2e/`); this
// static check covers the schema and reference contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { LEGACY_PRIMITIVES } from "../surface-inventory";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SCHEMAS_SRC = readFileSync(
  path.join(ROOT, "packages/objects/src/mcp/schemas.ts"),
  "utf8",
);
// inventory-augment has type-only runtime imports — safe to read as text in the
// same static-scan style used for the objects schemas above.
const INVENTORY_AUGMENT_SRC = readFileSync(
  path.join(ROOT, "src/lib/authz/inventory-augment.ts"),
  "utf8",
);

/** The five canonical primitives that replace every shared-object-type wrapper. */
const CANONICAL_PRIMITIVES = [
  "objects_list",
  "objects_get",
  "objects_save",
  "objects_update",
  "objects_delete",
] as const;

const CANONICAL_SCHEMA_EXPORTS: Readonly<Record<(typeof CANONICAL_PRIMITIVES)[number], string>> = {
  objects_list: "objectsListSchema",
  objects_get: "objectsGetSchema",
  objects_save: "objectsSaveSchema",
  objects_update: "objectsUpdateSchema",
  objects_delete: "objectsDeleteSchema",
};

/**
 * Canonical CRM-facade primitives that replace the retired entity (accounts_*,
 * contacts_*) and CRM-list (lists_*) wrappers, per the Twenty migration.
 * Sourced from the CrmConnector contract (`crm-connector-contract.ts`).
 */
const CRM_PRIMITIVES = [
  "crm_account_search",
  "crm_account_get",
  "crm_account_create",
  "crm_account_update",
  "crm_contact_search",
  "crm_contact_get",
  "crm_contact_create",
  "crm_contact_update",
  "crm_contact_find_by_email",
  "crm_list_search",
  "crm_list_get",
  "crm_list_create",
  "crm_list_members_get",
  "crm_list_member_add",
  "crm_list_member_remove",
] as const;

/**
 * Sentinel for retired verbs with no replacement primitive (e.g. delete /
 * rename flows that the operator performs directly in the Twenty UI). The
 * inventory phrases these as "no CRM equivalent - …".
 */
const NO_EQUIVALENT_SENTINEL = "no CRM equivalent";

describe("replacement coverage", () => {
  it("every retired primitive's `replacement` references a real canonical primitive or the no-equivalent sentinel", () => {
    const missing: Array<{ legacy: string; replacement: string }> = [];
    for (const p of LEGACY_PRIMITIVES) {
      const matched =
        CANONICAL_PRIMITIVES.some((canonical) => p.replacement.includes(canonical)) ||
        CRM_PRIMITIVES.some((crm) => p.replacement.includes(crm)) ||
        p.replacement.includes(NO_EQUIVALENT_SENTINEL);
      if (!matched) {
        missing.push({ legacy: p.name, replacement: p.replacement });
      }
    }
    expect(
      missing,
      `Retired primitives without a canonical replacement or no-equivalent sentinel: ${JSON.stringify(missing, null, 2)}`,
    ).toEqual([]);
  });

  it("every crm_* primitive referenced by a replacement is a real classified primitive", () => {
    for (const p of LEGACY_PRIMITIVES) {
      for (const crm of CRM_PRIMITIVES) {
        if (!p.replacement.includes(crm)) continue;
        expect(
          INVENTORY_AUGMENT_SRC.includes(`${crm}:`),
          `${p.name} → ${crm} has no classification entry in src/lib/authz/inventory-augment.ts`,
        ).toBe(true);
      }
    }
  });

  it("every canonical primitive referenced has a real schema export", () => {
    for (const [primitive, schemaName] of Object.entries(CANONICAL_SCHEMA_EXPORTS)) {
      const start = SCHEMAS_SRC.indexOf(`export const ${schemaName}`);
      expect(
        start,
        `${primitive} → expected schema export "${schemaName}" in packages/objects/src/mcp/schemas.ts`,
      ).toBeGreaterThan(-1);
    }
    // Strictness is enforced separately by `objects-surface-drift.test.ts`,
    // which asserts `.strict()` on the identity-bearing schemas
    // (get/save/update/delete/classify). `objects_list` intentionally allows
    // additional pagination/filter knobs and is NOT strict; that contract does
    // not require it to be.
  });

  it("every retired primitive is unregistered in the surface inventory", () => {
    // The surface inventory must not mark retired wrappers as registered; this
    // defense-in-depth assertion keeps replacement coverage tied to
    // unregistration state.
    for (const p of LEGACY_PRIMITIVES) {
      expect(p.registered, `${p.name} should be retired (registered: false)`).toBe(false);
    }
  });
});
