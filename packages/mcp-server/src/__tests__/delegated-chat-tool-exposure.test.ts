// Selective chat tool EXPOSURE (cinatra#2771 lever 1).
//
// What this suite pins:
//   1. the topic map is a TOTAL, DISJOINT partition of the chat allowlist —
//      so a later change to the allowlist SOURCE shows up as a failing test
//      rather than as a tool that silently stopped being exposed;
//   2. exposure is always a SUBSET of the allowlist — it can never widen reach,
//      whatever the map says;
//   3. a trivial turn carries the core floor only, not the whole catalog;
//   4. the full catalog stays REACHABLE — by keyword, by the plain-language
//      "all tools" phrase, and by the operator mode switch;
//   5. the result is byte-stable and canonically ordered, which is what lets
//      the tool block participate in the provider prefix cache.

import { describe, expect, it } from "vitest";

import {
  delegatedChatAllowedToolNames,
  isDelegatedChatMcpToolAllowed,
} from "../delegated-chat-tool-policy";
import {
  CHAT_TOOL_TOPICS,
  delegatedChatToolTierOf,
  isCoreServedConversation,
  overclaimedDelegatedChatToolNames,
  resolveChatToolExposureMode,
  resolveDelegatedChatToolExposure,
  selectChatToolTopics,
  unclassifiedDelegatedChatToolNames,
} from "../delegated-chat-tool-exposure";

const ALL = delegatedChatAllowedToolNames();

/** A question that needs no platform tool at all. */
const TRIVIAL_TURN = ["hi", "hello", "thanks"];

describe("the topic map partitions the chat allowlist", () => {
  it("classifies every allowed tool (no drift)", () => {
    expect(unclassifiedDelegatedChatToolNames()).toEqual([]);
  });

  it("claims no tool the policy would refuse", () => {
    expect(overclaimedDelegatedChatToolNames()).toEqual([]);
  });

  it("assigns each allowed tool exactly one tier", () => {
    for (const name of ALL) {
      expect(delegatedChatToolTierOf(name)).not.toBeNull();
    }
  });

  it("answers null for a name the policy refuses", () => {
    expect(delegatedChatToolTierOf("objects_delete")).toBeNull();
    expect(delegatedChatToolTierOf("permissions_grant")).toBeNull();
  });

  it("core + every topic together IS the whole allowlist (nothing unreachable)", () => {
    const everything = resolveDelegatedChatToolExposure({
      conversationText: ["show me all tools"],
    });
    expect([...everything.toolNames]).toEqual([...ALL]);
    expect([...everything.topics]).toEqual([...CHAT_TOOL_TOPICS]);
  });
});

describe("a trivial turn no longer carries the whole catalog", () => {
  const exposure = resolveDelegatedChatToolExposure({
    conversationText: TRIVIAL_TURN,
  });

  it("selects no topic", () => {
    expect(exposure.topics).toEqual([]);
  });

  it("exposes strictly fewer tools than the full allowlist", () => {
    expect(exposure.toolNames.length).toBeLessThan(ALL.length);
    // The floor is meant to be a small fraction of the catalog, not a rename
    // of it. Half is a deliberately loose ceiling: it fails a change that
    // quietly promotes most of the catalog into core, without pinning an exact
    // count that every future allowlist edit would have to re-baseline.
    expect(exposure.toolNames.length).toBeLessThan(ALL.length / 2);
  });

  it("still carries the discovery + dispatch + poll floor the chat exists for", () => {
    for (const name of [
      "agent_list",
      "agent_run",
      "agent_run_get",
      "connector_inventory_list",
      "system_screen_lookup",
      "objects_list",
    ]) {
      expect(exposure.toolNames).toContain(name);
    }
  });

  it("drops the topical catalogs it cannot use", () => {
    for (const name of [
      "dashboards_cube_load",
      "crm_contact_search",
      "metric_cost_summary",
      "artifact_representation_list",
      "wordpress_site_tool_call",
    ]) {
      expect(exposure.toolNames).not.toContain(name);
    }
  });

  it("answers the issue's own repro question without the catalog", () => {
    // "which connectors are active?" — the inventory read is core, and nothing
    // topical is pulled in with it.
    const repro = resolveDelegatedChatToolExposure({
      conversationText: ["which connectors are active?"],
    });
    expect(repro.toolNames).toContain("connector_inventory_list");
    expect(repro.topics).toEqual([]);
  });
});

