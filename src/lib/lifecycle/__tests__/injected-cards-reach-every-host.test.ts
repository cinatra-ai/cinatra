// EVERY HOST MOUNTS THE MOMENT'S CARD (cinatra#2930, epic #2926 W3).
//
// The plan: "Every host — the chat, a third-party application, the run page, the
// review page — mounts the moment's card from the run state the moment the
// coordinator signals it."
//
// WHAT THIS SUITE IS, AND IS NOT. The rendered observation of each cell belongs
// to the host-parity ratchet's own suites, which drive real host compositions
// and read roots off the DOM. What is pinned HERE is the JOIN this wave makes:
// the kinds the outbox injects are exactly the kinds every host already mounts,
// so an injected card has somewhere to land on all four — and the one kind that
// does not is recorded as owed, with the same tracking it had.

import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_CARD_KINDS,
  LIFECYCLE_RUN_CARRIED_KINDS,
  canonicalCarriageForKind,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

import { carriageRowFor } from "../held-turn-card-contract";
import {
  HOST_PROVIDER_TAG,
  LIFECYCLE_HOST_PARITY_RATCHET,
  TRANSCRIPT_HOSTS,
} from "../lifecycle-host-parity-ratchet";

const ALL_HOSTS = [
  "chat_thread",
  "site_widget",
  "run_card",
  "page_gate_region",
] as const;

describe("the kinds the run outbox injects", () => {
  for (const kind of ["artifact_review_gate", "verification_summary", "trigger_schedule_proposal"] as const) {
    it(`${kind} is mounted on all four hosts, so an injected card has somewhere to land`, () => {
      const row = LIFECYCLE_HOST_PARITY_RATCHET[kind];
      for (const host of ALL_HOSTS) {
        expect(Object.keys(row.hosts), `${kind} @ ${host}`).toContain(host);
      }
      expect(row.owed).toEqual([]);
    });
  }

  it("reaches the two conversation hosts through the ONE shared column", () => {
    // The chat and a third-party application are the same component, so the card
    // is drawn by one mount on both — which is what makes "no assistant tool
    // call in the transcript" one claim rather than two.
    expect([...TRANSCRIPT_HOSTS].sort()).toEqual(["chat_thread", "site_widget"]);
    expect(HOST_PROVIDER_TAG).toBe("LifecycleCardSurfaceProvider");
  });
});

describe("the run-carried kinds", () => {
  it("state that their truth is the run's own row", () => {
    for (const kind of LIFECYCLE_RUN_CARRIED_KINDS) {
      expect(canonicalCarriageForKind(kind)).toBe("run_state");
    }
  });

  it("mount from run state on the two hosts whose carriage is an INTERRUPT", () => {
    // `recommendation_hold` reaches all four already; its card is drawn at the
    // run's own dispatch part and resolves from the run, which is why it comes
    // back after a reload with no envelope of its own.
    const hold = LIFECYCLE_HOST_PARITY_RATCHET.recommendation_hold;
    for (const host of ALL_HOSTS) expect(Object.keys(hold.hosts)).toContain(host);
    expect(carriageRowFor("recommendation_hold").carriage).toBe("interrupt");
    expect(carriageRowFor("recommendation_hold").canonical).toBe("run_state");
  });
});

describe("the one kind with no mount yet", () => {
  it("is recorded as OWED, on every host the ruling gives it", () => {
    // Truthful record, not a waiver: this wave landed the kind's substrate — its
    // canonical carriage, the outbox feed and its delivery record — and did NOT
    // draw the card, because no ratified drawing covers it at the pinned design
    // commit and the anchor contract is digest-pinned to that commit.
    const row = LIFECYCLE_HOST_PARITY_RATCHET.agent_hitl_screen;
    expect(row.hosts).toEqual({});
    expect(row.owed.map((o) => o.host).sort()).toEqual([
      "chat_thread",
      "run_card",
      "site_widget",
    ]);
    for (const owed of row.owed) {
      expect(owed.tracking).toContain("cinatra#2930");
    }
  });

  it("still has the substrate a drawing slice would mount on", () => {
    expect(canonicalCarriageForKind("agent_hitl_screen")).toBe("run_state");
    expect(carriageRowFor("agent_hitl_screen").deliveries).toEqual(["platform_injected"]);
  });
});

describe("the ratchet still covers every kind", () => {
  it("has a row per kind, and no kind is nowhere", () => {
    for (const kind of LIFECYCLE_CARD_KINDS) {
      const row = LIFECYCLE_HOST_PARITY_RATCHET[kind];
      expect(row).toBeDefined();
      const owedHosts = row.owed.map((o) => o.host);
      expect(
        "chat_thread" in row.hosts || owedHosts.includes("chat_thread"),
        kind,
      ).toBe(true);
    }
  });
});
