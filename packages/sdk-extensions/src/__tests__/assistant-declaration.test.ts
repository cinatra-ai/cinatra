import { describe, it, expect } from "vitest";

import {
  safeParseAssistantDeclaration,
  parseAssistantDeclaration,
  projectAssistantDeclaration,
  hasAssistantBlock,
  isFlatToken,
  AssistantDeclarationError,
  type AssistantDeclarationBlock,
} from "../assistant-declaration";
import { assistantConfigSchema } from "../assistant-config-contract";

const PKG = { packageName: "@cinatra-ai/cinatra-assistant" };

const block = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  abiVersion: 1,
  displayName: "Cinatra",
  preferredTag: "cinatra",
  persona: "You are the Cinatra assistant.",
  skillBundle: ["chat-assistant-core"],
  launch: { kind: "local" },
  delivery: { kind: "host-runtime" },
  ...over,
});
const file = (assistant: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) => ({
  formatVersion: 1,
  ...(assistant ? { assistant } : {}),
  ...over,
});

describe("isFlatToken", () => {
  it("accepts normalized tokens and rejects malformed ones", () => {
    for (const t of ["cinatra", "gpt-4", "open_ai", "a1", "x-y-z"]) expect(isFlatToken(t)).toBe(true);
    // uppercase, leading/trailing separators, spaces, non-ascii, double separators
    for (const t of ["Cinatra", "-lead", "trail-", "_x", "x_", "a b", "café", "", "a--b", "a__b", "@x"]) {
      expect(isFlatToken(t)).toBe(false);
    }
    expect(isFlatToken(123)).toBe(false);
    expect(isFlatToken(null)).toBe(false);
  });
});

describe("safeParseAssistantDeclaration — happy path + projection", () => {
  it("resolves a full valid declaration and projects to a valid assistant_config", () => {
    const res = safeParseAssistantDeclaration(
      file(
        block({
          allowedTools: ["web.search"],
          allowedAgents: ["@cinatra-ai/researcher"],
          modelPrefs: { provider: "anthropic", model: "claude-opus-4-8" },
          mcp: { enabled: true, restriction: "org-members" },
        }),
      ),
      PKG,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.declaration).not.toBeNull();
    const d = res.declaration!;
    expect(d.block.displayName).toBe("Cinatra");
    expect(d.block.preferredTag).toBe("cinatra");
    expect(d.block.launch.kind).toBe("local");
    expect(d.block.delivery.kind).toBe("host-runtime");
    // projected sidecar validates against the app store schema
    expect(assistantConfigSchema.safeParse(d.assistantConfig).success).toBe(true);
    expect(d.assistantConfig.persona).toBe("You are the Cinatra assistant.");
    expect(d.assistantConfig.skillBundle).toEqual(["chat-assistant-core"]);
    expect(d.assistantConfig.allowedTools).toEqual(["web.search"]);
    expect(d.assistantConfig.modelPrefs).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
    expect(d.assistantConfig.mcp).toEqual({ enabled: true, restriction: "org-members" });
  });

  it("defaults optional allow-lists / modelPrefs in the projection", () => {
    const res = safeParseAssistantDeclaration(file(block()), PKG);
    expect(res.ok).toBe(true);
    if (!res.ok || !res.declaration) throw new Error("expected declaration");
    expect(res.declaration.assistantConfig.allowedTools).toEqual([]);
    expect(res.declaration.assistantConfig.allowedAgents).toEqual([]);
    expect(res.declaration.assistantConfig.modelPrefs).toEqual({});
    expect(res.declaration.assistantConfig.mcp).toBeUndefined();
  });

  it("resolves declaration:null for a file with no assistant block", () => {
    const res = safeParseAssistantDeclaration(file(undefined), PKG);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.declaration).toBeNull();
  });

  it("accepts a file carrying an opaque access block alongside assistant", () => {
    const res = safeParseAssistantDeclaration(
      file(block(), { access: { scope: { only: "admin" } } }),
      PKG,
    );
    expect(res.ok).toBe(true);
  });
});

describe("safeParseAssistantDeclaration — fail-closed", () => {
  const bad: Array<[string, unknown]> = [
    ["unknown top-level key", file(block(), { bogus: 1 })],
    ["wrong formatVersion", { formatVersion: 2, assistant: block() }],
    ["wrong abiVersion", file(block({ abiVersion: 2 }))],
    ["unknown key inside assistant", file(block({ extra: true }))],
    ["malformed preferredTag (uppercase)", file(block({ preferredTag: "Cinatra" }))],
    ["malformed preferredTag (leading dash)", file(block({ preferredTag: "-x" }))],
    ["empty persona", file(block({ persona: "" }))],
    ["missing skillBundle", file((() => { const b = block(); delete (b as Record<string, unknown>).skillBundle; return b; })())],
    ["bad launch kind", file(block({ launch: { kind: "sideways" } }))],
    ["bad delivery kind", file(block({ delivery: { kind: "smoke-signal" } }))],
    ["unknown key inside launch", file(block({ launch: { kind: "local", nope: 1 } }))],
    ["bad restriction enum", file(block({ mcp: { restriction: "everyone" } }))],
    ["temperature out of range", file(block({ modelPrefs: { temperature: 9 } }))],
  ];
  for (const [name, raw] of bad) {
    it(`rejects: ${name}`, () => {
      const res = safeParseAssistantDeclaration(raw, PKG);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toContain(PKG.packageName);
    });
  }
});

describe("parseAssistantDeclaration — throwing form", () => {
  it("throws AssistantDeclarationError on a malformed block", () => {
    expect(() => parseAssistantDeclaration(file(block({ preferredTag: "Bad Tag" })), PKG)).toThrow(
      AssistantDeclarationError,
    );
  });
  it("returns null for no assistant block", () => {
    expect(parseAssistantDeclaration(file(undefined), PKG)).toBeNull();
  });
});

describe("hasAssistantBlock — cheap XOR presence probe", () => {
  it("detects presence without validating", () => {
    expect(hasAssistantBlock(file(block()))).toBe(true);
    expect(hasAssistantBlock(file(block({ preferredTag: "INVALID" })))).toBe(true); // present but invalid
    expect(hasAssistantBlock(file(undefined))).toBe(false);
    expect(hasAssistantBlock({ formatVersion: 1, assistant: null })).toBe(false);
    expect(hasAssistantBlock(null)).toBe(false);
    expect(hasAssistantBlock("nope")).toBe(false);
  });
});

describe("projectAssistantDeclaration — direct", () => {
  it("projects a minimal block", () => {
    const b: AssistantDeclarationBlock = {
      abiVersion: 1,
      displayName: "X",
      preferredTag: "x",
      persona: "p",
      skillBundle: ["s"],
      launch: { kind: "remote", targetProvider: "wordpress" },
      delivery: { kind: "webhook" },
    };
    const cfg = projectAssistantDeclaration(b);
    expect(cfg.persona).toBe("p");
    expect(cfg.allowedTools).toEqual([]);
  });
});