describe("a turn that DOES need tools still reaches them", () => {
  it("pulls the dashboards catalog in on a dashboard question", () => {
    const exposure = resolveDelegatedChatToolExposure({
      conversationText: ["build me a dashboard of pipeline by stage"],
    });
    expect(exposure.topics).toContain("dashboards");
    expect(exposure.toolNames).toContain("dashboards_cube_load");
    expect(exposure.toolNames).toContain("dashboards_create");
  });

  it("pulls the metrics catalog in on a spend question", () => {
    const exposure = resolveDelegatedChatToolExposure({
      conversationText: ["how much did we spend on LLM calls this week?"],
    });
    expect(exposure.topics).toContain("observability");
    expect(exposure.toolNames).toContain("metric_cost_summary");
  });

  it("is STICKY — a topic raised earlier survives a later trivial message", () => {
    const later = resolveDelegatedChatToolExposure({
      conversationText: [
        "show me the CRM contacts for Acme",
        "Here they are.",
        "thanks",
      ],
    });
    expect(later.topics).toContain("crm");
    expect(later.toolNames).toContain("crm_contact_search");
  });

  it("accumulates topics across a multi-topic conversation", () => {
    const exposure = resolveDelegatedChatToolExposure({
      conversationText: [
        "which skills are installed?",
        "now chart our campaign spend",
      ],
    });
    expect(exposure.topics).toEqual(
      expect.arrayContaining(["skills", "dashboards", "marketing", "observability"]),
    );
  });

  it("mode 'full' restores exactly the pre-#2771 catalog", () => {
    const exposure = resolveDelegatedChatToolExposure({
      conversationText: TRIVIAL_TURN,
      mode: "full",
    });
    expect([...exposure.toolNames]).toEqual([...ALL]);
  });

  it("reads the operator escape hatch from the environment", () => {
    expect(resolveChatToolExposureMode({})).toBe("tiered");
    expect(resolveChatToolExposureMode({ CINATRA_CHAT_TOOL_EXPOSURE: "full" })).toBe("full");
    expect(resolveChatToolExposureMode({ CINATRA_CHAT_TOOL_EXPOSURE: " FULL " })).toBe("full");
    expect(resolveChatToolExposureMode({ CINATRA_CHAT_TOOL_EXPOSURE: "tiered" })).toBe("tiered");
    expect(resolveChatToolExposureMode({ CINATRA_CHAT_TOOL_EXPOSURE: "yes" })).toBe("tiered");
  });
});

describe("exposure never widens reach", () => {
  const conversations: string[][] = [
    TRIVIAL_TURN,
    ["delete every contact and purge the extension"],
    ["dashboard cube crm skills artifact campaign wordpress cost review purge"],
    [""],
  ];

  it("every emitted name is chat-allowed", () => {
    for (const conversationText of conversations) {
      const { toolNames } = resolveDelegatedChatToolExposure({ conversationText });
      for (const name of toolNames) {
        expect(isDelegatedChatMcpToolAllowed(name)).toBe(true);
      }
    }
  });

  it("never emits a name outside the allowlist, in any mode", () => {
    const allowed = new Set(ALL);
    for (const mode of ["tiered", "full"] as const) {
      for (const conversationText of conversations) {
        const { toolNames } = resolveDelegatedChatToolExposure({ conversationText, mode });
        for (const name of toolNames) expect(allowed.has(name)).toBe(true);
      }
    }
  });
});

