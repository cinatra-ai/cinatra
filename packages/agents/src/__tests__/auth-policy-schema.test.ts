// Tests for the widened AgentAuthPolicySchema.
//
// These tests assert that `AgentAuthPolicySchema` accepts the legacy visibility
// literals plus "workspace", `team:<uuid>`, and `project:<uuid>`. UUID-prefixed
// values must accept valid UUID tails and reject non-UUID tails; the tests assert
// the outcome, not a specific implementation.

import { describe, it, expect } from "vitest";
import { AgentAuthPolicySchema } from "../auth-policy-types";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

function policy(visibilityOverride: string) {
  return {
    runListVisibility: visibilityOverride,
    runDataVisibility: visibilityOverride,
    runExecuteVisibility: visibilityOverride,
    allowRunSharing: false,
  };
}

describe("AgentAuthPolicySchema visibility widening", () => {
  describe("legacy values remain valid (backward-compat)", () => {
    for (const v of ["owner", "org", "admin"] as const) {
      it(`accepts "${v}"`, () => {
        const result = AgentAuthPolicySchema.safeParse(policy(v));
        expect(result.success).toBe(true);
      });
    }
  });

  describe("new flat literal values", () => {
    it("accepts \"workspace\"", () => {
      const result = AgentAuthPolicySchema.safeParse(policy("workspace"));
      expect(result.success).toBe(true);
    });

    it("rejects case-different \"Workspace\"", () => {
      const result = AgentAuthPolicySchema.safeParse(policy("Workspace"));
      expect(result.success).toBe(false);
    });

    it("rejects unknown literal \"share-with-everyone\"", () => {
      const result = AgentAuthPolicySchema.safeParse(policy("share-with-everyone"));
      expect(result.success).toBe(false);
    });
  });

  describe("team:<uuid> prefix shape", () => {
    it(`accepts "team:${VALID_UUID}"`, () => {
      const result = AgentAuthPolicySchema.safeParse(policy(`team:${VALID_UUID}`));
      expect(result.success).toBe(true);
    });

    it("rejects empty tail \"team:\"", () => {
      const result = AgentAuthPolicySchema.safeParse(policy("team:"));
      expect(result.success).toBe(false);
    });

    it("rejects non-uuid tail \"team:not-a-uuid\"", () => {
      const result = AgentAuthPolicySchema.safeParse(policy("team:not-a-uuid"));
      expect(result.success).toBe(false);
    });

    it("rejects symbol-bearing tail \"team:abc!\"", () => {
      const result = AgentAuthPolicySchema.safeParse(policy("team:abc!"));
      expect(result.success).toBe(false);
    });
  });

  describe("project:<uuid> prefix shape", () => {
    it(`accepts "project:${VALID_UUID}"`, () => {
      const result = AgentAuthPolicySchema.safeParse(policy(`project:${VALID_UUID}`));
      expect(result.success).toBe(true);
    });

    it("rejects empty tail \"project:\"", () => {
      const result = AgentAuthPolicySchema.safeParse(policy("project:"));
      expect(result.success).toBe(false);
    });

    it("rejects non-uuid tail \"project:abc!\"", () => {
      const result = AgentAuthPolicySchema.safeParse(policy("project:abc!"));
      expect(result.success).toBe(false);
    });
  });

  describe("symmetry across the three visibility fields", () => {
    it("applies the same widened union to runDataVisibility", () => {
      const result = AgentAuthPolicySchema.safeParse({
        runListVisibility: "owner",
        runDataVisibility: `team:${VALID_UUID}`,
        runExecuteVisibility: "owner",
        allowRunSharing: false,
      });
      expect(result.success).toBe(true);
    });

    it("applies the same widened union to runExecuteVisibility", () => {
      const result = AgentAuthPolicySchema.safeParse({
        runListVisibility: "owner",
        runDataVisibility: "owner",
        runExecuteVisibility: `project:${VALID_UUID}`,
        allowRunSharing: true,
      });
      expect(result.success).toBe(true);
    });
  });
});
