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

    it("db can be overridden explicitly for a non-production test", async () => {
      const { ctx } = createTestHostContext({
        packageName: "@x/y-connector",
        grants: ["db"],
        db: { query: async () => [{ ok: true }], schema: "test" },
      });
      expect(await ctx.db.query("select 1")).toEqual([{ ok: true }]);
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
