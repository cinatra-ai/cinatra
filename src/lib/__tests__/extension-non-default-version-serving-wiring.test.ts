import { describe, it, expect, beforeEach } from "vitest";
import { runStaticBundleActivation, type LoaderRecord } from "@cinatra-ai/sdk-extensions";
import {
  createNonDefaultVersionHostContext,
  createExtensionHostContext,
} from "@/lib/extension-host-context";
import {
  beginVersionKeyedRegistration,
  resolveVersionKeyedMcpTool,
  resolveVersionKeyedCapabilityProviders,
  resolveVersionKeyedObjectType,
  resolveVersionKeyedUiActions,
  isVersionKeyedServable,
  __resetVersionKeyedServingForTests,
  type VersionKeyedRegistrationSink,
} from "@/lib/extension-version-keyed-serving";
import {
  resolveCapabilityProviders,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import { listExtensionMcpTools, _resetExtensionMcpForTests } from "@/lib/extension-mcp-registry";

// cinatra#1392 Gap 1 — the version-keyed serving WIRING through the real
// non-default host context: register-channel registrations RETAIN into a
// host-provided sink (never the global/default registries), the same
// identity/authorization guards + grant-gating the live port applies are
// preserved, and the real loader driver's commit/abort settles servability.

const SIB = "@x/sibling"; // NOT first-party (absent from STATIC_EXTENSION_MANIFEST)
const V = "1.2.3";

beforeEach(() => {
  __resetVersionKeyedServingForTests();
  __resetCapabilityRegistry();
  _resetExtensionMcpForTests();
});

describe("createNonDefaultVersionHostContext(sink) — retention + guards + grant-gating", () => {
  it("retains each register-channel kind into the sink, NOT the global registries", () => {
    const sink = beginVersionKeyedRegistration(SIB, V);
    const ctx = createNonDefaultVersionHostContext(SIB, ["mcp", "capabilities", "objects", "ui"], {}, sink);
    ctx.mcp.registerTool({ name: "sib_tool", handler: async () => ({ ok: 1 }) } as never);
    ctx.capabilities.registerProvider("sib-cap", { packageName: SIB, impl: { hi: true } });
    ctx.objects.registerType({ typeId: `${SIB}:thing`, category: "data" } as never);
    ctx.ui.registerAction({ id: "act", handler: async () => ({}) });

    // Nothing leaked to the process-global registries the DEFAULT version owns.
    expect(listExtensionMcpTools()).toHaveLength(0);
    expect(resolveCapabilityProviders("sib-cap")).toHaveLength(0);

    // Retained, but not servable until committed (fail-closed pre-commit).
    expect(isVersionKeyedServable(SIB, V)).toBe(false);
    sink.commit();

    expect(resolveVersionKeyedMcpTool(SIB, V, "sib_tool").kind).toBe("serve");
    expect(resolveVersionKeyedCapabilityProviders(SIB, V, "sib-cap").kind).toBe("serve");
    expect(resolveVersionKeyedObjectType(SIB, V, `${SIB}:thing`).kind).toBe("serve");
    expect(resolveVersionKeyedUiActions(SIB, V).kind).toBe("serve");
  });

  it("FORCES the authoritative provider identity — a forged provider.packageName is overridden", () => {
    const sink = beginVersionKeyedRegistration(SIB, V);
    const ctx = createNonDefaultVersionHostContext(SIB, ["capabilities"], {}, sink);
    ctx.capabilities.registerProvider("sib-cap", { packageName: "@evil/impersonator", impl: {} });
    sink.commit();
    const served = resolveVersionKeyedCapabilityProviders(SIB, V, "sib-cap");
    expect(served.kind).toBe("serve");
    if (served.kind === "serve") {
      expect(served.value).toHaveLength(1);
      expect(served.value[0].packageName).toBe(SIB); // forced, not the forged identity
    }
  });

  it("DENIES a non-first-party sibling registering a reserved host-system capability (anti-poisoning)", () => {
    const sink = beginVersionKeyedRegistration(SIB, V);
    const ctx = createNonDefaultVersionHostContext(SIB, ["capabilities"], {}, sink);
    expect(() =>
      ctx.capabilities.registerProvider("nango-system", { packageName: SIB, impl: {} }),
    ).toThrow(/system capability/i);
    // The poison never entered the version-keyed store either — a point lookup for
    // the reserved capability refuses NO_SUCH_HANDLER.
    sink.commit();
    const r = resolveVersionKeyedCapabilityProviders(SIB, V, "nango-system");
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.code).toBe("NO_SUCH_HANDLER");
  });

  it("preserves grant-gating: an UNGRANTED register-channel port stays fail-loud (no retention)", () => {
    const sink = beginVersionKeyedRegistration(SIB, V);
    const ctx = createNonDefaultVersionHostContext(SIB, [], {}, sink); // nothing granted
    expect(() => ctx.mcp.registerTool({ name: "x", handler: async () => ({}) } as never)).toThrow();
    expect(() => ctx.capabilities.registerProvider("c", { packageName: SIB, impl: {} })).toThrow();
  });

  it("keeps persistence writers inert WITH a sink (no package-keyed shared-state mutation)", async () => {
    const sink = beginVersionKeyedRegistration(SIB, V);
    const ctx = createNonDefaultVersionHostContext(SIB, ["settings", "secrets", "objects", "nango"], {}, sink);
    await expect(ctx.settings.set("k", "v")).resolves.toBeUndefined();
    await expect(ctx.secrets.set("k", "v")).resolves.toBeUndefined();
    await expect(ctx.objects.write("t", {})).resolves.toEqual({ id: "non-default-version-noop" });
    await expect(ctx.nango.ensureConnectSession({})).resolves.toEqual({});
  });

  it("without a sink, behavior is the pre-Gap-1 inert probe (no retention, no global leak)", () => {
    const ctx = createNonDefaultVersionHostContext(SIB, ["mcp", "capabilities"]); // no sink
    ctx.mcp.registerTool({ name: "sib_tool", handler: async () => ({}) } as never);
    ctx.capabilities.registerProvider("sib-cap", { packageName: SIB, impl: {} });
    expect(listExtensionMcpTools()).toHaveLength(0);
    expect(resolveCapabilityProviders("sib-cap")).toHaveLength(0);
    // Nothing retained under any version (unpinned lookups refuse).
    expect(isVersionKeyedServable(SIB, V)).toBe(false);
  });
});

