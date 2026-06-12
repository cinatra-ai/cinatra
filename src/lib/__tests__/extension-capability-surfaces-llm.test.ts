// Lazy/guarded host-access cutover — the LLM cluster's
// `llm-provider-surface` capability resolution. The host names no LLM
// connector package; campaign actions / setup / telemetry / logging / routes
// resolve each provider's surface at call time and DEGRADE per feature when
// no provider is registered.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import {
  getLlmProviderSurface,
  listLlmProviderSurfaces,
  requireLlmProviderSurface,
} from "@/lib/llm-provider-surfaces";

beforeEach(() => {
  __resetCapabilityRegistry();
  vi.clearAllMocks();
});

function registerSurface(providerId: string, members: Record<string, unknown> = {}) {
  registerCapabilityProvider("llm-provider-surface", {
    packageName: `@v/${providerId}-connector`,
    impl: { providerId, ...members },
  });
}

describe("llm-provider-surface resolution", () => {
  it("degrades to null/[] with an empty registry; require* throws the descriptive degraded error", () => {
    expect(getLlmProviderSurface("openai")).toBeNull();
    expect(listLlmProviderSurfaces()).toEqual([]);
    expect(() => requireLlmProviderSurface("openai")).toThrow(/not installed\/active/);
  });

  it("resolves surfaces by providerId and skips structurally-invalid impls", () => {
    registerCapabilityProvider("llm-provider-surface", {
      packageName: "@v/broken",
      impl: { notAProvider: true },
    });
    registerSurface("openai", { logDirectory: "/logs/openai" });
    registerSurface("gemini", { logDirectory: "/logs/gemini" });
    expect(getLlmProviderSurface("openai")?.logDirectory).toBe("/logs/openai");
    expect(getLlmProviderSurface("anthropic")).toBeNull();
    expect(listLlmProviderSurfaces().map((s) => s.providerId).sort()).toEqual([
      "gemini",
      "openai",
    ]);
  });

  // LLM provider adapter cutover (cinatra#151 Stage 2): the packages/llm
  // adapter members ride the SAME surface — buildRequestHeaders /
  // writeLogFile / the GATED shellTools pair resolve per provider and stay
  // undefined (degrading per the packages/llm call-site rules) when a
  // provider has not registered them.
  it("resolves the Stage 2 adapter members per provider; absence stays undefined", async () => {
    const writeLogFile = vi.fn(async (_input: unknown) => {});
    const runCommandInDocker = vi.fn(async (_input: unknown) => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
    }));
    registerSurface("openai", {
      writeLogFile,
      shellTools: { readSettings: () => ({ maxOutputKilobytes: 64 }), runCommandInDocker },
    });
    registerSurface("gemini", {
      buildRequestHeaders: (input: { apiKey?: string }) =>
        input.apiKey ? { "x-goog-api-key": input.apiKey } : {},
      writeLogFile: vi.fn(async (_input: unknown) => {}),
    });
    registerSurface("anthropic", {});

    const openai = getLlmProviderSurface("openai");
    await openai?.writeLogFile?.({ label: "l", kind: "request", body: {} });
    expect(writeLogFile).toHaveBeenCalledTimes(1);
    expect(openai?.shellTools?.readSettings()).toEqual({ maxOutputKilobytes: 64 });
    await expect(
      openai?.shellTools?.runCommandInDocker({ shellCommand: "echo hi" }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "ok" });

    const gemini = getLlmProviderSurface("gemini");
    expect(gemini?.buildRequestHeaders?.({ apiKey: "k" })).toEqual({ "x-goog-api-key": "k" });

    // anthropic registered none of the Stage 2 members — all stay undefined
    // (packages/llm degrades per call site: null connection / no-op logging /
    // fail-loud shell).
    const anthropic = getLlmProviderSurface("anthropic");
    expect(anthropic?.writeLogFile).toBeUndefined();
    expect(anthropic?.buildRequestHeaders).toBeUndefined();
    expect(anthropic?.shellTools).toBeUndefined();
  });
});

describe("campaign-action degraded modes (R6)", () => {
  // The wrapper server actions in src/app/campaigns/actions.ts resolve the
  // surface at INVOCATION time. Import the module once here (it is heavy);
  // each wrapper is exercised against an empty registry (absent connector)
  // and a registered one (FormData passthrough + result propagation).
  it("openai save/clear/skills wrappers throw the descriptive degraded error when the connector is absent", async () => {
    const actions = await import("@/app/campaigns/actions");
    await expect(actions.saveOpenAIConnectionAction(new FormData())).rejects.toThrow(
      /openai.*not installed\/active/i,
    );
    await expect(actions.clearOpenAIConnectionAction()).rejects.toThrow(
      /openai.*not installed\/active/i,
    );
    await expect(actions.saveOpenAISkillsSettingsAction(new FormData())).rejects.toThrow(
      /openai.*not installed\/active/i,
    );
  });

  it("openai save wrapper passes the FormData through to the connector action impl", async () => {
    const saveConnection = vi.fn(async (_formData: FormData) => {});
    registerSurface("openai", { actions: { saveConnection } });
    const actions = await import("@/app/campaigns/actions");
    const formData = new FormData();
    formData.set("apiKey", "sk-test");
    await actions.saveOpenAIConnectionAction(formData);
    expect(saveConnection).toHaveBeenCalledTimes(1);
    expect(saveConnection.mock.calls[0]?.[0]).toBe(formData);
  });

  it("a redirect thrown by the connector action propagates through the wrapper (NEXT_REDIRECT semantics)", async () => {
    const redirectErr = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/x" });
    registerSurface("openai", {
      actions: {
        saveConnection: async () => {
          throw redirectErr;
        },
      },
    });
    const actions = await import("@/app/campaigns/actions");
    await expect(actions.saveOpenAIConnectionAction(new FormData())).rejects.toBe(redirectErr);
  });

  it("anthropic clear wrapper degrades with the descriptive error; save validates against the surface allow-list", async () => {
    const actions = await import("@/app/campaigns/actions");
    await expect(actions.clearAnthropicConnectionAction()).rejects.toThrow(
      /anthropic.*not installed\/active/i,
    );
    const saveAPISettings = vi.fn(async () => {});
    registerSurface("anthropic", { saveAPISettings });
    const formData = new FormData();
    formData.set("apiKey", "sk-ant");
    await actions.saveAnthropicConnectionAction(formData);
    expect(saveAPISettings).toHaveBeenCalledWith({ apiKey: "sk-ant" });
  });
});
