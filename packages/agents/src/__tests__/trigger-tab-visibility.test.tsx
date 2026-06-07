/**
 * Trigger tab visibility unit coverage.
 *
 * Locks the visibility rule per DESIGN.md §"Two Distinct Surfaces":
 *   - row exists AND triggerType IN ('scheduled','recurring') → persistent tab
 *   - otherwise → first-step form
 *
 * Tested in isolation via the exported `shouldShowPersistentTab` helper, so
 * the rule is independent of DB / auth / Next.js render machinery.
 *
 * Run:
 *   cd packages/agent-builder && pnpm exec vitest run src/__tests__/trigger-tab-visibility.test.tsx
 */
import { describe, expect, it } from "vitest";

import { shouldShowPersistentTab } from "../instance-screens";

describe("shouldShowPersistentTab", () => {
  it("returns false for null trigger (no row)", () => {
    expect(shouldShowPersistentTab(null)).toBe(false);
  });

  it("returns false for triggerType === 'immediate'", () => {
    expect(shouldShowPersistentTab({ triggerType: "immediate" })).toBe(false);
  });

  it("returns true for triggerType === 'scheduled'", () => {
    expect(shouldShowPersistentTab({ triggerType: "scheduled" })).toBe(true);
  });

  it("returns true for triggerType === 'recurring'", () => {
    expect(shouldShowPersistentTab({ triggerType: "recurring" })).toBe(true);
  });

  it("returns false for an unknown / future triggerType (defensive)", () => {
    expect(shouldShowPersistentTab({ triggerType: "webhook" })).toBe(false);
  });
});
