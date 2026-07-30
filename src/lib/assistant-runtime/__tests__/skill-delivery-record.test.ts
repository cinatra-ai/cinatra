// cinatra#2240 — the per-turn skill-delivery RECORD builder.
//
// THE GAP THIS PINS (finding F8 of the #2094 S7 acceptance E2E): a chat turn
// delivered skills to a provider and wrote NOTHING durable, so "which skills did
// this run actually get, via which vehicle?" was answerable only by capturing
// the wire. These cases pin the record's TRUTHFULNESS for every vehicle the
// runtime can use plus the loud no-vehicle refusal:
//
//   container-skills — Anthropic `container.skills`, WITH the provider skill id
//                      and version actually named on the wire;
//   tool-mount       — the OpenAI native/`skill_file_read` mount;
//   inline           — the Gemini/personal-delta system-prompt vehicle;
//   refused          — cinatra#2094 F11's loud no-vehicle path, where EVERY
//                      resolved skill is recorded as lost, not silently absent.
//
// And the distinction the store must never blur: a DROP (cap, budget,
// rank-and-truncate, unmountable) is not a refusal.

import { describe, expect, it } from "vitest";

import {
  buildTurnSkillDeliveryRows,
  vehicleForDeliveryMode,
} from "../skill-delivery-record";

const rowFor = (rows: ReturnType<typeof buildTurnSkillDeliveryRows>, skillId: string) => {
  const row = rows.find((r) => r.skillId === skillId);
  expect(row, `no record row for ${skillId}`).toBeDefined();
  return row!;
};

describe("vehicleForDeliveryMode", () => {
  it("maps every shipped delivery mode onto an operator-facing vehicle", () => {
    expect(vehicleForDeliveryMode("anthropic_container")).toBe("container-skills");
    expect(vehicleForDeliveryMode("openai_shell")).toBe("tool-mount");
    expect(vehicleForDeliveryMode("gemini_inline")).toBe("inline");
    expect(vehicleForDeliveryMode("personal_inline")).toBe("inline");
  });

  it("refuses to name a vehicle for a mode this build does not know", () => {
    // Fabricating a transport for an unrecognised mode would put a false claim
    // in an audit record. Null forces the caller into the fail-honest branch.
    expect(vehicleForDeliveryMode("some_future_mode")).toBeNull();
  });
});