// End-to-end through the REAL loader driver + the REAL host ctx factory, with the
// makeContext / onRegisterSettled wiring that the DEFERRED production loader
// injection will use (the runtime loader is route-graph-locked; see the module
// header + PR): a default version registers globally; a non-default sibling begins
// a sink threaded by record identity, and is committed (servable) on register
// success or aborted (discarded) on register failure. This proves the mechanism
// the injection slice wires, driver-for-driver.
describe("end-to-end: runStaticBundleActivation drives retain → commit/abort", () => {
  const rec = (packageName: string, over: Partial<LoaderRecord> = {}): LoaderRecord => ({
    packageName,
    serverEntry: "./register",
    requestedHostPorts: ["mcp", "capabilities"],
    ...over,
  });

  // Exact mirror of the host wiring in src/lib/runtime-package-loader.ts.
  const hostDeps = (importServerEntry: (p: string) => Promise<unknown>) => {
    const pendingSinks = new Map<object, VersionKeyedRegistrationSink>();
    return {
      importServerEntry,
      abiCompatible: () => true,
      makeContext: (packageName: string, grantedPorts: readonly string[], record: LoaderRecord) => {
        if (record.isDefault !== false) {
          return createExtensionHostContext(packageName, grantedPorts as never, {});
        }
        let sink: VersionKeyedRegistrationSink | undefined;
        if (record.version) {
          sink = beginVersionKeyedRegistration(packageName, record.version);
          pendingSinks.set(record, sink);
        }
        return createNonDefaultVersionHostContext(packageName, grantedPorts as never, {}, sink);
      },
      onRegisterSettled: (record: LoaderRecord, registered: boolean) => {
        const sink = pendingSinks.get(record);
        if (!sink) return;
        pendingSinks.delete(record);
        if (registered) sink.commit();
        else sink.abort();
      },
    };
  };

  it("a non-default sibling that registers successfully becomes SERVABLE and serves its handler", async () => {
    const results = await runStaticBundleActivation(
      [rec(SIB, { version: V, isDefault: false })],
      hostDeps(() =>
        Promise.resolve({
          packageName: SIB,
          register: (ctx: { mcp: { registerTool: (t: unknown) => void } }) => {
            ctx.mcp.registerTool({ name: "sib_tool", handler: async () => ({ served: true }) });
          },
        }),
      ),
    );
    expect(results.find((r) => r.packageName === SIB)?.status).toBe("registered");
    expect(isVersionKeyedServable(SIB, V)).toBe(true);
    const tool = resolveVersionKeyedMcpTool(SIB, V, "sib_tool");
    expect(tool.kind).toBe("serve");
    // And it never leaked to the global registry.
    expect(listExtensionMcpTools()).toHaveLength(0);
  });

  it("a non-default sibling whose register THROWS is DISCARDED (fail-closed, not servable)", async () => {
    const results = await runStaticBundleActivation(
      [rec(SIB, { version: V, isDefault: false })],
      hostDeps(() =>
        Promise.resolve({
          packageName: SIB,
          register: (ctx: { mcp: { registerTool: (t: unknown) => void } }) => {
            ctx.mcp.registerTool({ name: "sib_tool", handler: async () => ({}) });
            throw new Error("register blew up after a partial registration");
          },
        }),
      ),
    );
    expect(results.find((r) => r.packageName === SIB)?.status).toBe("failed");
    expect(isVersionKeyedServable(SIB, V)).toBe(false);
    expect(resolveVersionKeyedMcpTool(SIB, V, "sib_tool").kind).toBe("refuse");
  });

  it("a DEFAULT version registers globally and creates NO version-keyed entry", async () => {
    await runStaticBundleActivation(
      [rec(SIB, { version: V, isDefault: true })],
      hostDeps(() =>
        Promise.resolve({
          packageName: SIB,
          register: (ctx: { mcp: { registerTool: (t: unknown) => void } }) => {
            ctx.mcp.registerTool({ name: "default_tool", handler: async () => ({}) });
          },
        }),
      ),
    );
    // Global registry owns it; no version-keyed retention for the default.
    expect(listExtensionMcpTools().some((t) => t.packageName === SIB)).toBe(true);
    expect(isVersionKeyedServable(SIB, V)).toBe(false);
  });
});
