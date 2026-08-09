/**
 * llm-providers S4 switch-over (cinatra#1715) — `resolveProviderAdapter`
 * resolves a provider ONLY through its connector-registered
 * `llm-provider-adapter` surface:
 *   - surface WINS (there is no in-core factory left to consult),
 *   - a surface `createAdapter()->null` is AUTHORITATIVE (connector present but
 *     unconfigured),
 *   - an ABSENT surface ⇒ `null` — the provider is honestly UNAVAILABLE
 *     (fail-closed; NO silent fallback to deleted in-core code),
 *   - a malformed surface's fail-closed throw PROPAGATES (never silent fallback).
 *
 * Mocks mirror the sibling `registry-declared-toolboxes.test.ts` discipline
 * (registered BEFORE the module-under-test is imported).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./mcp-access", () => ({
  // cinatra#2565 — the reserved-first-party-label guard; identity here
  // (these suites do not exercise external-label impostors).
  withoutReservedFirstPartyLabelTools: vi.fn((tools: unknown[]) => tools),
  buildLlmMcpServerTool: vi.fn(async () => null),
  buildExternalMcpServerTools: vi.fn(async () => []),
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn(),
  listLlmProviderSurfaces: vi.fn(() => []),
  // llm-providers S4: the connector-registered adapter surface resolver.
  getLlmProviderAdapterSurface: vi.fn(() => null),
}));
vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: vi.fn(() => "openai"),
  readDefaultImageProviderFromDatabase: vi.fn(() => null),
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));
vi.mock("@/lib/external-mcp-toolbox-loader.server", () => ({
  loadExternalMcpToolboxBySlug: vi.fn(async () => null),
  sanitizeExternalMcpToolboxTools: vi.fn((tools: unknown) => tools),
}));

import { getLlmProviderAdapterSurface } from "@/lib/llm-provider-surfaces";
import { resolveProviderAdapter } from "./registry";
import { isMeteredAdapter } from "./usage-metering";
import type { LlmProviderAdapter } from "./types";

function surface(createAdapter: () => Promise<LlmProviderAdapter | null>) {
  return { abiVersion: 1 as const, providerId: "openai", createAdapter };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLlmProviderAdapterSurface).mockReturnValue(null);
});

describe("resolveProviderAdapter — llm-provider-adapter surface (S4 switch-over)", () => {
  it("resolves the adapter through the connector-registered surface", async () => {
    // Deliberate partial stub — this test proves the surface is the source of
    // the adapter + null authority, not adapter shape; cast to the firmed ABI
    // type (S4.0).
    const adapter = { provider: "openai", via: "surface" } as unknown as LlmProviderAdapter;
    const createAdapter = vi.fn(async () => adapter);
    vi.mocked(getLlmProviderAdapterSurface).mockReturnValue(surface(createAdapter));

    const result = await resolveProviderAdapter("openai");

    // cinatra#2578: the resolved adapter is the connector's, wrapped in the
    // usage-metering proxy. The wrapper is TRANSPARENT — every member reads
    // through to the connector's object — so what the surface supplied is still
    // what a caller sees; only reference identity changes, and that change is
    // exactly what makes the ledger structural.
    expect(result).not.toBeNull();
    expect(isMeteredAdapter(result)).toBe(true);
    expect(result).toEqual(adapter);
    expect(result!.provider).toBe("openai");
    expect((result as unknown as { via: string }).via).toBe("surface");
    expect(createAdapter).toHaveBeenCalledTimes(1);
  });

  it("treats a surface createAdapter()->null as AUTHORITATIVE (connector present, unconfigured)", async () => {
    vi.mocked(getLlmProviderAdapterSurface).mockReturnValue(surface(async () => null));

    const result = await resolveProviderAdapter("openai");

    expect(result).toBeNull();
  });

  it("returns null (honest unavailable, fail-closed) when NO surface is registered", async () => {
    vi.mocked(getLlmProviderAdapterSurface).mockReturnValue(null);

    const result = await resolveProviderAdapter("openai");

    // No connector for this provider ⇒ unavailable. There is NO in-core factory
    // fallback anymore (deleted in the #1715 switch-over).
    expect(result).toBeNull();
  });

  it("propagates a fail-closed throw from a malformed surface (never silent fallback)", async () => {
    vi.mocked(getLlmProviderAdapterSurface).mockImplementation(() => {
      throw new Error("llm-provider-adapter surface is registered but malformed");
    });

    await expect(resolveProviderAdapter("openai")).rejects.toThrow(/malformed/);
  });
});