describe("an adapter-reported mode this build cannot classify FAILS HONEST", () => {
  // A delivery adapter is an EXTENSION surface (llm-providers S4.x), so a
  // connector can legitimately report a mode this core build has no vehicle
  // name for. The skill WAS delivered; demoting it to a drop would be a false
  // audit fact, and guessing a transport would be worse.
  it("keeps the row DELIVERED, marks the vehicle unknown, and preserves the raw mode", () => {
    const rows = buildTurnSkillDeliveryRows({
      provider: "openai",
      requestedSkillIds: ["@cinatra-ai/a"],
      exposure: [
        {
          skillId: "@cinatra-ai/a",
          deliveryMode: "some_future_mode" as never,
          invocationAttributable: false,
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "delivered",
      vehicle: "unknown",
      deliveryMode: "some_future_mode",
      nonDeliveryReason: null,
    });
  });
});

describe("a MALFORMED adapter exposure entry cannot corrupt the whole record", () => {
  // The record is written as ONE statement, so a row that violates the table's
  // mode biconditional ((outcome='delivered') = (delivery_mode IS NOT NULL))
  // does not just lose itself — the constraint error loses EVERY row for the
  // turn. A delivery adapter is an EXTENSION surface, so a nullish or blank
  // `deliveryMode` is reachable despite the `string` type.
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a blank string", ""],
    ["whitespace", "   "],
  ])("keeps the row REPRESENTABLE when the adapter reports %s as the mode", (_label, mode) => {
    const rows = buildTurnSkillDeliveryRows({
      provider: "openai",
      requestedSkillIds: ["@cinatra-ai/a", "@cinatra-ai/b"],
      exposure: [
        { skillId: "@cinatra-ai/a", deliveryMode: mode as never, invocationAttributable: true },
        { skillId: "@cinatra-ai/b", deliveryMode: "openai_shell", invocationAttributable: true },
      ],
    });

    const malformed = rowFor(rows, "@cinatra-ai/a");
    expect(malformed).toMatchObject({
      outcome: "delivered",
      vehicle: "unknown",
      deliveryMode: "unknown",
      nonDeliveryReason: null,
    });
    // The biconditionals hold for EVERY row, so the single statement survives
    // and the healthy sibling row is not collateral damage.
    for (const row of rows) {
      const delivered = row.outcome === "delivered";
      expect(row.vehicle !== null).toBe(delivered);
      expect(row.deliveryMode !== null).toBe(delivered);
      expect(row.nonDeliveryReason === null).toBe(delivered);
    }
    expect(rowFor(rows, "@cinatra-ai/b").vehicle).toBe("tool-mount");
  });

  it("drops an UNNAMED exposure entry rather than letting it abort the whole record", () => {
    // `skill_id` is `text NOT NULL` and half the primary key, and the record is
    // ONE statement — so a single nullish id would take every OTHER skill's row
    // down with it. The named skills must survive.
    const rows = buildTurnSkillDeliveryRows({
      provider: "openai",
      requestedSkillIds: ["@cinatra-ai/a"],
      exposure: [
        { skillId: null as never, deliveryMode: "openai_shell", invocationAttributable: true },
        { skillId: "   " as never, deliveryMode: "openai_shell", invocationAttributable: true },
        { skillId: "@cinatra-ai/a", deliveryMode: "openai_shell", invocationAttributable: true },
      ],
    });

    expect(rows.map((r) => r.skillId)).toEqual(["@cinatra-ai/a"]);
    expect(rows[0].outcome).toBe("delivered");
    for (const row of rows) expect(row.skillId.trim()).not.toBe("");
  });

  it("drops unnamed ids from every OTHER channel too", () => {
    const rows = buildTurnSkillDeliveryRows({
      provider: "openai",
      requestedSkillIds: ["@cinatra-ai/a", "" as never, null as never],
      exposure: [],
      contractDrops: [
        { skillId: "", reason: "blank" },
        { skillId: null as never, reason: "nullish" },
      ],
      adapterDroppedSkillIds: ["", null as never],
    });

    expect(rows.map((r) => r.skillId)).toEqual(["@cinatra-ai/a"]);
  });

  it("normalises a non-boolean invocationAttributable to null rather than undefined", () => {
    const rows = buildTurnSkillDeliveryRows({
      provider: "openai",
      requestedSkillIds: ["@cinatra-ai/a"],
      exposure: [
        {
          skillId: "@cinatra-ai/a",
          deliveryMode: "openai_shell",
          invocationAttributable: undefined as never,
        },
      ],
    });
    expect(rows[0].invocationAttributable).toBeNull();
  });
});

describe("a drop channel that names a skill WITHOUT a reason still gets a row", () => {
  // The ids a channel dropped and the reasons it gave are DIFFERENT sets. Only
  // reasoned drops land in the reason map, so sweeping the map instead of the
  // id set would lose a blank-reason drop entirely — the finding-F8 shape.
  it("records it as a drop with the synthesized reason, even when the resolved set never named it", () => {
    const rows = buildTurnSkillDeliveryRows({
      provider: "openai",
      requestedSkillIds: ["@cinatra-ai/kept"],
      exposure: [
        { skillId: "@cinatra-ai/kept", deliveryMode: "openai_shell", invocationAttributable: true },
      ],
      // Named by the channel, blank reason, and NOT in the resolved set.
      contractDrops: [{ skillId: "@cinatra-ai/silent", reason: "" }],
    });

    expect(rows).toHaveLength(2);
    expect(rowFor(rows, "@cinatra-ai/silent")).toMatchObject({
      outcome: "dropped",
      vehicle: null,
      deliveryMode: null,
    });
    expect(rowFor(rows, "@cinatra-ai/silent").nonDeliveryReason).toBeTruthy();
  });

  it("under a REFUSAL it stays a DROP — a drop is never relabelled 'refused'", () => {
    // Skipping the refusal only for skills with a REASON would mislabel this
    // one, misattributing a cap loss to the no-vehicle refusal.
    const rows = buildTurnSkillDeliveryRows({
      provider: "openai",
      requestedSkillIds: ["@cinatra-ai/kept", "@cinatra-ai/blank"],
      exposure: [],
      contractDrops: [{ skillId: "@cinatra-ai/blank", reason: "" }],
      refusalReason: "no vehicle",
    });

    expect(rowFor(rows, "@cinatra-ai/kept").outcome).toBe("refused");
    expect(rowFor(rows, "@cinatra-ai/blank").outcome).toBe("dropped");
    expect(rowFor(rows, "@cinatra-ai/blank").nonDeliveryReason).toBeTruthy();
  });
});

