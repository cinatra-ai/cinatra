// cinatra#1062 — run-enqueue LLM-provider availability preflight.
//
// These tests exercise the REAL dispatch resolver (`resolveCinatraLlmDispatch`)
// through `assertLlmProviderAvailableForRun`, so the enqueue gate is proven to
// mirror the `/api/llm-bridge` runtime dispatch (one capability matrix, one
// branch algebra — they cannot drift). Only the adapter-availability PROBE is
// injected; `@cinatra-ai/agents` is delegated to the real policy subpath so the
// capability matrix under test is the production one (no hand-rolled duplicate).
import { describe, it, expect, vi } from "vitest";

// Load the real LLM policy (matrix + wording) without pulling the heavy agents
// barrel: the dispatch resolver imports its matrix from "@cinatra-ai/agents".
vi.mock("@cinatra-ai/agents", async () => {
  const policy = await vi.importActual<
    typeof import("@cinatra-ai/agents/llm-provider-policy")
  >("@cinatra-ai/agents/llm-provider-policy");
  return policy;
});

// The preflight module statically imports resolveProviderAdapter; stub it so the
// LLM registry never loads. Tests always pass an explicit probe, so this stub is
// never actually invoked.
vi.mock("@cinatra-ai/llm", () => ({
  resolveProviderAdapter: vi.fn(async () => null),
}));

import {
  assertLlmProviderAvailableForRun,
  LlmProviderNotConfiguredError,
} from "@/lib/agent-llm-preflight";
import type { LlmProvider } from "@cinatra-ai/agents";

/** Build an availability probe from an explicit set of available providers. */
function probeFor(...available: LlmProvider[]) {
  const set = new Set(available);
  return vi.fn(async (p: LlmProvider) => set.has(p));
}

// media-transcript-agent's declared requirement (its OAS metadata.cinatra.llm).
const MEDIA_TRANSCRIPT = {
  preferredProvider: "gemini",
  preferredModel: "gemini-2.5-flash",
  capabilityRequired: "media_input",
} as const;

describe("assertLlmProviderAvailableForRun (cinatra#1062)", () => {
  it("throws LLM_PROVIDER_NOT_CONFIGURED when the required provider is unavailable (media-transcript / gemini down)", async () => {
    await expect(
      assertLlmProviderAvailableForRun(MEDIA_TRANSCRIPT, probeFor(/* none */)),
    ).rejects.toMatchObject({
      code: "LLM_PROVIDER_NOT_CONFIGURED",
      settingsHref: "/configuration/llm",
    });
    // The actionable message names the capability + the satisfying provider.
    await assertLlmProviderAvailableForRun(MEDIA_TRANSCRIPT, probeFor()).catch(
      (e: LlmProviderNotConfiguredError) => {
        expect(e).toBeInstanceOf(LlmProviderNotConfiguredError);
        expect(e.message).toContain("media_input");
        expect(e.message.toLowerCase()).toContain("gemini");
      },
    );
  });

  it("passes when the preferred provider IS available (media-transcript / gemini configured)", async () => {
    await expect(
      assertLlmProviderAvailableForRun(MEDIA_TRANSCRIPT, probeFor("gemini")),
    ).resolves.toBeUndefined();
  });

  it("capability-only: throws when no compatible provider is available, passes when one is", async () => {
    const req = { capabilityRequired: "media_input" } as const;
    await expect(
      assertLlmProviderAvailableForRun(req, probeFor("openai", "anthropic")),
    ).rejects.toBeInstanceOf(LlmProviderNotConfiguredError);
    await expect(
      assertLlmProviderAvailableForRun(req, probeFor("gemini")),
    ).resolves.toBeUndefined();
  });

  it("soft fallback: a bare preferredProvider that is down (no capability gate) does NOT hard-fail enqueue", async () => {
    // Mirrors the dispatch: preferred unavailable + no capability => passthrough
    // (the bridge falls back to the configured default at step time).
    await expect(
      assertLlmProviderAvailableForRun({ preferredProvider: "openai" }, probeFor(/* all down */)),
    ).resolves.toBeUndefined();
  });

  it("capability fallback: preferred down but a capability-compatible provider is available => passes", async () => {
    // native_mcp is satisfiable by openai|anthropic; preferred openai down,
    // anthropic up => the resolver routes to anthropic.
    await expect(
      assertLlmProviderAvailableForRun(
        { preferredProvider: "openai", capabilityRequired: "native_mcp" },
        probeFor("anthropic"),
      ),
    ).resolves.toBeUndefined();
  });

  it("preferred available but capability-INCOMPATIBLE => throws (dispatch honors preferred, then capability-gates)", async () => {
    // gemini is available but cannot satisfy native_mcp.
    await expect(
      assertLlmProviderAvailableForRun(
        { preferredProvider: "gemini", capabilityRequired: "native_mcp" },
        probeFor("gemini"),
      ),
    ).rejects.toBeInstanceOf(LlmProviderNotConfiguredError);
  });

  it("no requirement (undefined) => no gate", async () => {
    const probe = probeFor();
    await expect(assertLlmProviderAvailableForRun(undefined, probe)).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});
