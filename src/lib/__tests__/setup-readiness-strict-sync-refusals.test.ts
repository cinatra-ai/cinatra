/**
 * cinatra#2094 finding F7-A, the LOUD half — the readiness saga must not report
 * "AI setup complete" while the strict catalog sync REFUSED skills.
 *
 * THE DEFECT THIS PINS: `runStrictInitialSync` discarded the sync's
 * `captureDiagnostics` entirely. On a real instance that meant the wizard
 * rendered "AI setup complete — 22 skill(s) uploaded" and committed the default
 * provider while the S2 fail-closed one-hop lint (cinatra#2089) had refused every
 * MULTI-FILE skill — including 3 of the 5 the Cinatra assistant itself requires.
 * A refused skill is a skill that WILL throw `AnthropicSkillNotSyncedError` the
 * moment a request selects it, so swallowing the refusal is precisely the
 * masquerading success strict mode exists to stop.
 *
 * The port is exercised through the REAL `createSetupReadinessPorts` with only
 * the sync service and the DB boundary mocked, so the assertion is about the
 * shipped wiring rather than a re-implementation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { syncStrictMock, listAllSyncRowsMock } = vi.hoisted(() => ({
  syncStrictMock: vi.fn(),
  listAllSyncRowsMock: vi.fn(async () => [
    { catalogSkillId: "@x/y:ok", anthropicSkillId: "skill_ok", anthropicVersion: "1", stale: false },
  ]),
}));

vi.mock("@/lib/anthropic-skill-sync-service", () => ({
  syncCatalogSkillsToAnthropicStrict: syncStrictMock,
  deriveApiKeyFingerprint: () => "fp",
  deriveEnvironmentNamespace: () => "env",
}));
vi.mock("@/lib/anthropic-skill-sync-dao", () => ({
  listAllSyncRows: listAllSyncRowsMock,
}));
vi.mock("@/lib/anthropic-skill-config-service", () => ({
  grantSetupWithAnthropicBulkConsent: vi.fn(),
}));
vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: vi.fn(() => "anthropic"),
  writeDefaultLlmProviderToDatabase: vi.fn(),
  writeAnthropicSkillSyncEnabledToDatabase: vi.fn(),
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: vi.fn(() => null),
}));

import { createSetupReadinessPorts } from "@/lib/setup-readiness-ports";

beforeEach(() => {
  syncStrictMock.mockReset();
  listAllSyncRowsMock.mockClear();
});

describe("runStrictInitialSync — refused skills are LOUD", () => {
  it("THROWS naming every refused skill and the bundled file its router misses", async () => {
    syncStrictMock.mockResolvedValue({
      ok: true,
      outcomes: [],
      captureDiagnostics: {
        authorityOwnedDivergences: [],
        danglingReferences: [],
        refusedForDanglingReferences: [
          {
            catalogSkillId: "@cinatra-ai/chat:chat-assistant-core",
            missing: ["references/chat-agent-dispatch.md"],
          },
          {
            catalogSkillId: "@cinatra-ai/chat:chat-extension-authoring",
            missing: ["references/a.md", "references/b.md"],
          },
        ],
      },
    });

    const ports = createSetupReadinessPorts();
    await expect(ports.runStrictInitialSync()).rejects.toThrow(
      /2 skill\(s\) were REFUSED by the packaging gate/,
    );
    await expect(ports.runStrictInitialSync()).rejects.toThrow(
      /@cinatra-ai\/chat:chat-assistant-core \(router references no bundled references\/chat-agent-dispatch\.md\)/,
    );
    await expect(ports.runStrictInitialSync()).rejects.toThrow(
      /@cinatra-ai\/chat:chat-extension-authoring \(router references no bundled references\/a\.md, references\/b\.md\)/,
    );
  });

  it("does NOT read the uploaded targets once it has refused (no half-success)", async () => {
    syncStrictMock.mockResolvedValue({
      ok: true,
      outcomes: [],
      captureDiagnostics: {
        authorityOwnedDivergences: [],
        danglingReferences: [],
        refusedForDanglingReferences: [{ catalogSkillId: "@x/y:broken", missing: ["r/a.md"] }],
      },
    });
    const ports = createSetupReadinessPorts();
    await expect(ports.runStrictInitialSync()).rejects.toThrow(/REFUSED/);
    expect(listAllSyncRowsMock).not.toHaveBeenCalled();
  });

  it("a clean sync (no refusals) still returns the uploaded ids", async () => {
    syncStrictMock.mockResolvedValue({ ok: true, outcomes: [] });
    const ports = createSetupReadinessPorts();
    await expect(ports.runStrictInitialSync()).resolves.toEqual({
      uploadedSkillIds: [{ skillId: "skill_ok", version: "1" }],
    });
  });

  it("diagnostics WITHOUT refusals do not fail setup (an advisory divergence is not a refusal)", async () => {
    syncStrictMock.mockResolvedValue({
      ok: true,
      outcomes: [],
      captureDiagnostics: {
        authorityOwnedDivergences: ["@x/y:diverged"],
        danglingReferences: [{ catalogSkillId: "@x/y:lint", missing: ["r/a.md"] }],
      },
    });
    const ports = createSetupReadinessPorts();
    await expect(ports.runStrictInitialSync()).resolves.toEqual({
      uploadedSkillIds: [{ skillId: "skill_ok", version: "1" }],
    });
  });
});
