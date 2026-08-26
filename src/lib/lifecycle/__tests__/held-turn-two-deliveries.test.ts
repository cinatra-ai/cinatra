// THE HELD-TURN CONTRACT, ON THE TWO DELIVERIES (cinatra#2930, epic #2926 W3).
//
// The plan's implementation note: "the held-turn contract … and the one-card
// gate are updated to the two deliveries."
//
// A delivery is WHO decided the card should be there. Until this wave a card
// reached a conversation only when a model called a tool for it, so the contract
// had nothing to say about it; the injected delivery is what makes the card the
// platform's rather than the model's, and the record is what lets a reader tell
// the two apart afterwards.

import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_CARD_CARRIAGE,
  LIFECYCLE_CARD_KINDS,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

import {
  CHAT_THREAD_CARRIAGE_CONTRACT,
  LIFECYCLE_CARD_DELIVERIES,
  carriageRowFor,
} from "../held-turn-card-contract";

describe("every ruled kind names its deliveries", () => {
  it("names at least one, from the closed set", () => {
    for (const kind of LIFECYCLE_CARD_KINDS) {
      const row = carriageRowFor(kind);
      expect(row.deliveries.length).toBeGreaterThan(0);
      for (const delivery of row.deliveries) {
        expect(LIFECYCLE_CARD_DELIVERIES).toContain(delivery);
      }
    }
  });

  it("gives EVERY kind the injected delivery — no card is a model's to withhold", () => {
    // This is the whole claim of the wave. A kind delivered only by a tool would
    // be a card that appears when a model feels like it.
    for (const kind of LIFECYCLE_CARD_KINDS) {
      expect(carriageRowFor(kind).deliveries).toContain("platform_injected");
    }
  });

  it("puts the injected delivery FIRST, because the plan does", () => {
    // "The 'show me' tools the model can call stay as a SECOND way to bring a
    // card back into view."
    for (const kind of LIFECYCLE_CARD_KINDS) {
      expect(carriageRowFor(kind).deliveries[0]).toBe("platform_injected");
    }
  });

  it("gives a re-presentable kind BOTH, and an INTERRUPT-carried kind only the injection", () => {
    // An interrupt carriage mints no resolve envelope, so no pull tool can bring
    // it back — saying it could would be a contract asserting a tool that does
    // not exist.
    for (const kind of LIFECYCLE_CARD_KINDS) {
      const row = carriageRowFor(kind);
      const representable = row.deliveries.includes("tool_represented");
      expect(representable).toBe(row.carriage === "data_part");
    }
  });
});

describe("the contract mirrors the protocol, never a second copy of it", () => {
  it("takes both carriage axes from the registry", () => {
    for (const row of CHAT_THREAD_CARRIAGE_CONTRACT) {
      expect(row.carriage).toBe(LIFECYCLE_CARD_CARRIAGE[row.kind].represent);
      expect(row.canonical).toBe(LIFECYCLE_CARD_CARRIAGE[row.kind].canonical);
    }
  });

  it("keeps the schedule the ONE kind whose canonical carriage is the part itself", () => {
    const canonicalIsPart = CHAT_THREAD_CARRIAGE_CONTRACT.filter(
      (r) => r.canonical === "data_part",
    ).map((r) => r.kind);
    expect(canonicalIsPart).toEqual(["trigger_schedule_proposal"]);
  });
});
