// cinatra#1875 W2 (Epic #1873) — AC#2: the reader's DELIVERY projection.
// Pure (no DB): the registry reader projects `delivery` from the persisted
// `assistant_declaration.block.delivery.kind`, failing SAFE to host-runtime.

import { describe, it, expect } from "vitest";
import {
  projectAssistantDelivery,
  DEFAULT_ASSISTANT_DELIVERY,
} from "@/lib/assistant-registry-reader";

describe("projectAssistantDelivery", () => {
  it("projects each declared delivery kind from a RECOGNIZED-version envelope", () => {
    for (const kind of ["host-runtime", "webhook", "mcp-poll"] as const) {
      expect(projectAssistantDelivery({ formatVersion: 1, block: { delivery: { kind } } })).toBe(kind);
    }
  });

  it("defaults to host-runtime for the builtin (null declaration)", () => {
    expect(projectAssistantDelivery(null)).toBe("host-runtime");
    expect(DEFAULT_ASSISTANT_DELIVERY).toBe("host-runtime");
  });

  it("fails SAFE to host-runtime on a malformed / partial declaration", () => {
    expect(projectAssistantDelivery({})).toBe("host-runtime");
    expect(projectAssistantDelivery({ formatVersion: 1, block: {} })).toBe("host-runtime");
    expect(projectAssistantDelivery({ formatVersion: 1, block: { delivery: {} } })).toBe("host-runtime");
    expect(projectAssistantDelivery({ formatVersion: 1, block: { delivery: { kind: "bogus" } } })).toBe(
      "host-runtime",
    );
    expect(projectAssistantDelivery({ formatVersion: 1 })).toBe("host-runtime");
    expect(projectAssistantDelivery(undefined)).toBe("host-runtime");
  });

  it("REFUSES an external delivery from an unversioned or wrong-version envelope (fail safe)", () => {
    // Codex convergence: an external kind (webhook/mcp-poll) is honored ONLY on a
    // recognized-version envelope — a corrupt/partial jsonb or an unsupported
    // future version can never silently escalate a turn onto an out-of-band push.
    expect(projectAssistantDelivery({ block: { delivery: { kind: "webhook" } } })).toBe("host-runtime");
    expect(projectAssistantDelivery({ formatVersion: 2, block: { delivery: { kind: "mcp-poll" } } })).toBe(
      "host-runtime",
    );
    expect(projectAssistantDelivery({ formatVersion: "1", block: { delivery: { kind: "webhook" } } })).toBe(
      "host-runtime",
    );
  });
});
