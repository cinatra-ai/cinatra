/**
 * RECEIPT VALIDITY + INVALIDATION (cinatra#2093, epic #2086 S6).
 *
 * "Wizard completeness = receipt validity, not a cached boolean." The receipt
 * is only meaningful if it EXPIRES when the world it described changes, so
 * these pin the three invalidators the issue names — credential rotation, an
 * MCP-mode change, and a catalog change — plus the fail-closed reads.
 *
 * The invalidation must be driven from the SAME connector-config values the
 * running system uses; a fingerprint computed from something else would be a
 * decoration, not a guarantee.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const dbState = {
  connectorConfig: new Map<string, unknown>(),
  defaultProvider: "anthropic",
  catalogSkills: [{ id: "skill-a" }, { id: "skill-b" }],
  apiKeyFingerprint: "fp-key-1" as string | null,
};

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn((key: string, fallback: unknown) =>
    dbState.connectorConfig.has(key) ? dbState.connectorConfig.get(key) : fallback,
  ),
  writeConnectorConfigToDatabase: vi.fn((key: string, value: unknown) => {
    dbState.connectorConfig.set(key, value);
  }),
  readDefaultLlmProviderFromDatabase: vi.fn(() => dbState.defaultProvider),
  writeDefaultLlmProviderToDatabase: vi.fn(),
  isGlobalDefaultLlmProviderEligible: vi.fn(() => true),
  readSkillCatalogFromDatabase: vi.fn(() => ({ skills: dbState.catalogSkills })),
}));

vi.mock("@/lib/anthropic-skill-sync-service", () => ({
  deriveApiKeyFingerprint: vi.fn(() => dbState.apiKeyFingerprint),
}));

import {
  computeReadinessFingerprint,
  readSetupReadinessState,
  writeSetupReadinessReceipt,
  clearSetupReadinessReceipt,
  readSetupReadinessReceipt,
  readAnthropicMcpMode,
  writeAnthropicMcpMode,
  SETUP_READINESS_RECEIPT_CONFIG_KEY,
  type SetupReadinessReceipt,
} from "@/lib/setup-readiness-saga";

function reset() {
  dbState.connectorConfig = new Map();
  dbState.defaultProvider = "anthropic";
  dbState.catalogSkills = [{ id: "skill-a" }, { id: "skill-b" }];
  dbState.apiKeyFingerprint = "fp-key-1";
  // The connector's stored MCP mode lives under the "anthropic" settings key.
  dbState.connectorConfig.set("anthropic", { mcpMode: "native" });
}

/** Earn a receipt under the CURRENT configuration. */
function earnReceipt(provider: "openai" | "anthropic" = "anthropic"): SetupReadinessReceipt {
  const receipt: SetupReadinessReceipt = {
    receiptVersion: 1,
    provider,
    completedAt: "2026-07-29T10:00:00.000Z",
    fingerprint: computeReadinessFingerprint(provider),
  };
  writeSetupReadinessReceipt(receipt);
  return receipt;
}

beforeEach(reset);

describe("readiness receipt — the happy read", () => {
  it("a receipt earned under the current configuration reads as ready", () => {
    earnReceipt("anthropic");
    expect(readSetupReadinessState().ready).toBe(true);
  });

  it("round-trips through the connector-config store", () => {
    const receipt = earnReceipt("anthropic");
    expect(dbState.connectorConfig.get(SETUP_READINESS_RECEIPT_CONFIG_KEY)).toEqual(receipt);
    expect(readSetupReadinessReceipt()).toEqual(receipt);
  });
});