describe("a delivered skill OUTSIDE the resolved set is still recorded", () => {
  it("records an exposure the adapter reported but the turn never requested", () => {
    // Losing it would hide a real delivery; recording it is what an audit needs.
    const rows = buildTurnSkillDeliveryRows({
      provider: "openai",
      requestedSkillIds: ["@cinatra-ai/a"],
      exposure: [
        { skillId: "@cinatra-ai/a", deliveryMode: "openai_shell", invocationAttributable: true },
        { skillId: "@rogue/x", deliveryMode: "openai_shell", invocationAttributable: true },
      ],
    });
    expect(rows.map((r) => r.skillId)).toEqual(["@cinatra-ai/a", "@rogue/x"]);
    expect(rowFor(rows, "@rogue/x").outcome).toBe("delivered");
  });
});

describe("vehicle: container-skills (Anthropic)", () => {
  it("records the delivered set with the provider skill id + version from the emitted container tool", () => {
    const rows = buildTurnSkillDeliveryRows({
      provider: "anthropic",
      requestedSkillIds: ["@cinatra-ai/a", "@cinatra-ai/b"],
      exposure: [
        { skillId: "@cinatra-ai/a", deliveryMode: "anthropic_container", invocationAttributable: false },
        { skillId: "@cinatra-ai/b", deliveryMode: "anthropic_container", invocationAttributable: false },
      ],
      tools: [
        {
          type: "container_skills",
          skills: [
            { skillId: "skill_ant_a", version: "3", catalogSkillId: "@cinatra-ai/a" },
            { skillId: "skill_ant_b", version: "1", catalogSkillId: "@cinatra-ai/b" },
          ],
        } as never,
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rowFor(rows, "@cinatra-ai/a")).toMatchObject({
      outcome: "delivered",
      provider: "anthropic",
      vehicle: "container-skills",
      deliveryMode: "anthropic_container",
      invocationAttributable: false,
      providerSkillId: "skill_ant_a",
      skillVersion: "3",
      nonDeliveryReason: null,
    });
    expect(rowFor(rows, "@cinatra-ai/b").providerSkillId).toBe("skill_ant_b");
  });

  it("records a rank-and-truncated skill as a DROP carrying the adapter's own reason — never as a refusal", () => {
    const rows = buildTurnSkillDeliveryRows({
      provider: "anthropic",
      requestedSkillIds: ["@cinatra-ai/kept", "@cinatra-ai/cut"],
      exposure: [
        { skillId: "@cinatra-ai/kept", deliveryMode: "anthropic_container", invocationAttributable: false },
      ],
      tools: [
        {
          type: "container_skills",
          skills: [{ skillId: "s1", version: "1", catalogSkillId: "@cinatra-ai/kept" }],
        } as never,
      ],
      adapterDroppedSkillIds: ["@cinatra-ai/cut"],
      adapterSelectionReason: "Anthropic allows at most 8 Custom Skills per request; truncated.",
    });

    const cut = rowFor(rows, "@cinatra-ai/cut");
    expect(cut.outcome).toBe("dropped");
    expect(cut.outcome).not.toBe("refused");
    expect(cut.vehicle).toBeNull();
    expect(cut.deliveryMode).toBeNull();
    expect(cut.nonDeliveryReason).toContain("at most 8 Custom Skills");
  });
});

describe("vehicle: tool-mount (OpenAI)", () => {
  it("records the mounted set as attributable tool-mount deliveries with no version", () => {
    const rows = buildTurnSkillDeliveryRows({
      provider: "openai",
      requestedSkillIds: ["@cinatra-ai/a"],
      exposure: [
        { skillId: "@cinatra-ai/a", deliveryMode: "openai_shell", invocationAttributable: true },
      ],
      tools: [{ type: "function", name: "skill_file_read" } as never],
    });

    expect(rows).toEqual([
      {
        skillId: "@cinatra-ai/a",
        outcome: "delivered",
        provider: "openai",
        vehicle: "tool-mount",
        deliveryMode: "openai_shell",
        invocationAttributable: true,
        providerSkillId: null,
        skillVersion: null,
        nonDeliveryReason: null,
      },
    ]);
  });

  it("records a SILENTLY unmounted skill (absent from exposure, absent from every drop channel)", () => {
    // The exact shape finding F8 could not see: `buildSkillTools` omits a skill
    // with no on-disk source path and reports it NOWHERE. Without a synthesized
    // drop row an operator would read "1 skill delivered" and never learn the
    // second one vanished.
    const rows = buildTurnSkillDeliveryRows({
      provider: "openai",
      requestedSkillIds: ["@cinatra-ai/mounted", "@cinatra-ai/ghost"],
      exposure: [
        { skillId: "@cinatra-ai/mounted", deliveryMode: "openai_shell", invocationAttributable: true },
      ],
    });

    expect(rows).toHaveLength(2);
    const ghost = rowFor(rows, "@cinatra-ai/ghost");
    expect(ghost.outcome).toBe("dropped");
    expect(ghost.nonDeliveryReason).toContain("not delivered by the openai vehicle");
  });
});

describe("vehicle: inline (Gemini / personal delta)", () => {
  it("records inlined skills as non-attributable inline deliveries and budget cuts as drops", () => {
    const rows = buildTurnSkillDeliveryRows({
      provider: "gemini",
      requestedSkillIds: ["@cinatra-ai/personal", "@cinatra-ai/a", "@cinatra-ai/huge"],
      exposure: [
        { skillId: "@cinatra-ai/personal", deliveryMode: "personal_inline", invocationAttributable: false },
        { skillId: "@cinatra-ai/a", deliveryMode: "gemini_inline", invocationAttributable: false },
      ],
      contractDrops: [{ skillId: "@cinatra-ai/huge", reason: "inline_budget_exceeded" }],
    });

    expect(rowFor(rows, "@cinatra-ai/personal")).toMatchObject({
      outcome: "delivered",
      vehicle: "inline",
      deliveryMode: "personal_inline",
      invocationAttributable: false,
    });
    expect(rowFor(rows, "@cinatra-ai/a").vehicle).toBe("inline");
    expect(rowFor(rows, "@cinatra-ai/huge")).toMatchObject({
      outcome: "dropped",
      vehicle: null,
      nonDeliveryReason: "inline_budget_exceeded",
    });
  });
});

describe("outcome: refused (the loud no-vehicle path, cinatra#2094 F11)", () => {
  it("records EVERY resolved skill as refused with the refusal reason, and no vehicle", () => {
    const rows = buildTurnSkillDeliveryRows({
      provider: "openai",
      requestedSkillIds: ["@cinatra-ai/a", "@cinatra-ai/b", "@cinatra-ai/c"],
      exposure: [],
      refusalReason: 'skill delivery produced NO vehicle for provider "openai" model "gpt-5-mini"',
    });

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.outcome).toBe("refused");
      expect(row.vehicle).toBeNull();
      expect(row.deliveryMode).toBeNull();
      expect(row.invocationAttributable).toBeNull();
      expect(row.nonDeliveryReason).toContain("NO vehicle");
    }
  });

  it("a skill an explicit drop channel named keeps its DROP reason, never 'refused'", () => {
    // A bundle over the injection cap, whose survivors then hit the no-vehicle
    // refusal. Relabelling the cap-dropped skill "refused" would misattribute
    // the loss; omitting its row would hide it — the finding-F8 failure mode.
    const rows = buildTurnSkillDeliveryRows({
      provider: "openai",
      requestedSkillIds: ["@cinatra-ai/kept1", "@cinatra-ai/kept2"],
      exposure: [],
      contractDrops: [{ skillId: "@cinatra-ai/over-cap", reason: "injection_cap_exceeded" }],
      adapterDroppedSkillIds: ["@cinatra-ai/kept2"],
      adapterSelectionReason: "rank-and-truncated",
      refusalReason: "no vehicle",
    });

    expect(rows).toHaveLength(3);
    expect(rowFor(rows, "@cinatra-ai/kept1").outcome).toBe("refused");
    expect(rowFor(rows, "@cinatra-ai/over-cap")).toMatchObject({
      outcome: "dropped",
      nonDeliveryReason: "injection_cap_exceeded",
    });
    expect(rowFor(rows, "@cinatra-ai/kept2")).toMatchObject({
      outcome: "dropped",
      nonDeliveryReason: "rank-and-truncated",
    });
  });

  it("a refusal is total — it never leaves a 'delivered' row behind", () => {
    const rows = buildTurnSkillDeliveryRows({
      provider: "anthropic",
      requestedSkillIds: ["@cinatra-ai/a"],
      // Even if a stale exposure list were passed, a refusal means NOTHING
      // reached the model; the record must not claim otherwise.
      exposure: [
        { skillId: "@cinatra-ai/a", deliveryMode: "anthropic_container", invocationAttributable: false },
      ],
      refusalReason: "no vehicle",
    });
    expect(rows.every((r) => r.outcome === "refused")).toBe(true);
  });
});

