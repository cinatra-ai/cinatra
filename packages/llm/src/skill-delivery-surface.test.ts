/**
 * llm-providers S4.x (cinatra#1964) — `selectSkillDeliveryAdapter` honours the
 * connector-registered `llm-skill-delivery-adapter` surface:
 *   - surface WINS (the in-core adapter is not consulted),
 *   - the CORE-owned neutral delivery floor is passed through the DI seam and IS
 *     the real `./skills` floor (identity, not a stub — the seam boundary this
 *     stage exists to prove),
 *   - a registered adapter that CONSUMES that floor really delivers (real
 *     `buildSkillTools` output off the deterministic skills fixture),
 *   - an ABSENT surface falls through to the transitional in-core adapter (zero
 *     behavior change for the current, un-relocated image),
 *   - a malformed surface's fail-closed throw PROPAGATES (never silent fallback).
 *
 * Mirrors the request-translation `registry-provider-adapter-surface.test.ts`
 * discipline (mocks registered BEFORE the module-under-test is imported). The
 * skills catalog is the deterministic fixture + the openai shell surface — the
 * FLOOR itself is the real code, so this is a real-surface seam contract, not a
 * stubbed seam.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  SkillDeliveryAdapter,
  SkillDeliveryFloor,
} from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

const { installedGetMock, existsSyncMock } = vi.hoisted(() => ({
  installedGetMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock("@cinatra-ai/skills/mcp-client", () => ({
  createDeterministicSkillsClient: () => ({
    installed: { get: installedGetMock },
  }),
}));
vi.mock("@cinatra-ai/skills", () => ({
  readSkillFileContent: async () => "",
}));

// The openai `llm-provider-surface` GATED shellTools member (cinatra#151 Stage
// 2): buildSkillTools' local shell tool resolves the settings reader + docker
// executor via this capability — the real floor needs it present.
const { openaiShellSurface } = vi.hoisted(() => ({
  openaiShellSurface: {
    providerId: "openai",
    shellTools: {
      readSettings: () => null,
      runCommandInDocker: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    },
  },
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  // The seam under test — controllable per test.
  getLlmSkillDeliveryAdapterSurface: vi.fn(() => null),
  getLlmProviderAdapterSurface: vi.fn(() => null),
  getLlmProviderSurface: vi.fn((providerId: string) =>
    providerId === "openai" ? openaiShellSurface : null,
  ),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    if (providerId === "openai") return openaiShellSurface;
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => [openaiShellSurface]),
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

import { getLlmSkillDeliveryAdapterSurface } from "@/lib/llm-provider-surfaces";
import {
  selectSkillDeliveryAdapter,
  OpenAiShellSkillDelivery,
} from "./tools/skill-delivery";
import { buildSkillTools, readSkillContent, resolveSkillSummaries } from "./tools/skills";

function surface(
  createSkillDeliveryAdapter: (floor: SkillDeliveryFloor) => SkillDeliveryAdapter,
) {
  return { abiVersion: 1 as const, providerId: "openai", createSkillDeliveryAdapter };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLlmSkillDeliveryAdapterSurface).mockReturnValue(null);
  existsSyncMock.mockReturnValue(true);
});

describe("selectSkillDeliveryAdapter — llm-skill-delivery-adapter surface (S4.x)", () => {
  it("uses the connector-registered adapter and does NOT consult the in-core adapter", () => {
    const adapter = { provider: "openai", deliver: vi.fn() } as unknown as SkillDeliveryAdapter;
    const factory = vi.fn(() => adapter);
    vi.mocked(getLlmSkillDeliveryAdapterSurface).mockReturnValue(surface(factory));

    const result = selectSkillDeliveryAdapter("openai");

    expect(result).toBe(adapter);
    expect(result).not.toBeInstanceOf(OpenAiShellSkillDelivery);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("passes the REAL core delivery floor through the DI seam (identity — no stubbed floor)", () => {
    let captured: SkillDeliveryFloor | undefined;
    const factory = vi.fn((floor: SkillDeliveryFloor) => {
      captured = floor;
      return { provider: "openai", deliver: vi.fn() } as unknown as SkillDeliveryAdapter;
    });
    vi.mocked(getLlmSkillDeliveryAdapterSurface).mockReturnValue(surface(factory));

    selectSkillDeliveryAdapter("openai");

    // The seam MUST supply the core-owned neutral floor — the exact `./skills`
    // exports, not a re-implementation. A stubbed floor here would structurally
    // mask the contract this stage exists to enforce.
    expect(captured?.buildSkillTools).toBe(buildSkillTools);
    expect(captured?.readSkillContent).toBe(readSkillContent);
    expect(captured?.resolveSkillSummaries).toBe(resolveSkillSummaries);
  });

  it("a registered adapter that CONSUMES the injected floor really delivers (real buildSkillTools output)", async () => {
    // A relocated-style adapter: builds its tools from the injected core floor.
    const factory = (floor: SkillDeliveryFloor): SkillDeliveryAdapter => ({
      provider: "openai",
      async deliver({ skillIds }) {
        const tools = await floor.buildSkillTools({ skillIds });
        return { tools, systemContext: "", exposure: [] };
      },
    });
    vi.mocked(getLlmSkillDeliveryAdapterSurface).mockReturnValue(surface(factory));

    installedGetMock.mockResolvedValue({
      id: "@x/y:z",
      name: "z",
      slug: "z",
      description: "test skill",
      sourcePath: "/abs/path/to/SKILL.md",
    });

    const viaSurface = await selectSkillDeliveryAdapter("openai").deliver({ skillIds: ["@x/y:z"] });
    const viaFloor = await buildSkillTools({ skillIds: ["@x/y:z"] });

    // Byte-for-byte equivalent to the in-core delivery: same floor, same output.
    expect(viaSurface.tools).toHaveLength(viaFloor.length);
    expect(viaSurface.tools[0]).toMatchObject({ type: "shell" });
  });

  it("falls back to the in-core adapter when NO surface is registered (transitional zero-behavior-change)", () => {
    vi.mocked(getLlmSkillDeliveryAdapterSurface).mockReturnValue(null);

    const result = selectSkillDeliveryAdapter("openai");

    expect(result).toBeInstanceOf(OpenAiShellSkillDelivery);
    expect(vi.mocked(getLlmSkillDeliveryAdapterSurface)).toHaveBeenCalledWith("openai");
  });

  it("propagates a fail-closed throw from a malformed surface (never silent fallback)", () => {
    vi.mocked(getLlmSkillDeliveryAdapterSurface).mockImplementation(() => {
      throw new Error("llm-skill-delivery-adapter surface is registered but malformed");
    });

    expect(() => selectSkillDeliveryAdapter("openai")).toThrow(/malformed/);
  });
});
