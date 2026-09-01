/**
 * ONE display-name policy, not two.
 *
 * The Name screen used to declare its display-name schema inline, so a
 * non-browser caller could only re-derive it — and a re-derived "trim, at least
 * one character, at most 120" is a second validator that drifts the first time
 * the policy changes. The schema now lives in one module both callers import,
 * and these tests pin that: the policy itself, and the absence of a local copy
 * beside either caller.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  INSTANCE_DISPLAY_NAME_MAX_LENGTH,
  instanceDisplayNameSchema,
  parseInstanceDisplayName,
} from "@/lib/instance-identity-display-name";

const ROOT = path.resolve(__dirname, "..", "..", "..");

describe("the instance display-name policy", () => {
  it("requires a name, trims it, and caps it at the documented length", () => {
    expect(parseInstanceDisplayName("  Acme Development  ")).toEqual({
      ok: true,
      instanceDisplayName: "Acme Development",
    });
    expect(parseInstanceDisplayName("   ").ok).toBe(false);
    expect(parseInstanceDisplayName("").ok).toBe(false);
    expect(parseInstanceDisplayName("a".repeat(INSTANCE_DISPLAY_NAME_MAX_LENGTH)).ok).toBe(true);
    expect(parseInstanceDisplayName("a".repeat(INSTANCE_DISPLAY_NAME_MAX_LENGTH + 1)).ok).toBe(
      false,
    );
  });

  it("is the SAME schema the screen parses with", () => {
    expect(
      instanceDisplayNameSchema.safeParse({ instanceDisplayName: " Acme " }).success,
    ).toBe(true);
    expect(
      instanceDisplayNameSchema.safeParse({
        instanceDisplayName: "a".repeat(INSTANCE_DISPLAY_NAME_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("has no second copy beside either caller", () => {
    const callers = [
      "src/app/setup/name/actions.ts",
      "src/lib/dev-instance-provisioning/provision-namespace.ts",
    ];
    for (const caller of callers) {
      const source = readFileSync(path.join(ROOT, caller), "utf8");
      expect(source).toContain("@/lib/instance-identity-display-name");
      expect(source).not.toContain("const instanceDisplayNameSchema =");
      // The old hand-rolled bound, in either caller, is what this pins out.
      expect(source).not.toContain("length > 120");
    }
  });
});