describe("record shape invariants", () => {
  it("emits exactly one row per resolved skill (the (turn_id, skill_id) primary key)", () => {
    const rows = buildTurnSkillDeliveryRows({
      provider: "anthropic",
      requestedSkillIds: ["@cinatra-ai/a", "@cinatra-ai/a", "@cinatra-ai/b"],
      exposure: [
        { skillId: "@cinatra-ai/a", deliveryMode: "anthropic_container", invocationAttributable: false },
      ],
      // The same skill reported through BOTH drop channels must still be one row.
      contractDrops: [{ skillId: "@cinatra-ai/b", reason: "over_cap" }],
      adapterDroppedSkillIds: ["@cinatra-ai/b"],
    });
    expect(rows.map((r) => r.skillId)).toEqual(["@cinatra-ai/a", "@cinatra-ai/b"]);
  });

  it("is deterministic and ordered by the resolved (rank) order", () => {
    const input = {
      provider: "openai" as const,
      requestedSkillIds: ["@z/one", "@a/two", "@m/three"],
      exposure: [
        { skillId: "@m/three", deliveryMode: "openai_shell" as const, invocationAttributable: true },
        { skillId: "@z/one", deliveryMode: "openai_shell" as const, invocationAttributable: true },
      ],
    };
    const first = buildTurnSkillDeliveryRows(input);
    const second = buildTurnSkillDeliveryRows(input);
    expect(first).toEqual(second);
    expect(first.map((r) => r.skillId)).toEqual(["@z/one", "@a/two", "@m/three"]);
  });

  it("never emits a blank non-delivery reason (an empty reason reads as ABSENT)", () => {
    const rows = buildTurnSkillDeliveryRows({
      provider: "openai",
      requestedSkillIds: ["@cinatra-ai/a"],
      exposure: [],
      contractDrops: [{ skillId: "@cinatra-ai/a", reason: "" }],
      adapterDroppedSkillIds: ["@cinatra-ai/b"],
      adapterSelectionReason: "",
    });
    for (const row of rows) {
      expect(row.outcome).toBe("dropped");
      expect(row.nonDeliveryReason).toBeTruthy();
    }
  });

  it("records an Anthropic delivery whose container reference is MISSING, without inventing one", () => {
    const rows = buildTurnSkillDeliveryRows({
      provider: "anthropic",
      requestedSkillIds: ["@cinatra-ai/a"],
      exposure: [
        { skillId: "@cinatra-ai/a", deliveryMode: "anthropic_container", invocationAttributable: false },
      ],
      // The adapter reported the delivery but emitted no matching container ref.
      tools: [{ type: "container_skills", skills: [] } as never],
    });
    expect(rows[0]).toMatchObject({
      outcome: "delivered",
      vehicle: "container-skills",
      providerSkillId: null,
      skillVersion: null,
    });
  });

  it("every row satisfies the table's delivered/non-delivered CHECK biconditionals", () => {
    const rows = [
      ...buildTurnSkillDeliveryRows({
        provider: "anthropic",
        requestedSkillIds: ["@a/1", "@a/2", "@a/3"],
        exposure: [
          { skillId: "@a/1", deliveryMode: "anthropic_container", invocationAttributable: false },
          { skillId: "@a/2", deliveryMode: "weird_mode" as never, invocationAttributable: false },
        ],
        tools: [
          { type: "container_skills", skills: [{ skillId: "s", version: "1", catalogSkillId: "@a/1" }] } as never,
        ],
      }),
      ...buildTurnSkillDeliveryRows({
        provider: "openai",
        requestedSkillIds: ["@b/1"],
        exposure: [],
        refusalReason: "no vehicle",
      }),
    ];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const delivered = row.outcome === "delivered";
      expect(row.vehicle !== null).toBe(delivered);
      expect(row.deliveryMode !== null).toBe(delivered);
      expect(row.nonDeliveryReason === null).toBe(delivered);
    }
  });

  it("caps at the resolved set — never invents a skill the turn did not resolve", () => {
    // The injection contract's hard cap of 8 has already run upstream; the
    // record is a faithful projection of what it produced, never a re-selection.
    const requested = Array.from({ length: 8 }, (_, i) => `@cinatra-ai/s${i}`);
    const rows = buildTurnSkillDeliveryRows({
      provider: "anthropic",
      requestedSkillIds: requested,
      exposure: requested.map((skillId) => ({
        skillId,
        deliveryMode: "anthropic_container" as const,
        invocationAttributable: false,
      })),
    });
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.outcome === "delivered")).toBe(true);
  });
});
