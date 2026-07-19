// resolveAssistantRuntimeConfigByPrincipal (cinatra#1823, epic #1037 P4.1): the
// shared handle-generic resolution ladder that lets the AG-UI /api/assistants/chat
// endpoint serve ANY registered assistant from its PERSISTED sidecar via the
// assistant_user_id link — proving each CMS assistant resolves to its OWN config
// (not the hardcoded Cinatra fallback), a corrupt sidecar fails CLOSED, and a
// non-built-in principal with NO linked template fails CLOSED.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  readAssistantConfigByPrincipalId: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  readAssistantConfigByPrincipalId: mocks.readAssistantConfigByPrincipalId,
}));
vi.mock("@/lib/assistant-users", () => ({
  BUILT_IN_CINATRA_ASSISTANT_USERNAME: "cinatra",
}));

import { resolveAssistantRuntimeConfigByPrincipal } from "../resolve-runtime-config";
import { serializeAssistantConfig } from "@/lib/assistant-config";
import { wordpressAssistantConfig } from "../wordpress-assistant-config";

beforeEach(() => vi.clearAllMocks());

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

  it("a read failure fails CLOSED (structured, never throws)", async () => {
    mocks.readAssistantConfigByPrincipalId.mockRejectedValue(new Error("db down"));
    const out = await resolveAssistantRuntimeConfigByPrincipal({
      assistantUserId: "wp-principal",
      handle: "wordpress",
    });
    expect(out).toEqual({ ok: false, code: "ASSISTANT_CONFIG_UNAVAILABLE" });
  });
});
