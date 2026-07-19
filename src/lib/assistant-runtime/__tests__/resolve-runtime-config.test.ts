// resolveAssistantRuntimeConfigByPrincipal (cinatra#1823, epic #1037 P4.1): the
// shared handle-generic resolution ladder that lets the AG-UI /api/assistants/chat
// endpoint serve ANY registered assistant from its PERSISTED sidecar via the
// assistant_user_id link — proving each CMS assistant resolves to its OWN config
// (not the hardcoded Cinatra fallback), a corrupt sidecar fails CLOSED, and a
// non-built-in principal with NO linked template fails CLOSED.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  readAssistantConfigByPrincipalId: vi.fn(),
  isBuiltInCinatraAssistantUserId: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  readAssistantConfigByPrincipalId: mocks.readAssistantConfigByPrincipalId,
}));
vi.mock("@/lib/assistant-users", () => ({
  BUILT_IN_CINATRA_ASSISTANT_USERNAME: "cinatra",
  // The built-in Cinatra principal is the one whose id is "cinatra-principal".
  isBuiltInCinatraAssistantUserId: (id: string) =>
    mocks.isBuiltInCinatraAssistantUserId(id),
}));

import { resolveAssistantRuntimeConfigByPrincipal } from "../resolve-runtime-config";
import { serializeAssistantConfig } from "@/lib/assistant-config";
import { wordpressAssistantConfig } from "../cms-assistant-config";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: only the id "cinatra-principal" is the built-in Cinatra principal.
  mocks.isBuiltInCinatraAssistantUserId.mockImplementation(
    async (id: string) => id === "cinatra-principal",
  );
});

describe("resolveAssistantRuntimeConfigByPrincipal", () => {
  it("resolves a registered CMS assistant to ITS OWN persisted config (not the Cinatra fallback)", async () => {
    mocks.readAssistantConfigByPrincipalId.mockResolvedValue(
      serializeAssistantConfig(wordpressAssistantConfig),
    );
    const out = await resolveAssistantRuntimeConfigByPrincipal({
      assistantUserId: "wp-principal",
      handle: "wordpress",
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      // The runtime is built from the WordPress sidecar — its system skill is the
      // WordPress authoring core, never chat-assistant-core.
      expect(out.runtimeConfig.systemSkillId).toContain("wordpress-authoring-core");
      expect(out.runtimeConfig.fallbackPersona).toBe(wordpressAssistantConfig.persona);
      expect(mocks.readAssistantConfigByPrincipalId).toHaveBeenCalledWith("wp-principal");
    }
  });

  it("fails CLOSED on a corrupt persisted sidecar (never masks corruption with the reference config)", async () => {
    mocks.readAssistantConfigByPrincipalId.mockResolvedValue('{"not":"a valid sidecar"}');
    const out = await resolveAssistantRuntimeConfigByPrincipal({
      assistantUserId: "wp-principal",
      handle: "wordpress",
    });
    expect(out).toEqual({ ok: false, code: "ASSISTANT_CONFIG_UNAVAILABLE" });
  });

  it("fails CLOSED for a non-built-in principal with NO linked template", async () => {
    mocks.readAssistantConfigByPrincipalId.mockResolvedValue(null);
    const out = await resolveAssistantRuntimeConfigByPrincipal({
      assistantUserId: "drupal-principal",
      handle: "drupal",
    });
    expect(out).toEqual({ ok: false, code: "ASSISTANT_CONFIG_UNAVAILABLE" });
  });

  it("the built-in @cinatra handle keeps the in-code reference config when no template is linked (transitional)", async () => {
    mocks.readAssistantConfigByPrincipalId.mockResolvedValue(null);
    const out = await resolveAssistantRuntimeConfigByPrincipal({
      assistantUserId: "cinatra-principal",
      handle: "cinatra",
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      // The Cinatra reference runtime (chat-assistant-core system skill).
      expect(out.runtimeConfig.systemSkillId).toContain("chat-assistant-core");
    }
  });

  it("fails CLOSED when the 'cinatra' handle resolves to a NON-built-in principal (no handle-string trust)", async () => {
    // An imposter principal that owns the "cinatra" handle but is NOT the built-in
    // Cinatra principal, with no linked template, must never receive the reference
    // config — the fallback verifies the persisted principal identity, not the handle.
    mocks.readAssistantConfigByPrincipalId.mockResolvedValue(null);
    const out = await resolveAssistantRuntimeConfigByPrincipal({
      assistantUserId: "imposter-principal",
      handle: "cinatra",
    });
    expect(out).toEqual({ ok: false, code: "ASSISTANT_CONFIG_UNAVAILABLE" });
    expect(mocks.isBuiltInCinatraAssistantUserId).toHaveBeenCalledWith("imposter-principal");
  });

  it("a read failure fails CLOSED (structured, never throws)", async () => {
    mocks.readAssistantConfigByPrincipalId.mockRejectedValue(new Error("db down"));
    const out = await resolveAssistantRuntimeConfigByPrincipal({
      assistantUserId: "wp-principal",
      handle: "wordpress",
    });
    expect(out).toEqual({ ok: false, code: "ASSISTANT_CONFIG_UNAVAILABLE" });
  });

  // codex convergence (PR #1827): a schema-VALID-but-degenerate persisted sidecar
  // (empty skillBundle — the P1 schema permits `[]`, the runtime-builder rejects it)
  // must fail CLOSED as a structured result, not throw out as a 500.
  it("fails CLOSED on a schema-valid but degenerate sidecar (empty skillBundle) — never throws", async () => {
    mocks.readAssistantConfigByPrincipalId.mockResolvedValue(
      JSON.stringify({ persona: "x", skillBundle: [] }),
    );
    const out = await resolveAssistantRuntimeConfigByPrincipal({
      assistantUserId: "wp-principal",
      handle: "wordpress",
    });
    expect(out).toEqual({ ok: false, code: "ASSISTANT_CONFIG_UNAVAILABLE" });
  });

  // codex convergence (PR #1827): the SECOND DB read (the persisted-identity
  // verification for the transitional @cinatra fallback) must also fail CLOSED —
  // a transient failure there yields a structured result, never a throw / 500, and
  // never the reference config.
  it("fails CLOSED when the persisted-identity verification read throws (structured, never throws)", async () => {
    mocks.readAssistantConfigByPrincipalId.mockResolvedValue(null);
    mocks.isBuiltInCinatraAssistantUserId.mockRejectedValue(new Error("db down"));
    const out = await resolveAssistantRuntimeConfigByPrincipal({
      assistantUserId: "cinatra-principal",
      handle: "cinatra",
    });
    expect(out).toEqual({ ok: false, code: "ASSISTANT_CONFIG_UNAVAILABLE" });
  });
});