describe("readiness receipt — INVALIDATION (the three invalidators)", () => {
  it("a CREDENTIAL ROTATION invalidates the receipt", () => {
    earnReceipt("anthropic");
    expect(readSetupReadinessState().ready).toBe(true);

    dbState.apiKeyFingerprint = "fp-key-2-rotated";

    const state = readSetupReadinessState();
    expect(state.ready).toBe(false);
    expect(state.reason).toBe("configuration-changed");
  });

  it("an MCP-MODE CHANGE invalidates the receipt (native -> function-tools)", () => {
    earnReceipt("anthropic");
    expect(readSetupReadinessState().ready).toBe(true);

    // The exact regression the probe exists to catch: flipping back to the mode
    // that rejects every container.skills request must not keep reading ready
    // on a probe that passed under `native`.
    dbState.connectorConfig.set("anthropic", { mcpMode: "function-tools" });

    const state = readSetupReadinessState();
    expect(state.ready).toBe(false);
    expect(state.reason).toBe("configuration-changed");
  });

  it("an UNSET mcpMode is treated as function-tools (the connector's real default), not as 'probably fine'", () => {
    dbState.connectorConfig.set("anthropic", { mcpMode: "function-tools" });
    const withExplicit = computeReadinessFingerprint("anthropic");
    dbState.connectorConfig.set("anthropic", {});
    const withUnset = computeReadinessFingerprint("anthropic");
    expect(withUnset).toBe(withExplicit);
  });

  it("a CATALOG CHANGE invalidates the receipt", () => {
    earnReceipt("anthropic");
    expect(readSetupReadinessState().ready).toBe(true);

    dbState.catalogSkills = [{ id: "skill-a" }, { id: "skill-b" }, { id: "skill-c" }];

    const state = readSetupReadinessState();
    expect(state.ready).toBe(false);
    expect(state.reason).toBe("configuration-changed");
  });

  it("catalog ordering is NOT a change (the signature is order-independent)", () => {
    const a = computeReadinessFingerprint("anthropic");
    dbState.catalogSkills = [{ id: "skill-b" }, { id: "skill-a" }];
    expect(computeReadinessFingerprint("anthropic")).toBe(a);
  });

  it("switching the STORED PROVIDER invalidates a receipt earned for the old one", () => {
    earnReceipt("anthropic");
    dbState.defaultProvider = "openai";

    const state = readSetupReadinessState();
    expect(state.ready).toBe(false);
    expect(state.reason).toBe("provider-changed");
  });
});

describe("readiness receipt — fail-closed reads", () => {
  it("no receipt reads as not-ready", () => {
    const state = readSetupReadinessState();
    expect(state.ready).toBe(false);
    expect(state.reason).toBe("no-receipt");
  });

  it("a cleared receipt reads as not-ready", () => {
    earnReceipt("anthropic");
    clearSetupReadinessReceipt();
    expect(readSetupReadinessState().ready).toBe(false);
  });

  it("an UNKNOWN receipt version is not valid evidence", () => {
    dbState.connectorConfig.set(SETUP_READINESS_RECEIPT_CONFIG_KEY, {
      receiptVersion: 99,
      provider: "anthropic",
      fingerprint: computeReadinessFingerprint("anthropic"),
      completedAt: "2026-07-29T10:00:00.000Z",
    });
    expect(readSetupReadinessReceipt()).toBeNull();
    expect(readSetupReadinessState().ready).toBe(false);
  });

  it("a malformed receipt is not valid evidence", () => {
    dbState.connectorConfig.set(SETUP_READINESS_RECEIPT_CONFIG_KEY, { receiptVersion: 1 });
    expect(readSetupReadinessReceipt()).toBeNull();
  });

  it("an UNREADABLE catalog never matches a receipt earned against a readable one", async () => {
    earnReceipt("anthropic");
    const { readSkillCatalogFromDatabase } = await import("@/lib/database");
    vi.mocked(readSkillCatalogFromDatabase).mockImplementationOnce(() => {
      throw new Error("db down");
    });
    expect(readSetupReadinessState().ready).toBe(false);
  });
});

