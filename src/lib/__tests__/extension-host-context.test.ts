import { describe, it, expect, afterEach } from "vitest";
import { createExtensionHostContext, createExtensionProbeHostContext } from "@/lib/extension-host-context";
import { __resetCapabilityRegistry, resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";
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

  it("a fail-loud port survives serialization/inspection probes (RSC Flight / JSON / thenable) but still fails loud on real use", () => {
    // Regression: the connector setup dispatch route passes the whole grant-aware
    // ctx as a prop to a server-component setup page. React's RSC Flight serializer
    // probes `toJSON` (and the thenable / element-type hooks) on every value in the
    // element tree. When those probes THREW, the page rendered 200 but the browser's
    // Flight client crashed with "Cannot create property 'debugLocation' on string
    // '… host port \"db\".toJSON accessed but NOT GRANTED …'". Probes must answer
    // inertly; only REAL port-method access fails loud.
    const ungranted = createExtensionHostContext("@cinatra-ai/x", []); // db NOT granted
    const probe = ungranted.db as unknown as Record<string | symbol, unknown>;
    expect(() => probe.toJSON).not.toThrow();
    expect(probe.toJSON).toBeUndefined();
    expect(() => probe.then).not.toThrow();
    expect(() => probe.$$typeof).not.toThrow();
    expect(() => probe[Symbol.toPrimitive]).not.toThrow();
    expect(() => probe[Symbol.toStringTag]).not.toThrow();
    // JSON-serializing an object that holds the fail-loud proxy must not throw
    // (it serializes as an inert empty object).
    expect(() => JSON.stringify({ ctx: { db: ungranted.db } })).not.toThrow();
    // …but a REAL port method still fails loud (least-privilege preserved).
    expect(() => (ungranted.db as { query: (s: string) => unknown }).query("select 1")).toThrow(
      /NOT GRANTED/,
    );

    // Same tolerance for a GRANTED-but-unwired port (db is intentionally unwired):
    // it must serialize inertly yet fail loud ("not implemented") on real use.
    const granted = createExtensionHostContext("@cinatra-ai/x", ["db"]);
    expect((granted.db as unknown as Record<string, unknown>).toJSON).toBeUndefined();
    expect(() => JSON.stringify({ db: granted.db })).not.toThrow();
    expect(() => (granted.db as { query: (s: string) => unknown }).query("select 1")).toThrow(
      /not implemented/i,
    );
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

  // --- cinatra#150: capability-provider identity is HOST-injected, never caller-supplied ---

  it("an extension CANNOT register a capability under ANOTHER extension's packageName — identity is forced to the registering extension (cinatra#150)", () => {
    const ctx = createExtensionHostContext("@cinatra-ai/attacker", ["capabilities"]);
    // The attacker supplies a FOREIGN identity (impersonating the victim).
    ctx.capabilities.registerProvider("email-send", {
      packageName: "@cinatra-ai/resend-connector",
      impl: { evil: true },
    });
    const providers = resolveCapabilityProviders("email-send");
    expect(providers).toHaveLength(1);
    // The registered identity is the HOST-injected registering package, NOT the
    // forged one — so the attacker cannot masquerade as the victim provider.
    expect(providers[0]?.packageName).toBe("@cinatra-ai/attacker");
    expect(providers.some((p) => p.packageName === "@cinatra-ai/resend-connector")).toBe(false);
    // A consumer that resolves "the resend-connector provider" never matches the
    // attacker's registration.
    expect(
      resolveCapabilityProviders("email-send").find((p) => p.packageName === "@cinatra-ai/resend-connector"),
    ).toBeUndefined();
  });

  it("an extension CANNOT claim the reserved @cinatra-ai/host:* namespace via the capabilities port (cinatra#150)", () => {
    // An extension whose own (host-injected) identity is the reserved host
    // namespace is rejected outright — only host-trusted DIRECT registrations
    // may publish under @cinatra-ai/host[:service].
    const exactHost = createExtensionHostContext("@cinatra-ai/host", ["capabilities"]);
    expect(() =>
      exactHost.capabilities.registerProvider("email-routing", { packageName: "@cinatra-ai/host", impl: {} }),
    ).toThrow(/reserved/i);

    const hostService = createExtensionHostContext("@cinatra-ai/host:email-routing", ["capabilities"]);
    expect(() =>
      hostService.capabilities.registerProvider("email-routing", {
        packageName: "@cinatra-ai/host:email-routing",
        impl: {},
      }),
    ).toThrow(/reserved/i);

    // Even when a NON-host extension supplies a forged host identity, it is
    // overridden to the extension's own identity (never lands in the host
    // namespace) — the registration succeeds under the extension's real name.
    const ext = createExtensionHostContext("@cinatra-ai/x", ["capabilities"]);
    ext.capabilities.registerProvider("email-routing", { packageName: "@cinatra-ai/host:email-routing", impl: {} });
    const routed = resolveCapabilityProviders("email-routing");
    expect(routed).toHaveLength(1);
    expect(routed[0]?.packageName).toBe("@cinatra-ai/x");
  });

  it("legitimate self-registration still works — an extension registering under its OWN identity round-trips (cinatra#150)", () => {
    const ctx = createExtensionHostContext("@cinatra-ai/resend-connector", ["capabilities"]);
    ctx.capabilities.registerProvider("email-send", {
      packageName: "@cinatra-ai/resend-connector",
      impl: { id: "resend" },
    });
    const providers = resolveCapabilityProviders("email-send");
    expect(providers).toHaveLength(1);
    expect(providers[0]?.packageName).toBe("@cinatra-ai/resend-connector");
    // Opaque placeholder impl — this test exercises identity-bound self-
    // registration round-trip, not the email-send surface; cast through unknown
    // (the typed overload narrows `impl` to the mapped EmailConnector surface).
    expect((providers[0]?.impl as unknown as { id: string }).id).toBe("resend");
  });

  it("the hot-update PROBE path enforces the SAME identity binding — forged identity is recorded as the real package, host namespace rejected (cinatra#150)", () => {
    const { ctx, recorder } = createExtensionProbeHostContext("@cinatra-ai/attacker", ["capabilities"]);
    // A forged foreign identity in the probe is recorded under the registering
    // package, not the forgery (so pre-verify reflects the real activation).
    ctx.capabilities.registerProvider("email-send", {
      packageName: "@cinatra-ai/resend-connector",
      impl: { evil: true },
    });
    expect(recorder.capabilityProviders).toHaveLength(1);
    expect((recorder.capabilityProviders[0]?.provider as { packageName: string }).packageName).toBe(
      "@cinatra-ai/attacker",
    );

    // A probe whose own identity is the reserved host namespace is rejected too.
    const hostProbe = createExtensionProbeHostContext("@cinatra-ai/host", ["capabilities"]);
    expect(() =>
      hostProbe.ctx.capabilities.registerProvider("email-routing", { packageName: "@cinatra-ai/host", impl: {} }),
    ).toThrow(/reserved/i);
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
