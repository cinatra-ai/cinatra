// Marketplace approval state -> roster status pill (cinatra#4296).
//
// The application drawing's "Marketplace approval states" block maps every
// state of a vendor application or an extension submission to one roster pill
// and says: "none rides on a Badge, and the pill's own label is shown, never
// the raw state word."
import { describe, expect, it } from "vitest";

import { marketplaceStatePill, viewerMayDecide } from "../marketplace-state";

describe("marketplaceStatePill — one pill per drawn state", () => {
  it.each(["applied", "pending"])(
    "draws '%s' the viewer may decide as the hold pill with a dot, labelled Awaiting you",
    (state) => {
      expect(marketplaceStatePill(state, { viewerMayDecide: true })).toEqual({
        status: "hold",
        label: "Awaiting you",
        glyph: "dot",
      });
    },
  );

  it.each(["applied", "pending"])(
    "draws '%s' the viewer may not decide as the idle pill with a dot, labelled Awaiting others",
    (state) => {
      expect(marketplaceStatePill(state, { viewerMayDecide: false })).toEqual({
        status: "idle",
        label: "Awaiting others",
        glyph: "dot",
      });
    },
  );

  it.each([
    ["approved", "approved", "Approved"],
    ["promoted", "approved", "Approved"],
    ["rejected", "declined", "Declined"],
    ["withdrawn", "withdrawn", "Withdrawn"],
    ["cancelled", "withdrawn", "Withdrawn"],
    ["reset", "reset", "Reset"],
    ["superseded", "archived", "Archived"],
  ] as const)("draws '%s' as the %s roster pill labelled %s", (state, status, label) => {
    for (const mayDecide of [true, false]) {
      expect(marketplaceStatePill(state, { viewerMayDecide: mayDecide })).toEqual({
        status,
        label,
        glyph: "icon",
      });
    }
  });

  it("never shows the raw state word for a state the drawing does not name", () => {
    const pill = marketplaceStatePill("some_new_state", { viewerMayDecide: true });
    expect(pill.status).toBe("idle");
    expect(pill.label).not.toContain("some_new_state");
    expect(pill.glyph).toBe("icon");
  });
});

describe("marketplaceStatePill — state matching is exact", () => {
  it.each(["Applied", "PENDING", "Approved", " applied", ""])(
    "draws the case- or space-varied state %j as the neutral Unknown pill, not as its drawn state",
    (state) => {
      expect(marketplaceStatePill(state, { viewerMayDecide: true })).toEqual({
        status: "idle",
        label: "Unknown",
        glyph: "icon",
      });
    },
  );
});

describe("viewerMayDecide — the moderation row's eligibility", () => {
  it("is true when the marketplace sends no eligibility (action-time enforcement)", () => {
    expect(viewerMayDecide(undefined)).toBe(true);
    expect(viewerMayDecide({})).toBe(true);
  });

  it("stays true while one decision is still open to the viewer", () => {
    expect(viewerMayDecide({ can_approve: false, can_reject: true })).toBe(true);
    expect(viewerMayDecide({ can_approve: false })).toBe(true);
  });

  it("treats an empty eligibility object and a lone can_reject false as still open", () => {
    expect(viewerMayDecide({})).toBe(true);
    expect(viewerMayDecide({ can_reject: false })).toBe(true);
    expect(viewerMayDecide({ can_approve: true, can_reject: false })).toBe(true);
  });

  it("is false when the viewer may neither approve nor reject", () => {
    expect(viewerMayDecide({ can_approve: false, can_reject: false, reason: "SoD" })).toBe(false);
  });
});
