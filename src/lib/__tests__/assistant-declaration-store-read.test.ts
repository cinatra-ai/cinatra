import { describe, it, expect } from "vitest";
import {
  resolveAssistantDeclarationFromStoreRecord,
  AssistantStoreDeclarationError,
} from "@/lib/assistant-declaration-store-read";

// The host-side parser-consumption seam at the production store read (#1874 W1):
// the pure loader carries the raw agent assistant declaration; THIS validates it
// through the single shared parser, fail-closed.

const validRaw = {
  formatVersion: 1,
  assistant: {
    abiVersion: 1,
    displayName: "Cinatra",
    preferredTag: "cinatra",
    persona: "You are Cinatra.",
    skillBundle: ["chat-assistant-core"],
    launch: { kind: "local" as const },
    delivery: { kind: "host-runtime" as const },
  },
};

describe("resolveAssistantDeclarationFromStoreRecord", () => {
  it("returns null when the record carries no assistant declaration", () => {
    expect(resolveAssistantDeclarationFromStoreRecord({ packageName: "@x/plain-agent" })).toBeNull();
  });

  it("resolves + validates a well-formed carried declaration through the shared parser", () => {
    const decl = resolveAssistantDeclarationFromStoreRecord({
      packageName: "@cinatra-ai/cinatra-assistant",
      assistantConfigRaw: validRaw,
    });
    expect(decl).not.toBeNull();
    expect(decl?.block.preferredTag).toBe("cinatra");
    expect(decl?.block.displayName).toBe("Cinatra");
    // the projected sidecar the agent_templates.assistant_config column receives
    expect(decl?.assistantConfig.persona).toBe("You are Cinatra.");
  });

  it("THROWS fail-closed on a present-but-unparseable config (invalidAssistantConfigDeclared)", () => {
    expect(() =>
      resolveAssistantDeclarationFromStoreRecord({
        packageName: "@x/torn",
        invalidAssistantConfigDeclared: true,
      }),
    ).toThrow(AssistantStoreDeclarationError);
  });

  it("RETHROWS the shared parser error on a malformed carried block (never silently no-assistant)", () => {
    const badRaw = { formatVersion: 1, assistant: { ...validRaw.assistant, preferredTag: "Not A Token" } };
    expect(() =>
      resolveAssistantDeclarationFromStoreRecord({ packageName: "@x/bad", assistantConfigRaw: badRaw }),
    ).toThrow(/assistant-declaration/);
  });

  it("REJECTS an unknown top-level key (fail-closed strict file schema)", () => {
    const strayRaw = { ...validRaw, bogus: true };
    expect(() =>
      resolveAssistantDeclarationFromStoreRecord({ packageName: "@x/stray", assistantConfigRaw: strayRaw }),
    ).toThrow();
  });
});