/**
 * THE MCP-MODE WRITER (the F2 finding on PR #2213).
 *
 * The `native-skills-probe` failure's only remedy is flipping this setting, and
 * nothing in the product could perform it — the connector declares no `mcpMode`
 * field on its settings schema and the host's legacy setter is a stub. The
 * wizard now performs it, so the write has to be exactly the read's inverse,
 * and it has to leave the rest of the connector's settings alone.
 */
describe("mcpMode — the writer that makes the fix-forward performable", () => {
  it("round-trips through the SAME reader the fingerprint uses", () => {
    dbState.connectorConfig.set("anthropic", { mcpMode: "function-tools" });
    expect(readAnthropicMcpMode()).toBe("function-tools");

    writeAnthropicMcpMode("native");
    expect(readAnthropicMcpMode()).toBe("native");
  });

  it("PRESERVES every other connector setting — it is one field, not a row replacement", () => {
    dbState.connectorConfig.set("anthropic", {
      mcpMode: "function-tools",
      defaultModel: "claude-sonnet-4-6",
      promptCachingEnabled: true,
    });

    writeAnthropicMcpMode("native");

    expect(dbState.connectorConfig.get("anthropic")).toEqual({
      mcpMode: "native",
      defaultModel: "claude-sonnet-4-6",
      promptCachingEnabled: true,
    });
  });

  it("writes onto an ABSENT settings row without inventing other fields", () => {
    dbState.connectorConfig.delete("anthropic");
    writeAnthropicMcpMode("native");
    expect(dbState.connectorConfig.get("anthropic")).toEqual({ mcpMode: "native" });
  });

  it("INVALIDATES a receipt earned under the old mode — the switch is a readiness input", () => {
    dbState.connectorConfig.set("anthropic", { mcpMode: "native" });
    earnReceipt("anthropic");
    expect(readSetupReadinessState().ready).toBe(true);

    // Flipping AWAY from native through the writer must expire the receipt, the
    // same as any other change to this input.
    writeAnthropicMcpMode("function-tools");
    expect(readSetupReadinessState().ready).toBe(false);
  });

  it("an invalidated receipt is only DORMANT — restoring the mode makes it valid again (why the switch must clear it)", () => {
    // This is the hazard the wizard's switch action has to defuse, pinned here
    // so the reason it clears the receipt cannot quietly stop being true. A
    // fingerprint mismatch does NOT delete a receipt: `readSetupReadinessState`
    // returns it with `ready:false`. Put the input back and the SAME receipt is
    // authoritative again — setup would read ready on a probe that failed.
    dbState.connectorConfig.set("anthropic", { mcpMode: "native" });
    earnReceipt("anthropic");

    writeAnthropicMcpMode("function-tools");
    const dormant = readSetupReadinessState();
    expect(dormant.ready).toBe(false);
    expect(dormant.reason).toBe("configuration-changed");
    expect(dormant.receipt).not.toBeNull(); // still there — merely not matching

    writeAnthropicMcpMode("native");
    expect(readSetupReadinessState().ready).toBe(true); // RESURRECTED

    // The action's own defusal: clear first, then write the mode.
    clearSetupReadinessReceipt();
    writeAnthropicMcpMode("function-tools");
    writeAnthropicMcpMode("native");
    expect(readSetupReadinessState().ready).toBe(false);
    expect(readSetupReadinessState().reason).toBe("no-receipt");
  });
});

describe("readiness fingerprint — provider isolation", () => {
  it("different providers never share a fingerprint", () => {
    expect(computeReadinessFingerprint("openai")).not.toBe(
      computeReadinessFingerprint("anthropic"),
    );
  });

  it("the non-Anthropic fingerprint does not depend on Anthropic configuration", () => {
    const before = computeReadinessFingerprint("openai");
    dbState.apiKeyFingerprint = "fp-rotated";
    dbState.connectorConfig.set("anthropic", { mcpMode: "function-tools" });
    dbState.catalogSkills = [{ id: "x" }];
    expect(computeReadinessFingerprint("openai")).toBe(before);
  });
});
