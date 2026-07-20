// Tests for the widened AgentAuthPolicySchema.
//
// These tests assert that `AgentAuthPolicySchema` accepts the legacy visibility
// literals plus "workspace" and the `org:`/`team:`/`project:` prefixed tokens.
// Tails follow ONE bounded-opaque grammar (cinatra#1907, owner-ratified):
// 1–64 URL-safe chars ([A-Za-z0-9_-]) — format-agnostic across UUIDs, legacy
// 32-char better-auth ids, and the seeded `org-*`/`team-*`/`proj-*` namespace —
// while whitespace, colons, slashes and control characters never validate. The
// tests assert the outcome, not a specific implementation.

import { describe, it, expect } from "vitest";
import {
  AgentAuthPolicySchema,
  AgentAuthPolicyVisibilitySelectionSchema,
  normalizeVisibilitySelection,
  isExactlyOwner,
  type AgentAuthPolicyVisibility,
} from "../auth-policy-types";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_UUID_2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

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

    it("accepts an opaque non-uuid tail \"team:not-a-uuid\" (DELIBERATE, #1907 grammar)", () => {
      const result = AgentAuthPolicySchema.safeParse(policy("team:not-a-uuid"));
      expect(result.success).toBe(true);
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

  // cinatra#1907 (owner-ratified): tails are format-agnostic behind one
  // bounded URL-safe grammar. Live id shapes that must all validate: UUIDs,
  // legacy 32-char base62 better-auth ids (real rejected ids from the issue),
  // and the supported seed namespace the permissions picker offers.
  describe("bounded-opaque tails (#1907 grammar)", () => {
    const LEGACY_ORG_ID = "Ul5HrhxiVFOBJmghOIUWjptssxRMaRXs";
    const LEGACY_TEAM_ID = "bgEWkNFcoODy5NtsIxvPaM1F0lww7GSR";

    it("accepts legacy better-auth ids on all three prefixes", () => {
      expect(AgentAuthPolicySchema.safeParse(policy(`org:${LEGACY_ORG_ID}`)).success).toBe(true);
      expect(AgentAuthPolicySchema.safeParse(policy(`team:${LEGACY_TEAM_ID}`)).success).toBe(true);
      expect(AgentAuthPolicySchema.safeParse(policy(`project:${LEGACY_ORG_ID}`)).success).toBe(true);
    });

    it("accepts the seeded id namespace (proj-*/org-*/team-*)", () => {
      expect(AgentAuthPolicySchema.safeParse(policy("project:proj-cinatra-discovery")).success).toBe(true);
      expect(AgentAuthPolicySchema.safeParse(policy("org:org-acme-robotics")).success).toBe(true);
      expect(AgentAuthPolicySchema.safeParse(policy("team:team-mobility-1")).success).toBe(true);
    });

    it("accepts underscores (URL-safe charset)", () => {
      expect(AgentAuthPolicySchema.safeParse(policy("team:some_team_id")).success).toBe(true);
    });

    it("boundary lengths: rejects 0, accepts 1 and 64, rejects 65", () => {
      expect(AgentAuthPolicySchema.safeParse(policy("org:")).success).toBe(false);
      expect(AgentAuthPolicySchema.safeParse(policy("org:a")).success).toBe(true);
      expect(AgentAuthPolicySchema.safeParse(policy(`org:${"a".repeat(64)}`)).success).toBe(true);
      expect(AgentAuthPolicySchema.safeParse(policy(`org:${"a".repeat(65)}`)).success).toBe(false);
    });

    it("rejects whitespace, colon, slash, quote, and control/bidi characters", () => {
      for (const tail of ["a b", "a:b", "a/b", 'a"b', "a\u00a0b", "a\u202eb", " a", "a\ttab"]) {
        expect(
          AgentAuthPolicySchema.safeParse(policy(`team:${tail}`)).success,
          JSON.stringify(tail),
        ).toBe(false);
      }
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

// ---------------------------------------------------------------------------
// Multi-scope W1: selection = NON-EMPTY token array; stored scalars coerce.
// ---------------------------------------------------------------------------

describe("AgentAuthPolicy selection: scalar → array coercion (backward-compat)", () => {
  it("coerces a stored scalar visibility to a one-element array on read", () => {
    const result = AgentAuthPolicySchema.safeParse(policy("owner"));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runListVisibility).toEqual(["owner"]);
      expect(result.data.runDataVisibility).toEqual(["owner"]);
      expect(result.data.runExecuteVisibility).toEqual(["owner"]);
    }
  });

  it("coerces a scalar org:<uuid> token to a one-element array", () => {
    const result = AgentAuthPolicySchema.safeParse(policy(`org:${VALID_UUID}`));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runListVisibility).toEqual([`org:${VALID_UUID}`]);
    }
  });

  it("accepts an explicit multi-token array and preserves order", () => {
    const result = AgentAuthPolicySchema.safeParse({
      runListVisibility: [`team:${VALID_UUID}`, `org:${VALID_UUID_2}`],
      runDataVisibility: "owner",
      runExecuteVisibility: ["admin"],
      allowRunSharing: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runListVisibility).toEqual([
        `team:${VALID_UUID}`,
        `org:${VALID_UUID_2}`,
      ]);
      expect(result.data.runExecuteVisibility).toEqual(["admin"]);
    }
  });

  it("rejects an EMPTY array (non-empty enforced)", () => {
    const result = AgentAuthPolicySchema.safeParse({
      runListVisibility: [],
      runDataVisibility: "owner",
      runExecuteVisibility: "owner",
      allowRunSharing: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an array containing an invalid token", () => {
    const result = AgentAuthPolicySchema.safeParse({
      runListVisibility: ["owner", "share-with-everyone"],
      runDataVisibility: "owner",
      runExecuteVisibility: "owner",
      allowRunSharing: false,
    });
    expect(result.success).toBe(false);
  });

  it("the selection schema alone coerces a bare scalar", () => {
    const result = AgentAuthPolicyVisibilitySelectionSchema.safeParse("workspace");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(["workspace"]);
  });
});

describe("normalizeVisibilitySelection invariants", () => {
  const TEAM_X: AgentAuthPolicyVisibility = `team:${VALID_UUID}`;
  const TEAM_Y: AgentAuthPolicyVisibility = `team:${VALID_UUID_2}`;
  const ORG_A: AgentAuthPolicyVisibility = `org:${VALID_UUID}`;
  const PROJ_P: AgentAuthPolicyVisibility = `project:${VALID_UUID}`;

  it("dedupes, preserving first-seen order", () => {
    expect(normalizeVisibilitySelection([TEAM_X, TEAM_Y, TEAM_X])).toEqual([
      TEAM_X,
      TEAM_Y,
    ]);
  });

  it("workspace present ⇒ selection is exactly [\"workspace\"]", () => {
    expect(normalizeVisibilitySelection(["workspace", TEAM_X])).toEqual([
      "workspace",
    ]);
    expect(normalizeVisibilitySelection(["owner", "workspace"])).toEqual([
      "workspace",
    ]);
  });

  it("strips owner when mixed with a broader token", () => {
    expect(normalizeVisibilitySelection(["owner", TEAM_X])).toEqual([TEAM_X]);
    expect(normalizeVisibilitySelection(["owner", "admin", TEAM_X])).toEqual([
      "admin",
      TEAM_X,
    ]);
  });

  it("keeps owner-only as [\"owner\"]", () => {
    expect(normalizeVisibilitySelection(["owner"])).toEqual(["owner"]);
    expect(normalizeVisibilitySelection(["owner", "owner"])).toEqual(["owner"]);
  });

  it("admin is mixable (never stripped)", () => {
    expect(normalizeVisibilitySelection(["admin", TEAM_X])).toEqual([
      "admin",
      TEAM_X,
    ]);
    expect(normalizeVisibilitySelection(["admin"])).toEqual(["admin"]);
  });

  it("NO upward collapse: an explicit team/project set is never rewritten to org", () => {
    expect(normalizeVisibilitySelection([TEAM_X, ORG_A])).toEqual([TEAM_X, ORG_A]);
    expect(normalizeVisibilitySelection([TEAM_X, PROJ_P])).toEqual([TEAM_X, PROJ_P]);
  });

  it("does not strip org-implied team tokens (they coexist)", () => {
    expect(normalizeVisibilitySelection([ORG_A, TEAM_X])).toEqual([ORG_A, TEAM_X]);
  });

  it("is ALWAYS non-empty (empty or all-owner input yields [\"owner\"])", () => {
    expect(normalizeVisibilitySelection([])).toEqual(["owner"]);
    expect(normalizeVisibilitySelection(["owner"])).toEqual(["owner"]);
  });
});

describe("isExactlyOwner", () => {
  it("true only for the single-element [\"owner\"]", () => {
    expect(isExactlyOwner(["owner"])).toBe(true);
  });

  it("false for owner mixed with other tokens", () => {
    expect(isExactlyOwner(["owner", "admin"])).toBe(false);
    expect(isExactlyOwner([`team:${VALID_UUID}`])).toBe(false);
    expect(isExactlyOwner(["admin"])).toBe(false);
    expect(isExactlyOwner([])).toBe(false);
  });
});
