import { describe, it, expect, beforeEach } from "vitest";
import { createNonDefaultVersionHostContext } from "@/lib/extension-host-context";
import {
  resolveCapabilityProviders,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import { listExtensionMcpTools, _resetExtensionMcpForTests } from "@/lib/extension-mcp-registry";

// cinatra#1040 S4 — the register-only, SIDE-EFFECT-FREE host context a NON-DEFAULT
// side-by-side version activates against. It must claim NO global name and mutate
// NO package-keyed shared state (settings/secrets/objects/nango), while READS and
// least-privilege fail-loud on ungranted ports stay intact.

describe("createNonDefaultVersionHostContext (cinatra#1040 S4)", () => {
  beforeEach(() => {
    __resetCapabilityRegistry();
    _resetExtensionMcpForTests();
  });

  it("mcp.registerTool + capabilities.registerProvider claim NO global name", () => {
    const ctx = createNonDefaultVersionHostContext("@x/sibling", ["mcp", "capabilities"]);
    ctx.mcp.registerTool({ name: "sibling-tool", handler: async () => ({}) } as never);
    ctx.capabilities.registerProvider("some-capability", { packageName: "@x/sibling", impl: {} });
    // Neither reached the process-global registries the DEFAULT version owns.
    expect(listExtensionMcpTools()).toHaveLength(0);
    expect(resolveCapabilityProviders("some-capability")).toHaveLength(0);
  });

  it("settings/secrets writes + objects.write + nango.ensureConnectSession are inert no-ops (no shared-state mutation)", async () => {
    const ctx = createNonDefaultVersionHostContext("@x/sibling", [
      "settings",
      "secrets",
      "objects",
      "nango",
    ]);
    await expect(ctx.settings.set("k", "v")).resolves.toBeUndefined();
    await expect(ctx.settings.delete("k")).resolves.toBeUndefined();
    await expect(ctx.secrets.set("k", "v")).resolves.toBeUndefined();
    await expect(ctx.secrets.delete("k")).resolves.toBeUndefined();
    await expect(ctx.objects.write("t", {})).resolves.toEqual({ id: "non-default-version-noop" });
    await expect(ctx.nango.ensureConnectSession({})).resolves.toEqual({});
  });

  it("an UNGRANTED privileged port still fails loud (least-privilege preserved)", () => {
    const ctx = createNonDefaultVersionHostContext("@x/sibling", []); // nothing granted
    expect(() => ctx.settings.get("k")).toThrow();
    expect(() => ctx.mcp.registerTool({ name: "x", handler: async () => ({}) } as never)).toThrow();
  });
});
