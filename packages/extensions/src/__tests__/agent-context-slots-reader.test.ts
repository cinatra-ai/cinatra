/**
 * agent-context-slots-reader unit tests.
 *
 * Mirrors the produces-reader test structure: same fail-quiet posture;
 * same standalone shape; same hostile-manifest defensiveness.
 *
 *   pnpm --filter @cinatra-ai/extensions exec vitest run \
 *     src/__tests__/agent-context-slots-reader.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  readAgentContextSlotsFromOas,
  __test,
  type AgentContextSlot,
} from "../agent-context-slots-reader";

// A minimal OAS-shaped object the reader walks through. Only the
// `metadata.cinatra.contextSlots` slice matters; everything else is
// just OAS noise.
function oasWithSlots(slots: unknown) {
  return {
    openapi: "3.0.0",
    info: { title: "test-agent", version: "0.1.0" },
    metadata: {
      cinatra: {
        contextSlots: slots,
      },
    },
  };
}

const VALID_SLOT: AgentContextSlot = {
  slotId: "offeringContext",
  acceptedArtifactExtensions: [
    "@cinatra-ai/marketing-icp-artifact",
    "@cinatra-ai/marketing-strategy-artifact",
    "@cinatra-ai/product-portfolio-artifact",
  ],
  selectionMode: "interactive",
  resolutionMode: "accumulate",
  minItems: 0,
  maxItems: 5,
  readableOnly: true,
};

describe("readAgentContextSlotsFromOas — happy path", () => {
  it("returns the declared slots from an OAS", () => {
    const slots = readAgentContextSlotsFromOas(oasWithSlots([VALID_SLOT]));
    expect(slots).toHaveLength(1);
    expect(slots[0]).toEqual(VALID_SLOT);
  });

  it("returns ALL declared slots when multiple are present", () => {
    const second: AgentContextSlot = {
      slotId: "audienceContext",
      acceptedArtifactExtensions: ["@cinatra-ai/marketing-icp-artifact"],
      selectionMode: "autonomous",
      resolutionMode: "override",
    };
    const slots = readAgentContextSlotsFromOas(
      oasWithSlots([VALID_SLOT, second]),
    );
    expect(slots).toHaveLength(2);
    expect(slots[0].slotId).toBe("offeringContext");
    expect(slots[1].slotId).toBe("audienceContext");
  });

  it("omits optional fields when absent", () => {
    const minimal: AgentContextSlot = {
      slotId: "x",
      acceptedArtifactExtensions: ["@cinatra-ai/marketing-icp-artifact"],
      selectionMode: "interactive",
      resolutionMode: "override",
    };
    const [parsed] = readAgentContextSlotsFromOas(oasWithSlots([minimal]));
    expect(parsed).toEqual(minimal);
    // No accidental introduction of optional fields as `undefined`.
    expect("minItems" in parsed).toBe(false);
    expect("maxItems" in parsed).toBe(false);
    expect("readableOnly" in parsed).toBe(false);
  });
});

describe("readAgentContextSlotsFromOas — fail-quiet contract", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["string", "no"],
    ["array", []],
  ])("returns [] for non-object oas (%s)", (_label, oas) => {
    expect(readAgentContextSlotsFromOas(oas)).toEqual([]);
  });

  it("returns [] when `metadata` is missing", () => {
    expect(readAgentContextSlotsFromOas({})).toEqual([]);
  });

  it("returns [] when `metadata.cinatra` is missing", () => {
    expect(readAgentContextSlotsFromOas({ metadata: {} })).toEqual([]);
  });

  it("returns [] when `metadata.cinatra.contextSlots` is absent", () => {
    expect(
      readAgentContextSlotsFromOas({ metadata: { cinatra: {} } }),
    ).toEqual([]);
  });

  it("returns [] when `contextSlots` is not an array", () => {
    expect(readAgentContextSlotsFromOas(oasWithSlots({}))).toEqual([]);
    expect(readAgentContextSlotsFromOas(oasWithSlots("bad"))).toEqual([]);
  });

  it("returns [] on any malformed slot (one bad slot poisons the array)", () => {
    expect(
      readAgentContextSlotsFromOas(
        oasWithSlots([
          VALID_SLOT,
          { slotId: "broken" /* missing required fields */ },
        ]),
      ),
    ).toEqual([]);
  });

  it("returns [] on unknown extra keys (strict()) — drift-guard against typos", () => {
    const withTypo = {
      ...VALID_SLOT,
      selecMode: "interactive", // typo
    };
    expect(readAgentContextSlotsFromOas(oasWithSlots([withTypo]))).toEqual([]);
  });

  it("returns [] when minItems > maxItems (cross-field guard)", () => {
    const bad: AgentContextSlot = {
      ...VALID_SLOT,
      minItems: 5,
      maxItems: 2,
    };
    expect(readAgentContextSlotsFromOas(oasWithSlots([bad]))).toEqual([]);
  });

  it("returns [] when acceptedArtifactExtensions is empty", () => {
    const bad: AgentContextSlot = {
      ...VALID_SLOT,
      acceptedArtifactExtensions: [],
    };
    expect(readAgentContextSlotsFromOas(oasWithSlots([bad]))).toEqual([]);
  });

  it("never throws on hostile getters", () => {
    // The reader's `try/catch` wrapper handles throwing property
    // descriptors so hostile manifests fail quietly.
    const oas = {};
    Object.defineProperty(oas, "metadata", {
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(() => readAgentContextSlotsFromOas(oas)).not.toThrow();
    expect(readAgentContextSlotsFromOas(oas)).toEqual([]);
  });
});

describe("readAgentContextSlotsFromOas — defensive copy semantics", () => {
  it("returns NEW slot objects (no caller-supplied reference pass-through)", () => {
    const fixture = oasWithSlots([VALID_SLOT]);
    const [first] = readAgentContextSlotsFromOas(fixture);
    expect(first).not.toBe(VALID_SLOT);
    expect(first.acceptedArtifactExtensions).not.toBe(
      VALID_SLOT.acceptedArtifactExtensions,
    );
  });
});

describe("schema-level invariants", () => {
  it("selectionMode is enum-restricted (anything else → fail)", () => {
    const parsed = __test.contextSlotSchema.safeParse({
      ...VALID_SLOT,
      selectionMode: "AI-decides",
    });
    expect(parsed.success).toBe(false);
  });

  it("resolutionMode is enum-restricted (anything else → fail)", () => {
    const parsed = __test.contextSlotSchema.safeParse({
      ...VALID_SLOT,
      resolutionMode: "all",
    });
    expect(parsed.success).toBe(false);
  });

  it("maxItems must be positive integer", () => {
    const parsed = __test.contextSlotSchema.safeParse({
      ...VALID_SLOT,
      maxItems: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it("acceptedArtifactExtensions strings must be non-empty", () => {
    const parsed = __test.contextSlotSchema.safeParse({
      ...VALID_SLOT,
      acceptedArtifactExtensions: ["@cinatra-ai/marketing-icp-artifact", ""],
    });
    expect(parsed.success).toBe(false);
  });
});
