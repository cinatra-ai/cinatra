/**
 * cinatra#2093 (epic #2086 S6) — `resolveConfiguredLlmRuntime` EXACT BINDING.
 *
 * Replaces the cinatra#1850 `allowAnthropicFallback` matrix, whose whole reason
 * to exist (Anthropic was architecturally barred from the global default, so a
 * per-purpose caller needed an escape hatch to reach an Anthropic-only install)
 * is retired by S6's un-fencing.
 *
 * The resolution matrix this pins:
 *   - the implicit-global list is EXACTLY [storedProvider] under the default
 *     "exact" failover policy — an unavailable stored provider resolves null
 *     rather than hopping to another configured provider;
 *   - Anthropic is a first-class stored default (the un-fencing): an
 *     Anthropic-only install with dbDefault=anthropic resolves it with no flag;
 *   - the stored "ordered" admin policy restores fallthrough, and only then,
 *     over the `defaultCapable` set;
 *   - an explicit `preferredProviders` list stays authoritative and verbatim.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./mcp-access", () => ({
  buildLlmMcpServerTool: vi.fn(async () => null),
  buildExternalMcpServerTools: vi.fn(async () => []),
}));

vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));

// Per-provider availability: `resolveProviderAdapter(provider)` resolves an
// adapter iff the connector-registered adapter surface is present AND its
// `createAdapter()` returns non-null. Both "connector absent" and "connector
// present but unconfigured" collapse to "provider unavailable" here.
const availability = { openai: false, gemini: false, anthropic: false } as Record<string, boolean>;
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn((providerId: string) =>
    availability[providerId]
      ? {
          abiVersion: 1 as const,
          providerId,
          createAdapter: async () => ({ provider: providerId }),
        }
      : null,
  ),
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));

// The openai connection snapshot is re-sourced from the openai connector module
// (the in-tree provider relocated — #1715). Returns a connection iff openai is
// available.
const openaiConnectionMock = vi.fn(async () => null as { apiKey: string } | null);
vi.mock("@/lib/connector-modules.server", () => ({
  loadConnectorModule: vi.fn(async (slug: string) =>
    slug === "openai-connector"
      ? { getConfiguredOpenAIConnection: openaiConnectionMock }
      : null,
  ),
}));

vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: vi.fn(() => "openai"),
  readDefaultImageProviderFromDatabase: vi.fn(() => null),
  readLlmProviderFailoverPolicyFromDatabase: vi.fn(() => "exact"),
}));

// Break the circular workspace self-import (./index -> ./tools/skills ->
// @cinatra-ai/skills -> @cinatra-ai/llm).
vi.mock("./tools/skills", () => ({
  buildSkillTools: vi.fn().mockResolvedValue([]),
  buildSkillContext: vi.fn().mockResolvedValue(""),
  readSkillContent: vi.fn().mockResolvedValue(null),
  createShellTool: vi.fn(),
  createLocalSkillShellTool: vi.fn(),
  createMcpServerTool: vi.fn(),
  createWebSearchTool: vi.fn(),
  buildMcpTools: vi.fn(),
}));

vi.mock("@cinatra-ai/metric-usage-api", () => ({
  emitUsageEvent: vi.fn(),
}));

import { resolveConfiguredLlmRuntime } from "./index";
import {
  readDefaultLlmProviderFromDatabase,
  readLlmProviderFailoverPolicyFromDatabase,
} from "@/lib/database";

// Per-test provider availability + stored-policy knobs.
function configure(opts: {
  dbDefault?: "openai" | "gemini" | "anthropic";
  failover?: "exact" | "ordered";
  openai?: boolean;
  gemini?: boolean;
  anthropic?: boolean;
}) {
  vi.mocked(readDefaultLlmProviderFromDatabase).mockReturnValue(opts.dbDefault ?? "openai");
  vi.mocked(readLlmProviderFailoverPolicyFromDatabase).mockReturnValue(opts.failover ?? "exact");
  availability.openai = Boolean(opts.openai);
  availability.gemini = Boolean(opts.gemini);
  availability.anthropic = Boolean(opts.anthropic);
  openaiConnectionMock.mockResolvedValue(opts.openai ? { apiKey: "sk-openai" } : null);
}

beforeEach(() => {
  vi.clearAllMocks();
  availability.openai = false;
  availability.gemini = false;
  availability.anthropic = false;
});

describe("resolveConfiguredLlmRuntime — exact binding to the stored provider (cinatra#2093)", () => {
  it("resolves the STORED provider when it is available", async () => {
    configure({ dbDefault: "openai", openai: true, gemini: true, anthropic: true });
    expect(await resolveConfiguredLlmRuntime()).toEqual({
      provider: "openai",
      connection: { apiKey: "sk-openai" },
    });
  });

  it("UN-FENCED: an Anthropic-only install with dbDefault=anthropic resolves Anthropic — no flag, no special case", async () => {
    configure({ dbDefault: "anthropic", openai: false, gemini: false, anthropic: true });
    expect(await resolveConfiguredLlmRuntime()).toEqual({ provider: "anthropic" });
  });

  it("Anthropic is preferred over an available OpenAI when it is the STORED default (the pre-S6 order is gone)", async () => {
    configure({ dbDefault: "anthropic", openai: true, gemini: true, anthropic: true });
    expect(await resolveConfiguredLlmRuntime()).toEqual({ provider: "anthropic" });
  });

  it("NO SILENT HOP: an unavailable stored provider resolves null even though another provider IS configured", async () => {
    configure({ dbDefault: "openai", openai: false, gemini: true, anthropic: true });
    expect(await resolveConfiguredLlmRuntime()).toBeNull();
  });

  it("NO SILENT HOP: an unavailable stored Anthropic does not fall back to a configured OpenAI", async () => {
    configure({ dbDefault: "anthropic", openai: true, gemini: false, anthropic: false });
    expect(await resolveConfiguredLlmRuntime()).toBeNull();
  });

  it("no provider configured at all -> null", async () => {
    configure({ dbDefault: "openai", openai: false, gemini: false, anthropic: false });
    expect(await resolveConfiguredLlmRuntime()).toBeNull();
  });
});

describe("resolveConfiguredLlmRuntime — the explicit 'ordered' failover admin policy (cinatra#2093)", () => {
  it("falls through to the next default-capable provider ONLY under the stored ordered policy", async () => {
    configure({ dbDefault: "openai", failover: "ordered", openai: false, gemini: true, anthropic: true });
    expect(await resolveConfiguredLlmRuntime()).toEqual({ provider: "anthropic" });
  });

  it("ordered failover still prefers the stored provider when it is available", async () => {
    configure({ dbDefault: "gemini", failover: "ordered", openai: true, gemini: true, anthropic: true });
    expect(await resolveConfiguredLlmRuntime()).toEqual({ provider: "gemini" });
  });

  it("ordered failover can now reach Anthropic (it is defaultCapable) — the pre-S6 exclusion is gone", async () => {
    configure({ dbDefault: "openai", failover: "ordered", openai: false, gemini: false, anthropic: true });
    expect(await resolveConfiguredLlmRuntime()).toEqual({ provider: "anthropic" });
  });

  it("ordered failover with nothing configured -> null", async () => {
    configure({ dbDefault: "openai", failover: "ordered", openai: false, gemini: false, anthropic: false });
    expect(await resolveConfiguredLlmRuntime()).toBeNull();
  });
});

describe("resolveConfiguredLlmRuntime — explicit preferredProviders stays authoritative", () => {
  it("an explicit list is walked verbatim and never widened by the stored default", async () => {
    configure({ dbDefault: "anthropic", openai: false, gemini: false, anthropic: true });
    expect(await resolveConfiguredLlmRuntime({ preferredProviders: ["openai"] })).toBeNull();
  });

  it("preferredProviders:[anthropic] resolves Anthropic verbatim (unchanged contract)", async () => {
    configure({ dbDefault: "openai", openai: false, gemini: false, anthropic: true });
    expect(await resolveConfiguredLlmRuntime({ preferredProviders: ["anthropic"] })).toEqual({
      provider: "anthropic",
    });
  });

  it("an explicit list is NOT subject to the exact-binding restriction (it may name several)", async () => {
    configure({ dbDefault: "openai", openai: false, gemini: true, anthropic: false });
    expect(await resolveConfiguredLlmRuntime({ preferredProviders: ["openai", "gemini"] })).toEqual({
      provider: "gemini",
    });
  });
});
