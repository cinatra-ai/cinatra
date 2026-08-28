// cinatra#1381 — the memory concept type id is INLINED in
// `memory-row-promotion.ts` (the module is reached from the import-light
// promotion contract, and the type registry is heavy — the same reason
// packages/objects/src/mcp/handlers.ts inlines it).
//
// An inlined constant is only safe while something proves it still matches. This
// is that proof: a rename in the registry reds HERE instead of silently turning
// every memory promotion into a `not_found`.
import { describe, it, expect } from "vitest";

import { MEMORY_CONCEPT_TYPE_ID as INLINED } from "../memory-row-promotion";
import { MEMORY_CONCEPT_TYPE_ID as REGISTERED } from "@cinatra-ai/objects/register-object-types";

describe("the inlined memory type id", () => {
  it("matches the registry's own constant, character for character", () => {
    expect(INLINED).toBe(REGISTERED);
  });

  it("is the value both the request gate and the decide gate compare against", () => {
    expect(INLINED).toBe("@cinatra-ai/memory:concept");
  });
});
