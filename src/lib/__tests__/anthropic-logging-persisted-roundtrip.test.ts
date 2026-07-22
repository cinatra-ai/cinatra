/**
 * Anthropic logging toggle round-trips through the PERSISTED authority (#1715 D2).
 *
 * The admin toggle (saveAnthropicLoggingSettings) must persist into the
 * connector-config store, and the enabled flag must read back from that same
 * store (readAnthropicLoggingEnabledFromDatabase) — the single process-wide
 * authority a connector-relocated adapter also reads. This test drives the real
 * logging.ts save/read wiring over an in-memory connector-config store and
 * asserts the enabled value survives the round-trip with the correct default
 * semantics (absent ⇒ true; explicit false ⇒ false).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory connector-config store + key shared by the write and read mocks.
// Hoisted so the (hoisted) vi.mock factory below can close over them.
const h = vi.hoisted(() => ({ store: new Map<string, unknown>(), KEY: "anthropic-logging" }));
const KEY = h.KEY;

vi.mock("@/lib/database", () => ({
  ANTHROPIC_LOGGING_CONFIG_KEY: h.KEY,
  writeConnectorConfigToDatabase: vi.fn((key: string, value: unknown) => {
    h.store.set(key, value);
  }),
  // Faithful reimplementation of the real reader's contract over the store.
  readAnthropicLoggingEnabledFromDatabase: vi.fn(() => {
    const config = (h.store.get(h.KEY) as { enabled?: boolean } | undefined) ?? {};
    return config.enabled !== false;
  }),
}));

// Heavy siblings logging.ts imports at module scope (only used by
// clearAllProviderLogEntries, which these tests do not exercise). The anthropic
// log DIRECTORY is now resolved from the connector surface (#1715); absent here
// ⇒ undefined, which these enabled-flag tests do not assert on.
vi.mock("@/lib/connector-client-providers", () => ({
  resolveLinkedInConnectionClient: vi.fn(() => null),
  resolveWordPressInstanceAdmin: vi.fn(() => null),
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  listLlmProviderSurfaces: vi.fn(() => []),
  getLlmProviderSurface: vi.fn(() => null),
}));
vi.mock("@/lib/mcp-logging", () => ({
  MCP_CLIENT_LOG_DIRECTORY: "/tmp/mcp-client",
  MCP_SERVER_LOG_DIRECTORY: "/tmp/mcp-server",
}));

import { saveAnthropicLoggingSettings, getAnthropicLoggingSettings } from "../logging";

beforeEach(() => {
  h.store.clear();
});

describe("saveAnthropicLoggingSettings ↔ persisted authority round-trip (#1715 D2)", () => {
  it("defaults to enabled when nothing is persisted", () => {
    expect(getAnthropicLoggingSettings().enabled).toBe(true);
  });

  it("round-trips a disable through the persisted store", async () => {
    await saveAnthropicLoggingSettings(false);
    // The persisted connector-config store is the SOLE authority (#1715): no
    // in-process module-state cache is warmed anymore (the `anthropic-logging-
    // state` leaf relocated out of packages/llm).
    expect(h.store.get(KEY)).toEqual({ enabled: false });
    expect(getAnthropicLoggingSettings().enabled).toBe(false);
  });

  it("round-trips a re-enable through the persisted store", async () => {
    await saveAnthropicLoggingSettings(false);
    await saveAnthropicLoggingSettings(true);
    expect(h.store.get(KEY)).toEqual({ enabled: true });
    expect(getAnthropicLoggingSettings().enabled).toBe(true);
  });
});
