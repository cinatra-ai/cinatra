import { describe, it, expect, afterEach } from "vitest";
import { createExtensionHostContext } from "@/lib/extension-host-context";
import { __resetCapabilityRegistry } from "@/lib/extension-capabilities-registry";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

describe("createExtensionHostContext — grant-aware ports", () => {
  // The capability registry is module-global; isolate tests that register.
  afterEach(() => __resetCapabilityRegistry());

  it("ambient logger/runtime are always available, regardless of grants", () => {
    const ctx = createExtensionHostContext("@cinatra-ai/x", []);
    expect(() => ctx.logger.info("hi")).not.toThrow();
    expect(["development", "production"]).toContain(ctx.runtime.mode);
    expect(() => ctx.runtime.flag("SOME_FLAG")).not.toThrow();
  });

  it("an UNGRANTED privileged port throws NOT GRANTED on any access (least-privilege)", () => {
    const ctx = createExtensionHostContext("@cinatra-ai/x", []); // no grants
    expect(() => ctx.capabilities.registerProvider("email-send", { packageName: "@cinatra-ai/x", impl: {} })).toThrow(
      /NOT GRANTED/,
    );
    expect(() => ctx.db.query("select 1")).toThrow(/NOT GRANTED/);
    expect(() => ctx.mcp.registerTool({ name: "t", handler: () => ({}) })).toThrow(/NOT GRANTED/);
    expect(() => ctx.settings.get("k")).toThrow(/NOT GRANTED/);
  });

  it("a GRANTED-but-unwired port throws 'not implemented' (NOT the not-granted message)", () => {
    const ctx = createExtensionHostContext("@cinatra-ai/x", ["db"]);
    expect(() => ctx.db.query("select 1")).toThrow(/not implemented/i);
    let msg = "";
    try {
      ctx.db.query("select 1");
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toMatch(/not implemented/i);
    expect(msg).not.toMatch(/NOT GRANTED/);
  });

  it("GRANTED mcp exposes the real wired registerTool (no gate throw on access)", () => {
    const ctx = createExtensionHostContext("@cinatra-ai/x", ["mcp"]);
    expect(typeof ctx.mcp.registerTool).toBe("function"); // access does not throw the gate
    // an UNGRANTED mcp throws on access:
    const ungranted = createExtensionHostContext("@cinatra-ai/x", []);
    expect(() => ungranted.mcp.registerTool({ name: "t", handler: () => ({}) })).toThrow(/NOT GRANTED/);
  });

  it("GRANTED capabilities is a GENERIC host-owned registry — register+resolve round-trips; unknown resolves to []", () => {
    const ctx = createExtensionHostContext("@cinatra-ai/x", ["capabilities"]);
    // Any capability resolves (generic registry, no hardcoded/connector-imported capability) — no gate throw.
    expect(() => ctx.capabilities.resolveProviders("email-send")).not.toThrow();
    // An unknown capability returns an empty provider list (NOT a throw).
    expect(ctx.capabilities.resolveProviders("not-a-capability")).toEqual([]);
    // register → resolve round-trips for an arbitrary capability.
    ctx.capabilities.registerProvider("my-cap", { packageName: "@cinatra-ai/x", impl: { hi: true } });
    const providers = ctx.capabilities.resolveProviders("my-cap");
    expect(providers).toHaveLength(1);
    expect(providers[0]?.packageName).toBe("@cinatra-ai/x");
  });

  it("only the declared ports are exposed — granting db does NOT expose capabilities", () => {
    const ctx = createExtensionHostContext("@cinatra-ai/x", ["db"]);
    expect(() => ctx.capabilities.resolveProviders("email-send")).toThrow(/NOT GRANTED/);
  });

  it("GRANTED settings exposes the real wired port (get/set/delete are functions; ungranted throws)", () => {
    // Wired methods are present when granted (the round-trip is dev-UAT'd against a
    // real DB; here we only assert the grant gate, not DB I/O).
    const ctx = createExtensionHostContext("@cinatra-ai/x", ["settings"]);
    expect(typeof ctx.settings.get).toBe("function");
    expect(typeof ctx.settings.set).toBe("function");
    expect(typeof ctx.settings.delete).toBe("function");
    const ungranted = createExtensionHostContext("@cinatra-ai/x", []);
    expect(() => ungranted.settings.get("k")).toThrow(/NOT GRANTED/);
  });

  it("Finding 6: GRANTED objects.registerType registers SYNCHRONOUSLY (the type is present the instant register() returns — no floating Promise)", () => {
    objectTypeRegistry._clearForTests();
    const ctx = createExtensionHostContext("@cinatra-ai/x", ["objects"]);
    const TYPE = "@cinatra-ai/x:thing";
    // Calling registerType returns void (the SDK `HostObjectsPort` contract) and
    // the type MUST be resolvable immediately — proving the registration is NOT a
    // dynamic-import Promise the loader would fail to await.
    const ret = ctx.objects.registerType({ typeId: TYPE, type: TYPE, category: "data" } as never);
    expect(ret).toBeUndefined();
    expect(objectTypeRegistry.resolve(TYPE), "type registered synchronously").not.toBeNull();
    expect(objectTypeRegistry.getTypesForPackage("@cinatra-ai/x")).toEqual([TYPE]);
    objectTypeRegistry._clearForTests();
  });

  it("Finding 6: a registration FAILURE surfaces (throws) instead of being swallowed in a floating Promise", () => {
    objectTypeRegistry._clearForTests();
    const ctx = createExtensionHostContext("@cinatra-ai/x", ["objects"]);
    // A descriptor with no `type` field makes objectTypeRegistry.register throw
    // synchronously (it reads `def.type`); that throw must propagate out of
    // registerType so the loader's `await register(ctx)` records `register-threw`.
    expect(() => ctx.objects.registerType(undefined as never)).toThrow();
    objectTypeRegistry._clearForTests();
  });
});
