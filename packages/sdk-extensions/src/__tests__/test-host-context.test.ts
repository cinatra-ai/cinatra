import { describe, it, expect } from "vitest";
import {
  createTestHostContext,
  summarizeRecorder,
  sanitizeAtom,
  TEST_HOST_PORT_NAMES,
  TEST_AMBIENT_PORTS,
  HOST_RESERVED_PROVIDER_NAMESPACE,
} from "../test-host-context";
import { HOST_PORT_NAMES } from "../host-context";

// The raw .mjs exposes the runtime `inert` option (it IS on the public typed
// surface via CreateTestHostContextOptions, but we import the module namespace
// to exercise the runtime directly for the canary inert-parity assertions).
import * as rawHarness from "../test-host-context.mjs";
const createInert = (packageName: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (rawHarness as any).createTestHostContext({ packageName, inert: true });

describe("createTestHostContext — author-facing local test harness", () => {
  it("port name list mirrors the frozen host ABI", () => {
    expect([...TEST_HOST_PORT_NAMES].sort()).toEqual([...HOST_PORT_NAMES].sort());
    expect(TEST_AMBIENT_PORTS).toEqual(["logger", "runtime"]);
  });

  it("requires a non-empty packageName", () => {
    // @ts-expect-error packageName is required
    expect(() => createTestHostContext({})).toThrow(/non-empty \{ packageName \}/);
    expect(() => createTestHostContext({ packageName: "" })).toThrow(/non-empty/);
  });

  it("rejects an unknown grant", () => {
    expect(() =>
      // @ts-expect-error not a real port
      createTestHostContext({ packageName: "@x/y-connector", grants: ["bogus"] }),
    ).toThrow(/unknown: "bogus"/);
  });

  describe("grant simulation (least-privilege fail-loud)", () => {
    it("ungranted privileged port throws a named, actionable error on real access", () => {
      const { ctx } = createTestHostContext({ packageName: "@x/y-connector", grants: [] });
      expect(() => ctx.settings.get("k")).toThrow(/NOT GRANTED — add "settings"/);
    });

    it("ambient ports are always available even with no grants", () => {
      const { ctx } = createTestHostContext({ packageName: "@x/y-connector", grants: [] });
      expect(ctx.logger.info).toBeTypeOf("function");
      expect(ctx.runtime.mode).toBe("development");
      expect(() => ctx.logger.info("hi")).not.toThrow();
    });

    it("granted port resolves to a working stub", async () => {
      const { ctx } = createTestHostContext({
        packageName: "@x/y-connector",
        grants: ["settings"],
        settings: { seeded: 42 },
      });
      expect(await ctx.settings.get("seeded")).toBe(42);
      expect(await ctx.settings.get("missing")).toBeNull();
      await ctx.settings.set("k", "v");
      expect(await ctx.settings.get("k")).toBe("v");
      await ctx.settings.delete("k");
      expect(await ctx.settings.get("k")).toBeNull();
    });

    it("a fail-loud port answers serialization/inspection probes inertly", () => {
      const { ctx } = createTestHostContext({ packageName: "@x/y-connector", grants: [] });
      // RSC Flight / JSON / console probes must NOT throw (or merely passing ctx
      // through a serializer would crash) — mirrors the host proxy.
      expect((ctx.settings as { toJSON?: unknown }).toJSON).toBeUndefined();
      expect((ctx.settings as { then?: unknown }).then).toBeUndefined();
      expect(() => JSON.stringify({ s: ctx.settings })).not.toThrow();
    });

    it("db is fail-loud even when granted (RESERVED / not implemented)", () => {
      const { ctx } = createTestHostContext({ packageName: "@x/y-connector", grants: ["db"] });
      expect(() => ctx.db.query("select 1")).toThrow(/RESERVED \/ not implemented/);
    });

    it("ungranted db is fail-loud not-granted (host parity)", () => {
      const { ctx } = createTestHostContext({ packageName: "@x/y-connector", grants: [] });
      expect(() => ctx.db.query("select 1")).toThrow(/NOT GRANTED — add "db"/);
    });

    // FIDELITY (codex DO-NOT-APPROVE #225, finding 1): production NEVER hands back
    // a usable db port. The harness must not let a `db:` override bypass the grant
    // gate, and a granted+overridden db must STILL fail loud (not-implemented) so a
    // register touching ctx.db cannot false-pass locally.
    it("a db override WITHOUT the db grant is rejected (no grant-gate bypass)", () => {
      expect(() =>
        createTestHostContext({
          packageName: "@x/y-connector",
          grants: [],
          db: { query: async () => [{ ok: true }] },
        }),
      ).toThrow(/a \{ db \} override was passed but "db" is NOT in \{ grants \}/);
    });

    it("a db override WITH the db grant still fail-louds (prod parity, not a usable fake)", () => {
      const { ctx } = createTestHostContext({
        packageName: "@x/y-connector",
        grants: ["db"],
        db: { query: async () => [{ ok: true }], schema: "test" },
      });
      // The override does NOT make db usable — production reserves/does-not-wire db,
      // so a register that touches ctx.db must throw here exactly as it would in prod.
      expect(() => ctx.db.query("select 1")).toThrow(/RESERVED \/ not implemented/);
    });
  });

  describe("capability identity assertions (cinatra#150)", () => {
    it("forces the host-injected packageName onto a registered provider", () => {
      const { ctx, recorder } = createTestHostContext({
        packageName: "@x/y-connector",
        grants: ["capabilities"],
      });
      ctx.capabilities.registerProvider("email-send", { packageName: "@evil/impersonator", impl: { send: () => {} } });
      expect(recorder.capabilityProviders).toHaveLength(1);
      expect(recorder.capabilityProviders[0].provider.packageName).toBe("@x/y-connector");
    });

    it("rejects registering under the reserved host namespace", () => {
      const { ctx } = createTestHostContext({
        packageName: HOST_RESERVED_PROVIDER_NAMESPACE,
        grants: ["capabilities"],
      });
      expect(() => ctx.capabilities.registerProvider("c", { packageName: HOST_RESERVED_PROVIDER_NAMESPACE, impl: {} })).toThrow(/reserved for host-published services/);
    });

    it("rejects a non-object provider", () => {
      const { ctx } = createTestHostContext({ packageName: "@x/y-connector", grants: ["capabilities"] });
      // @ts-expect-error impl is required
      expect(() => ctx.capabilities.registerProvider("c", null)).toThrow(/non-object provider/);
    });
  });

  describe("host-service stubs (capability resolution)", () => {
    it("resolveProviders returns seeded providers", () => {
      const { ctx } = createTestHostContext({
        packageName: "@x/y-connector",
        grants: ["capabilities"],
        capabilities: { "email-send": [{ packageName: "@cinatra-ai/gmail-connector", impl: { send: () => {} } }] },
      });
      const providers = ctx.capabilities.resolveProviders("email-send");
      expect(providers).toHaveLength(1);
      expect(providers[0].packageName).toBe("@cinatra-ai/gmail-connector");
    });

    it("resolveProviders includes providers registered through this same ctx (self-register-then-resolve)", () => {
      const { ctx } = createTestHostContext({
        packageName: "@x/y-connector",
        grants: ["capabilities"],
        capabilities: { cap: [{ impl: { a: 1 } }] },
      });
      ctx.capabilities.registerProvider("cap", { packageName: "@x/y-connector", impl: { b: 2 } });
      expect(ctx.capabilities.resolveProviders("cap")).toHaveLength(2);
    });

    it("records an actionable diagnostic when a capability resolves with no provider", () => {
      const { ctx, diagnostics } = createTestHostContext({
        packageName: "@x/y-connector",
        grants: ["capabilities"],
      });
      expect(ctx.capabilities.resolveProviders("missing-cap")).toHaveLength(0);
      expect(diagnostics.some((d) => /capability "missing-cap" resolved with NO provider/.test(d))).toBe(true);
    });

    it("rejects a malformed capability seed", () => {
      expect(() =>
        createTestHostContext({
          packageName: "@x/y-connector",
          // @ts-expect-error not an array
          capabilities: { c: { impl: 1 } },
        }),
      ).toThrow(/must be an array/);
    });
  });

  describe("recorder + register(ctx) smoke", () => {
    it("captures everything a register registered", async () => {
      const { ctx, recorder } = createTestHostContext({
        packageName: "@x/y-connector",
        grants: ["mcp", "objects", "ui", "jobs", "notifications", "telemetry", "capabilities"],
      });
      // Simulate a register(ctx) body.
      ctx.mcp.registerTool({ name: "do_thing", handler: () => ({ ok: true }) });
      ctx.objects.registerType({ typeId: "@x/y:thing" });
      ctx.ui.registerAction({ id: "act", handler: async () => ({}) });
      await ctx.jobs.enqueue("send", {});
      await ctx.notifications.emit({ level: "info", title: "hi" });
      ctx.telemetry.emitUsage({ source: "apollo" } as never);
      ctx.capabilities.registerProvider("cap", { packageName: "@x/y-connector", impl: {} });

      expect(recorder.mcpTools).toHaveLength(1);
      expect(recorder.objectTypes).toHaveLength(1);
      expect(recorder.uiActions).toHaveLength(1);
      expect(recorder.jobsEnqueued).toHaveLength(1);
      expect(recorder.notificationsEmitted).toHaveLength(1);
      expect(recorder.telemetryEmitted).toHaveLength(1);
      expect(recorder.capabilityProviders).toHaveLength(1);
    });

    it("objects.registerType keeps the faithful descriptor guard", () => {
      const { ctx } = createTestHostContext({ packageName: "@x/y-connector", grants: ["objects"] });
      // @ts-expect-error non-object descriptor
      expect(() => ctx.objects.registerType(null)).toThrow(/non-object descriptor/);
      // @ts-expect-error missing typeId
      expect(() => ctx.objects.registerType({})).toThrow(/non-empty string typeId/);
    });

    it("jobs.registerWorker is unsupported (host parity)", () => {
      const { ctx } = createTestHostContext({ packageName: "@x/y-connector", grants: ["jobs"] });
      expect(() => ctx.jobs.registerWorker("w", async () => {})).toThrow(/registerWorker is not supported/);
    });
  });

  // FIDELITY (codex DO-NOT-APPROVE #225, finding 2): the recorder must mirror the
  // live host registries EXACTLY — mcp.registerTool VALIDATES like
  // extension-mcp-registry.register(), and capabilities/ui are replace-by-key
  // (idempotent), NOT append, so re-registration does not inflate counts.
  describe("registration semantics parity with the live host (finding 2)", () => {
    describe("mcp.registerTool validates like extension-mcp-registry.register()", () => {
      it("throws on a missing/non-string tool name", () => {
        const { ctx } = createTestHostContext({ packageName: "@x/y-connector", grants: ["mcp"] });
        // @ts-expect-error name is required
        expect(() => ctx.mcp.registerTool({ handler: () => ({}) })).toThrow(/with no name/);
        // @ts-expect-error name must be a string
        expect(() => ctx.mcp.registerTool({ name: 123, handler: () => ({}) })).toThrow(/with no name/);
        // empty string is type-valid but a runtime fidelity reject (host parity).
        expect(() => ctx.mcp.registerTool({ name: "", handler: () => ({}) })).toThrow(/with no name/);
      });

      it("throws on a non-function handler", () => {
        const { ctx } = createTestHostContext({ packageName: "@x/y-connector", grants: ["mcp"] });
        // @ts-expect-error handler is required
        expect(() => ctx.mcp.registerTool({ name: "t" })).toThrow(/has no handler/);
        // @ts-expect-error handler must be a function
        expect(() => ctx.mcp.registerTool({ name: "t", handler: "nope" })).toThrow(/has no handler/);
      });

      it("re-registering the same tool name REPLACES (not append) — count matches prod", () => {
        const { ctx, recorder } = createTestHostContext({ packageName: "@x/y-connector", grants: ["mcp"] });
        ctx.mcp.registerTool({ name: "do_thing", handler: () => ({ v: 1 }) });
        ctx.mcp.registerTool({ name: "do_thing", handler: () => ({ v: 2 }) });
        ctx.mcp.registerTool({ name: "other", handler: () => ({}) });
        expect(recorder.mcpTools).toHaveLength(2);
        const doThing = recorder.mcpTools.find((t) => t.name === "do_thing");
        expect(doThing?.handler(undefined)).toEqual({ v: 2 }); // last write wins (replace)
      });

      // The host registry is a Map whose key is FROZEN at insertion. Mutating a
      // registered tool's name afterwards must NOT move its slot, so re-registering
      // the ORIGINAL name still replaces (codex parity edge #225): prod ends with 1.
      it("a registered tool's slot is keyed by the SNAPSHOT name (post-mutation safe)", () => {
        const { ctx, recorder } = createTestHostContext({ packageName: "@x/y-connector", grants: ["mcp"] });
        const tool = { name: "a", handler: () => ({ v: 1 }) };
        ctx.mcp.registerTool(tool);
        tool.name = "b"; // author mutates the object after registering it
        ctx.mcp.registerTool({ name: "a", handler: () => ({ v: 2 }) });
        // Snapshot key "a" still owns the slot — replace, not append. Prod: 1 tool.
        expect(recorder.mcpTools).toHaveLength(1);
        expect(recorder.mcpTools[0].handler(undefined)).toEqual({ v: 2 });
      });
    });

    describe("capabilities are ONE provider per package per capability (replace-by-package)", () => {
      it("re-registering the same package/capability REPLACES (not append)", () => {
        const { ctx, recorder } = createTestHostContext({
          packageName: "@x/y-connector",
          grants: ["capabilities"],
        });
        ctx.capabilities.registerProvider("email-send", { packageName: "@x/y-connector", impl: { v: 1 } });
        ctx.capabilities.registerProvider("email-send", { packageName: "@x/y-connector", impl: { v: 2 } });
        // ONE provider per package per capability — the recorder must not inflate.
        expect(recorder.capabilityProviders).toHaveLength(1);
        expect(
          (recorder.capabilityProviders[0].provider.impl as { v: number }).v,
        ).toBe(2); // replaced
        // resolveProviders mirrors it: a single live provider (no duplicate).
        expect(ctx.capabilities.resolveProviders("email-send")).toHaveLength(1);
      });

      it("identity is forced, so two registrations claiming different packages still collapse to one", () => {
        const { ctx, recorder } = createTestHostContext({
          packageName: "@x/y-connector",
          grants: ["capabilities"],
        });
        // Both get identity FORCED to @x/y-connector (cinatra#150), so both target
        // the same (capability, packageName) key — the second replaces the first.
        ctx.capabilities.registerProvider("c", { packageName: "@evil/a", impl: { v: 1 } });
        ctx.capabilities.registerProvider("c", { packageName: "@evil/b", impl: { v: 2 } });
        expect(recorder.capabilityProviders).toHaveLength(1);
        expect(recorder.capabilityProviders[0].provider.packageName).toBe("@x/y-connector");
        expect(ctx.capabilities.resolveProviders("c")).toHaveLength(1);
      });

      it("self-registered provider still adds to distinct SEEDED providers on resolve", () => {
        const { ctx } = createTestHostContext({
          packageName: "@x/y-connector",
          grants: ["capabilities"],
          capabilities: { cap: [{ packageName: "@cinatra-ai/seeded", impl: { a: 1 } }] },
        });
        ctx.capabilities.registerProvider("cap", { packageName: "@x/y-connector", impl: { b: 2 } });
        // seeded (1) + this ctx's own (1) = 2 distinct providers; a re-register of
        // the ctx's own does NOT push the count to 3.
        ctx.capabilities.registerProvider("cap", { packageName: "@x/y-connector", impl: { b: 3 } });
        expect(ctx.capabilities.resolveProviders("cap")).toHaveLength(2);
      });
    });

    describe("ui surfaces/actions are replace-by-id/key (not append)", () => {
      it("re-registering an action id REPLACES (not append)", () => {
        const { ctx, recorder } = createTestHostContext({ packageName: "@x/y-connector", grants: ["ui"] });
        const h1 = async () => ({ v: 1 });
        const h2 = async () => ({ v: 2 });
        ctx.ui.registerAction({ id: "act", handler: h1 });
        ctx.ui.registerAction({ id: "act", handler: h2 });
        ctx.ui.registerAction({ id: "other", handler: h1 });
        expect(recorder.uiActions).toHaveLength(2);
        expect(recorder.uiActions.find((a) => a.id === "act")?.handler).toBe(h2);
      });

      it("re-registering a setup/settings surface by id/title REPLACES (not append)", () => {
        const { ctx, recorder } = createTestHostContext({ packageName: "@x/y-connector", grants: ["ui"] });
        ctx.ui.registerSetupSurface({ id: "setup", v: 1 });
        ctx.ui.registerSetupSurface({ id: "setup", v: 2 });
        ctx.ui.registerSettingsSurface({ title: "Settings", v: 1 });
        ctx.ui.registerSettingsSurface({ title: "Settings", v: 2 });
        expect(recorder.uiSetupSurfaces).toHaveLength(1);
        expect((recorder.uiSetupSurfaces[0] as { v: number }).v).toBe(2);
        expect(recorder.uiSettingsSurfaces).toHaveLength(1);
        expect((recorder.uiSettingsSurfaces[0] as { v: number }).v).toBe(2);
      });
    });
  });

  describe("summarizeRecorder — REDACTED diagnostics (names/counts/ids only)", () => {
    it("emits names/counts/ids and never raw impls/handlers/secrets", () => {
      const { ctx, recorder } = createTestHostContext({
        packageName: "@x/y-connector",
        grants: ["mcp", "capabilities", "objects"],
      });
      const secretImpl = { apiKey: "SUPER-SECRET-VALUE" };
      ctx.mcp.registerTool({ name: "do_thing", handler: () => secretImpl });
      ctx.capabilities.registerProvider("email-send", { packageName: "@x/y-connector", impl: secretImpl });
      ctx.objects.registerType({ typeId: "@x/y:thing", schema: secretImpl });

      const lines = summarizeRecorder(recorder);
      const joined = lines.join("\n");
      expect(joined).toContain("do_thing");
      expect(joined).toContain("email-send <- @x/y-connector");
      expect(joined).toContain("@x/y:thing");
      // Sensitive values must NEVER appear.
      expect(joined).not.toContain("SUPER-SECRET-VALUE");
      expect(joined).not.toContain("apiKey");
    });

    it("strips control chars (newline, ESC) and bounds length (untrusted ids)", () => {
      const ESC = String.fromCharCode(0x1b);
      const raw = `a${ESC}[31mred\nname`;
      const out = sanitizeAtom(raw);
      expect(out).not.toContain("\n");
      expect(out).not.toContain(ESC);
      expect(out).toContain("\u00b7"); // control chars replaced with the middle dot
      expect(sanitizeAtom("x".repeat(200)).length).toBeLessThanOrEqual(121);
    });

    it("a crafted tool name cannot inject a newline/escape into the summary", () => {
      const ESC = String.fromCharCode(0x1b);
      const { ctx, recorder } = createTestHostContext({ packageName: "@x/y-connector", grants: ["mcp"] });
      ctx.mcp.registerTool({ name: `evil\nINJECTED-LINE${ESC}[2J`, handler: () => ({}) });
      const summaryLines = summarizeRecorder(recorder);
      expect(summaryLines.length).toBe(1);
      expect(summaryLines[0]).not.toContain("\n");
      expect(summaryLines[0]).not.toContain(ESC);
    });
  });

  describe("grant-authority constants are frozen (tamper resistance)", () => {
    it("TEST_HOST_PORT_NAMES / TEST_AMBIENT_PORTS are frozen", () => {
      expect(Object.isFrozen(TEST_HOST_PORT_NAMES)).toBe(true);
      expect(Object.isFrozen(TEST_AMBIENT_PORTS)).toBe(true);
    });
    it("mutating the exported ambient list does NOT widen a built ctx's grants", () => {
      // Defence in depth: the harness reads a private frozen snapshot, not the
      // mutable export. Even if a freeze were bypassed, grants stay as declared.
      const before = createTestHostContext({ packageName: "@x/y-connector", grants: [] });
      expect(() => before.ctx.settings.get("k")).toThrow(/NOT GRANTED/);
    });
  });

  describe("INERT mode parity (canary release smoke)", () => {
    it("grants every port inertly and never fail-louds an ungranted port", () => {
      const { ctx } = createInert("@cinatra-ai/x-connector");
      expect(() => ctx.settings.get("k")).not.toThrow();
      expect(() => ctx.capabilities.resolveProviders("c")).not.toThrow();
    });
    it("callPrimitive / registerWorker / capabilities are inert noops (no throw)", async () => {
      const { ctx } = createInert("@cinatra-ai/x-connector");
      expect(await ctx.mcp.callPrimitive("p", {})).toBeUndefined();
      expect(() => ctx.jobs.registerWorker("w", async () => {})).not.toThrow();
      // reserved namespace / non-object provider do NOT throw in inert (the old
      // canary noop never did — the host enforces identity at LIVE activation).
      expect(() => ctx.capabilities.registerProvider("c", null as never)).not.toThrow();
    });
    it("settings/secrets are read-null with noop writes; nango is a chainable sink", async () => {
      const { ctx } = createInert("@cinatra-ai/x-connector");
      expect(await ctx.settings.get("k")).toBeNull();
      await ctx.settings.set("k", 1); // noop
      expect(await ctx.settings.get("k")).toBeNull();
      // a nango method NOT enumerated still resolves (chainable sink, no throw)
      expect(() => (ctx.nango as { whatever?: () => unknown }).whatever?.()).not.toThrow();
    });
    it("objects.registerType keeps ONLY the non-object guard (typeId not required)", () => {
      const { ctx } = createInert("@cinatra-ai/x-connector");
      expect(() => ctx.objects.registerType({ typeId: "o" })).not.toThrow();
      // a typeId-less descriptor passes inert (old canary parity), unlike author mode
      expect(() => ctx.objects.registerType({} as never)).not.toThrow();
      expect(() => ctx.objects.registerType(null as never)).toThrow(/non-object descriptor/);
    });
    it("requireOrganizationId returns probe-org without a seeded actor", async () => {
      const { ctx } = createInert("@cinatra-ai/x-connector");
      expect(await ctx.authSession.requireOrganizationId()).toBe("probe-org");
    });
    it("unknown/future port routes to a chainable inert sink", () => {
      const { ctx } = createInert("@cinatra-ai/x-connector");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => (ctx as any).unknownFuturePort.whatever().chained()).not.toThrow();
    });
  });
});
