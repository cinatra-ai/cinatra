import { describe, expect, it } from "vitest";

import { buildClassifierOutputSchema } from "../classifier/schema";
import {
  DYNAMIC_TYPE_ID_PREFIX,
  isDynamicObjectTypeId,
  mintDynamicObjectTypeId,
} from "../namespace";

// The namespace helpers still classify BOTH dynamic prefixes as dynamic (they
// are used for READ back-compat on existing rows). But the classifier no
// longer MINTS: `buildClassifierOutputSchema` accepts only ids the caller's
// catalog already knows, so a NEW dynamic id is rejected at parse time —
// "types exist only by installation" (epic #1785 slice C, cinatra#1787).

const base = {
  confidence: 0.9,
  normalizedData: {},
  isNewType: true,
  inferredTypeName: "Thing",
  inferredCategory: "report",
};

describe("dynamic-type id scope", () => {
  it("both prefixes still READ as dynamic (namespace helper unchanged)", () => {
    // The mint helper still exists (used by the retired-but-not-yet-removed
    // registrar); the point of this slice is that the CLASSIFIER never calls it.
    expect(mintDynamicObjectTypeId("competitor-profile")).toBe(
      `${DYNAMIC_TYPE_ID_PREFIX}competitor-profile`,
    );
    expect(isDynamicObjectTypeId("@dynamic/types:competitor-profile")).toBe(true);
    expect(isDynamicObjectTypeId("@cinatra-ai/dynamic:competitor-profile")).toBe(true);
    expect(isDynamicObjectTypeId("@vendor/pkg:thing")).toBe(false);
  });
});

// Acceptance criterion 4 (cinatra#1787): schema-level rejection — no code path
// can propose a NEW `@dynamic/types:*` id; READ of existing rows is untouched.
describe("buildClassifierOutputSchema — no-mint policy", () => {
  const schema = buildClassifierOutputSchema([
    "@cinatra-ai/objects:object", // the generic fallback id is a registered host type
    "@cinatra-ai/entity-accounts:account",
    // An EXISTING dynamic row rides the catalog (ACTIVE dynamic types are part
    // of knownTypeIds at the call site) so already-minted ids keep classifying.
    "@cinatra-ai/dynamic:existing-row",
  ]);

  it("REJECTS a NEW dynamic id under the reserved scope (the classifier never mints)", () => {
    expect(schema.safeParse({ ...base, type: "@dynamic/types:brand-audit" }).success).toBe(false);
  });

  it("REJECTS a never-seen legacy-prefixed id (re-mint attempt)", () => {
    expect(schema.safeParse({ ...base, type: "@cinatra-ai/dynamic:brand-new-idea" }).success).toBe(false);
  });

  it("accepts an EXISTING dynamic id already in the catalog (READ back-compat untouched)", () => {
    expect(schema.safeParse({ ...base, type: "@cinatra-ai/dynamic:existing-row" }).success).toBe(true);
  });

  it("accepts the generic fallback id (an unmatched payload comes back as the generic type)", () => {
    expect(
      schema.safeParse({ ...base, type: "@cinatra-ai/objects:object" }).success,
    ).toBe(true);
  });

  it("still accepts registered static ids and rejects bare names", () => {
    expect(schema.safeParse({ ...base, type: "@cinatra-ai/entity-accounts:account" }).success).toBe(true);
    expect(schema.safeParse({ ...base, type: "account" }).success).toBe(false);
  });
});
