import { describe, expect, it } from "vitest";

import { buildClassifierOutputSchema } from "../classifier/schema";
import {
  DYNAMIC_TYPE_ID_PREFIX,
  isDynamicObjectTypeId,
  mintDynamicObjectTypeId,
} from "../namespace";

// Reserved @dynamic scope for LLM-minted dynamic-type ids (cinatra#1425).
// NEW ids mint under `@dynamic/types:` only; a legacy `@cinatra-ai/dynamic:`
// id classifies ONLY when it already exists in the caller's catalog (the
// ACTIVE dynamic rows ride knownTypeIds) — a legacy id the DB has never seen
// is rejected, enforcing "legacy ids are never re-minted".

const base = {
  confidence: 0.9,
  normalizedData: {},
  isNewType: true,
  inferredTypeName: "Thing",
  inferredCategory: "report",
};

describe("dynamic-type id scope", () => {
  it("mints under the reserved non-vendor scope and both prefixes read as dynamic", () => {
    expect(mintDynamicObjectTypeId("competitor-profile")).toBe(
      `${DYNAMIC_TYPE_ID_PREFIX}competitor-profile`,
    );
    expect(isDynamicObjectTypeId("@dynamic/types:competitor-profile")).toBe(true);
    expect(isDynamicObjectTypeId("@cinatra-ai/dynamic:competitor-profile")).toBe(true);
    expect(isDynamicObjectTypeId("@vendor/pkg:thing")).toBe(false);
  });
});

describe("buildClassifierOutputSchema — minting policy", () => {
  const schema = buildClassifierOutputSchema([
    "@cinatra-ai/entity-accounts:account",
    // An EXISTING legacy dynamic row rides the catalog (ACTIVE dynamic types
    // are part of knownTypeIds at the call site).
    "@cinatra-ai/dynamic:existing-row",
  ]);

  it("accepts a NEW id under the reserved scope", () => {
    expect(schema.safeParse({ ...base, type: "@dynamic/types:brand-audit" }).success).toBe(true);
  });

  it("accepts a legacy id ONLY when it is already known (existing row)", () => {
    expect(schema.safeParse({ ...base, type: "@cinatra-ai/dynamic:existing-row" }).success).toBe(true);
    // A never-seen legacy-prefixed id is a re-mint attempt — rejected.
    expect(schema.safeParse({ ...base, type: "@cinatra-ai/dynamic:brand-new-idea" }).success).toBe(false);
  });

  it("still accepts registered static ids and rejects bare names", () => {
    expect(schema.safeParse({ ...base, type: "@cinatra-ai/entity-accounts:account" }).success).toBe(true);
    expect(schema.safeParse({ ...base, type: "account" }).success).toBe(false);
  });
});
