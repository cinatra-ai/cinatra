// Floor-scoping shape test (cinatra#1429): the floor rebalance's default-INSERT
// now carries an EXISTS-objects predicate so the default-artifact floor covers
// ONLY the generic artifact type and default-claimed types — a dedicated-claimed
// typed row (or a plain typed object) never receives a floor default assertion.
// Live-DB behavior is proven by binding-write-path.integration.test.ts.

import { describe, expect, it } from "vitest";

import { buildFloorRebalanceAndRefreshQueries } from "@/lib/artifacts/semantic-assertion-store";

describe("floor scoping (cinatra#1429)", () => {
  const [insertDefault] = buildFloorRebalanceAndRefreshQueries("o1", "a1", "agent");

  it("the default-INSERT is gated on the object's type being floor-eligible", () => {
    // The two pre-existing floor guards remain (no non-default eligible; no active default).
    expect(insertDefault.text).toMatch(/NOT EXISTS \([\s\S]*eligibility='eligible' AND extension <> \$3/);
    expect(insertDefault.text).toMatch(/NOT EXISTS \([\s\S]*extension=\$3::text AND eligibility <> 'archived'/);
    // The new floor-scoping guard: EXISTS objects whose type is generic OR has an active DEFAULT claim.
    expect(insertDefault.text).toMatch(/AND EXISTS \(/);
    expect(insertDefault.text).toContain('@cinatra-ai/artifact:object');
    expect(insertDefault.text).toMatch(/claim_kind='default'\s+AND c\.status IN \('active','retiring'\)/);
    expect(insertDefault.text).toMatch(/c\.scope='platform' OR c\.scope='org:'\|\|\$1/);
  });
});