describe("the exposure list is canonical (prefix-cache friendly)", () => {
  it("is sorted and de-duplicated", () => {
    const { toolNames } = resolveDelegatedChatToolExposure({
      conversationText: ["dashboard and crm and dashboards again"],
    });
    expect([...toolNames]).toEqual([...new Set(toolNames)].sort());
  });

  it("is byte-identical for the same conversation, built twice", () => {
    const build = () =>
      JSON.stringify(
        resolveDelegatedChatToolExposure({
          conversationText: ["how much did we spend on agents?"],
        }),
      );
    expect(build()).toBe(build());
  });

  it("is byte-identical for two turns that raise the same topic differently", () => {
    const a = resolveDelegatedChatToolExposure({
      conversationText: ["show me the dashboard"],
    });
    const b = resolveDelegatedChatToolExposure({
      conversationText: ["open a different dashboard, please"],
    });
    expect(a.toolNames.join("\n")).toBe(b.toolNames.join("\n"));
  });

  it("reports topics in the declared canonical order", () => {
    const topics = selectChatToolTopics(["crm dashboard skills artifact"]);
    const canonical = CHAT_TOOL_TOPICS.filter((t) => topics.includes(t));
    expect([...topics]).toEqual([...canonical]);
  });

  it("matches whole word tokens, never substrings", () => {
    // "listen" must not select anything, and "wp" inside "swap" must not
    // select the sites topic.
    expect(selectChatToolTopics(["listen to the swapping crment"])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FAIL OPEN ON EXPOSURE (codex round-1, finding 1).
//
// A finite keyword vocabulary cannot recognise every phrasing. Narrowing an
// unrecognised turn to the core floor would take a tool away from the model,
// which is a behaviour regression; paying for schemas is only a cost. So an
// unrecognised SUBSTANTIVE turn keeps the whole pre-#2771 catalog, and only a
// turn the core floor demonstrably serves is narrowed.
// ---------------------------------------------------------------------------
describe("an unrecognised substantive turn keeps the whole catalog", () => {
  const unrecognised = [
    "find Jane Doe",
    "plot revenue by month",
    "show me the latest record for that person",
    "what happened with the Berlin thing yesterday",
    "summarise the quarterly numbers",
    "who signed the renewal",
  ];

  it.each(unrecognised)("%s → the full allowlist, not the core floor", (text) => {
    const exposure = resolveDelegatedChatToolExposure({ conversationText: [text] });
    // Either a topic matched (fine — it reaches the tools), or nothing did and
    // the resolver failed OPEN. What must never happen is a narrow core-only
    // answer to a request the vocabulary did not understand.
    if (exposure.reason === "unrecognized_fail_open") {
      expect([...exposure.toolNames]).toEqual([...ALL]);
    } else {
      expect(exposure.reason).toBe("topic_match");
    }
    expect(exposure.reason).not.toBe("core_served");
  });

  it("narrows ONLY on small talk or core-vocabulary questions", () => {
    for (const text of ["hi", "thanks!", "which connectors are active?", "list my agents", "is the run done?"]) {
      const exposure = resolveDelegatedChatToolExposure({ conversationText: [text] });
      expect(exposure.reason).toBe("core_served");
      expect(exposure.toolNames.length).toBeLessThan(ALL.length);
    }
  });

  it("classifies the core-served set directly", () => {
    expect(isCoreServedConversation([])).toBe(true);
    expect(isCoreServedConversation(["hey there"])).toBe(true);
    expect(isCoreServedConversation(["which connectors are connected?"])).toBe(true);
    expect(isCoreServedConversation(["find Jane Doe"])).toBe(false);
    expect(isCoreServedConversation(["plot revenue by month"])).toBe(false);
  });

  it("names its reason on every path", () => {
    expect(
      resolveDelegatedChatToolExposure({ conversationText: ["hi"] }).reason,
    ).toBe("core_served");
    expect(
      resolveDelegatedChatToolExposure({ conversationText: ["show the dashboard"] }).reason,
    ).toBe("topic_match");
    expect(
      resolveDelegatedChatToolExposure({ conversationText: ["find Jane Doe"] }).reason,
    ).toBe("unrecognized_fail_open");
    expect(
      resolveDelegatedChatToolExposure({ conversationText: ["hi"], mode: "full" }).reason,
    ).toBe("mode_full");
  });

  it("a fail-open turn is still canonical (sorted, subset, byte-stable)", () => {
    const a = resolveDelegatedChatToolExposure({ conversationText: ["find Jane Doe"] });
    const b = resolveDelegatedChatToolExposure({ conversationText: ["find Jane Doe"] });
    expect(a.toolNames.join("\n")).toBe(b.toolNames.join("\n"));
    expect([...a.toolNames]).toEqual([...new Set(a.toolNames)].sort());
  });
});
