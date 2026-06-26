import { describe, it, expect, beforeEach } from "vitest";
import {
  registerExtensionMcpTool,
  markEffectiveExtensionMcpTools,
  _resetExtensionMcpForTests,
} from "@/lib/extension-mcp-registry";
import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import {
  registerExtensionSetupSurface,
  registerExtensionUiAction,
  __resetExtensionUiRegistry,
} from "@/lib/extension-ui-registry";
import { teardownExtensionCapabilities } from "@/lib/extension-capability-teardown";
import { getExtensionControlPlaneState } from "@/lib/extension-control-plane";
import {
  getActivationGeneration,
  __resetActivationGenerationForTests,
} from "@/lib/extension-activation-generation";

beforeEach(() => {
  _resetExtensionMcpForTests();
  __resetCapabilityRegistry();
  __resetExtensionUiRegistry();
  __resetActivationGenerationForTests();
});

describe("extension control-plane snapshot + generation-on-teardown", () => {
  it("aggregates the live registries — names/ids/counts only, scope process-local", () => {
    registerExtensionMcpTool("@cinatra-ai/foo", { name: "foo_tool", handler: () => ({}) });
    markEffectiveExtensionMcpTools([{ name: "foo_tool", packageName: "@cinatra-ai/foo" }]);
    registerCapabilityProvider("email-send", { packageName: "@cinatra-ai/foo", impl: { send: () => {} } });
    registerExtensionSetupSurface("@cinatra-ai/foo", { id: "setup-1" });
    registerExtensionUiAction({ packageName: "@cinatra-ai/foo", id: "do-thing", handler: async () => ({}) });

    const state = getExtensionControlPlaneState();
    expect(state.scope).toBe("process-local");
    expect(state.mcpTools).toEqual([{ name: "foo_tool", packageName: "@cinatra-ai/foo" }]);
    expect(state.capabilityProviders).toEqual([{ capability: "email-send", packageName: "@cinatra-ai/foo" }]);
    expect(state.uiSurfaces).toEqual([
      { packageName: "@cinatra-ai/foo", setupSurfaces: 1, settingsSurfaces: 0, actionIds: ["do-thing"] },
    ]);
    // No handler / impl / payload leaks into the snapshot.
    expect(JSON.stringify(state)).not.toContain("function");
    const cap = state.capabilityProviders[0] as Record<string, unknown>;
    expect(cap.impl).toBeUndefined();
  });

  it("teardown of a package with live registrations bumps the control-plane generation", () => {
    registerExtensionMcpTool("@cinatra-ai/foo", { name: "foo_tool", handler: () => ({}) });
    registerExtensionUiAction({ packageName: "@cinatra-ai/foo", id: "do-thing", handler: async () => ({}) });
    expect(getActivationGeneration()).toBe(0);

    const { removedTools } = teardownExtensionCapabilities("@cinatra-ai/foo");
    expect(removedTools).toEqual(["foo_tool"]);
    // Generation advanced — the teardown changed the live surface.
    expect(getActivationGeneration()).toBe(1);

    // The snapshot reflects the removal.
    const state = getExtensionControlPlaneState();
    expect(state.mcpTools).toHaveLength(0);
    expect(state.uiSurfaces).toHaveLength(0);
    expect(state.generation).toBe(1);
    expect(state.lastTransitions.at(-1)).toMatchObject({
      reason: "teardown",
      packageName: "@cinatra-ai/foo",
      generation: 1,
    });
  });

  it("teardown of a PROVIDER-ONLY package (no tools/types/ui) still bumps the generation", () => {
    // A capability provider is in the operator snapshot, so removing it IS an
    // observable control-plane change — the guard must cover a provider-only package.
    registerCapabilityProvider("email-send", { packageName: "@cinatra-ai/only-provider", impl: {} });
    expect(getActivationGeneration()).toBe(0);

    const { removedTools, removedTypes } = teardownExtensionCapabilities("@cinatra-ai/only-provider");
    expect(removedTools).toEqual([]);
    expect(removedTypes).toEqual([]);
    expect(getActivationGeneration()).toBe(1);
    expect(getExtensionControlPlaneState().capabilityProviders).toHaveLength(0);
  });

  it("a no-op defensive teardown (nothing registered) does NOT bump the generation", () => {
    // This mirrors the hot-activate path that fires teardown defensively before a
    // clean install/reactivate — there is nothing to remove, so no spurious bump.
    expect(getActivationGeneration()).toBe(0);
    const { removedTools, removedTypes } = teardownExtensionCapabilities("@cinatra-ai/never-registered");
    expect(removedTools).toEqual([]);
    expect(removedTypes).toEqual([]);
    expect(getActivationGeneration()).toBe(0);
  });
});
