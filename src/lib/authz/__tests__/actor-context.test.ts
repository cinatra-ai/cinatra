// Tests asserting:
//   * POLICY_VERSION === "v2"
//   * ActorContext shape carries an optional projectIds: string[] field.
//
// These assertions protect the policy version contract and the project-scoped
// actor context shape.

import { describe, it, expect, expectTypeOf } from "vitest";
import { POLICY_VERSION } from "@/lib/authz/actor-context";
import type { ActorContext } from "@/lib/authz/actor-context";

describe("actor-context constants and types", () => {
  it("POLICY_VERSION is \"v2\"", () => {
    expect(POLICY_VERSION).toBe("v2");
  });

  it("ActorContext shape carries an optional projectIds: string[] field", () => {
    // Type-level assertion. If the field is missing, the literal below fails
    // tsgo because 'projectIds' does not exist in the ActorContext type.
    const sample: ActorContext = {
      principalType: "HumanUser",
      principalId: "user-1",
      organizationId: "org-1",
      teamIds: ["team-1"],
      projectIds: ["project-1"],
      platformRole: "member",
      orgRole: "member",
      authSource: "ui",
      policyVersion: POLICY_VERSION,
    } as ActorContext;
    expect(Array.isArray(sample.projectIds)).toBe(true);
    // Also validate compile-time shape via expectTypeOf for clarity.
    expectTypeOf<ActorContext["projectIds"]>().toEqualTypeOf<string[] | undefined>();
  });
});
