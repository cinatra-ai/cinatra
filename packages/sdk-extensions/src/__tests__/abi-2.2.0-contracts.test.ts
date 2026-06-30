import { describe, it, expect } from "vitest";
import { SDK_EXTENSIONS_ABI_VERSION } from "../register";
import type {
  HostNangoPort,
  ExtensionHostContext,
  AbiScopedNangoPort,
  SdkAbiRangeMeets22,
  GrantedHostContext,
  HostPortName,
} from "../index";
import { NANGO_ABI_2_2_ADDED_METHODS, AMBIENT_HOST_PORTS } from "../index";
import { TEST_AMBIENT_PORTS } from "../test-host-context";

// Tiny compile-time assertion helpers (no runtime footprint beyond the const).
type Expect<T extends true> = T;
type Equals<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false;
import type {
  ExtensionMcpToolServer,
  ExtensionPrimitiveRequest,
} from "../mcp-connector-contract";
import type { SemanticArtifactManifest } from "../artifact-contract";
import type { AgentIOSpec } from "../agent-io-contract";

// SDK foundation. Locks the single MINOR bump and asserts the new
// additive surface is OPTIONAL (so a host pinned to an older minor still type-checks).

describe("SDK ABI 2.2.0 foundation", () => {
  it("is at 2.2.0", () => {
    expect(SDK_EXTENSIONS_ABI_VERSION).toBe("2.2.0");
  });

  it("declares the new nango render getters as OPTIONAL (additive minor)", () => {
    // A HostNangoPort with ONLY the pre-2.2.0 required methods must still satisfy
    // the type — proving the five new getters are optional.
    const legacyNango: HostNangoPort = {
      isConfigured: async () => false,
      getConnection: async () => null,
      ensureConnectSession: async () => ({}),
    };
    expect(legacyNango.getStatus).toBeUndefined();
    expect(legacyNango.getFrontendConfig).toBeUndefined();
    expect(legacyNango.getPrimarySavedConnection).toBeUndefined();
    expect(legacyNango.getPrimarySavedConnections).toBeUndefined();
    expect(legacyNango.listConnectionRecords).toBeUndefined();
    // getNangoOAuthCallbackUrl is a LATER post-2.2.0 additive optional getter
    // (NOT one of the five 2.2.0 methods) — also absent from the legacy port.
    expect(legacyNango.getNangoOAuthCallbackUrl).toBeUndefined();
  });

  it("keeps getNangoOAuthCallbackUrl optional even at a >= 2.2 floor (post-2.2.0, NOT minimum-minor gated)", () => {
    // It was added after the 2.2.0 baseline, so it is deliberately excluded from
    // NANGO_ABI_2_2_ADDED_METHODS: a >= 2.2 scoped port must NOT require it, and a
    // connector reads it null-safe regardless of its declared minor.
    expect(NANGO_ABI_2_2_ADDED_METHODS).not.toContain("getNangoOAuthCallbackUrl");
    const at22WithoutCallback: AbiScopedNangoPort<">=2.2"> = {
      isConfigured: async () => false,
      getConnection: async () => null,
      ensureConnectSession: async () => ({}),
      getStatus: async () => ({ status: "not_connected" }),
      getFrontendConfig: async () => ({}),
      getPrimarySavedConnection: async () => null,
      getPrimarySavedConnections: async () => ({}),
      listConnectionRecords: async () => [],
    };
    expect(at22WithoutCallback.getNangoOAuthCallbackUrl).toBeUndefined();
  });

  it("exposes the structural mcp + artifact contracts (compile-time)", () => {
    const server: ExtensionMcpToolServer = {
      registerTool: () => undefined,
    };
    const req: ExtensionPrimitiveRequest<{ x: number }> = {
      primitiveName: "thing_action",
      input: { x: 1 },
      actor: null,
      mode: "agentic",
    };
    const manifest: SemanticArtifactManifest = { accepts: { dashboard: true } };
    const io: AgentIOSpec = { input: [], output: [] };
    expect(typeof server.registerTool).toBe("function");
    expect(req.primitiveName).toBe("thing_action");
    expect(manifest.accepts.dashboard).toBe(true);
    expect(io.input).toHaveLength(0);
  });

  it("keeps the ABI version on the ExtensionHostContext type", () => {
    const ctxAbi: ExtensionHostContext["abiVersion"] = "2.2.0";
    expect(ctxAbi).toBe("2.2.0");
  });
});

// ---------------------------------------------------------------------------
// ABI-evolution policy: MINIMUM-MINOR semantics keyed off
// sdkAbiRange. At a declared >= 2.2 floor the five 2.2-added nango getters are
// REQUIRED (AbiScopedNangoPort); below 2.2 they stay OPTIONAL (the base port).
// ---------------------------------------------------------------------------
describe("ABI minimum-minor: AbiScopedNangoPort keyed off sdkAbiRange", () => {
  it("BELOW a 2.2 floor the 2.2 getters stay OPTIONAL (legacy contract preserved)", () => {
    // A port with ONLY the pre-2.2 required methods still satisfies the scoped
    // type for sub-2.2 ranges — proving the getters remain optional there.
    const caret2: AbiScopedNangoPort<"^2"> = {
      isConfigured: async () => false,
      getConnection: async () => null,
      ensureConnectSession: async () => ({}),
    };
    const tilde21: AbiScopedNangoPort<"~2.1"> = caret2;
    const exact203: AbiScopedNangoPort<"2.0.3"> = caret2;
    const unpinned: AbiScopedNangoPort<undefined> = caret2;
    const wildcard: AbiScopedNangoPort<"*"> = caret2;
    const major1: AbiScopedNangoPort<"^1"> = caret2;
    expect(caret2.getStatus).toBeUndefined();
    expect(tilde21.getFrontendConfig).toBeUndefined();
    expect(exact203.listConnectionRecords).toBeUndefined();
    expect(unpinned.getPrimarySavedConnection).toBeUndefined();
    expect(wildcard.getPrimarySavedConnections).toBeUndefined();
    expect(major1.getStatus).toBeUndefined();
    // Below 2.2 the scoped port is STRUCTURALLY the base optional-getter port.
    type _BelowIsBase = Expect<Equals<AbiScopedNangoPort<"^2">, HostNangoPort>>;
  });

  it("AT a >= 2.2 floor the five 2.2 getters are REQUIRED (minimum-minor)", () => {
    // A >= 2.2 scoped port MUST supply all five getters — an object missing any
    // would be a compile error, so providing them all is the only valid value.
    const full: AbiScopedNangoPort<">=2.2"> = {
      isConfigured: async () => false,
      getConnection: async () => null,
      ensureConnectSession: async () => ({}),
      getStatus: async () => ({ status: "not_connected" }),
      getFrontendConfig: async () => ({}),
      getPrimarySavedConnection: async () => null,
      getPrimarySavedConnections: async () => ({}),
      listConnectionRecords: async () => [],
    };
    // Every >= 2.2 floor form (caret/tilde/exact/2.2/2.2.x/2.10) admits the same value.
    const caret22: AbiScopedNangoPort<"^2.2"> = full;
    const caret225: AbiScopedNangoPort<"^2.2.5"> = full;
    const tilde22: AbiScopedNangoPort<"~2.2"> = full;
    const exact220: AbiScopedNangoPort<"2.2.0"> = full;
    const bare22: AbiScopedNangoPort<"2.2"> = full;
    const x22: AbiScopedNangoPort<"2.2.x"> = full;
    const minor210: AbiScopedNangoPort<"2.10"> = full; // 2.10 minor >= 2
    expect(typeof caret22.getStatus).toBe("function");
    expect(typeof caret225.getFrontendConfig).toBe("function");
    expect(typeof tilde22.getPrimarySavedConnection).toBe("function");
    expect(typeof exact220.getPrimarySavedConnections).toBe("function");
    expect(typeof bare22.listConnectionRecords).toBe("function");
    expect(typeof x22.getStatus).toBe("function");
    expect(typeof minor210.getStatus).toBe("function");
    // The five 2.2-added members are now non-optional on the >= 2.2 scoped port.
    type ReqKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T];
    type _StatusRequired = Expect<Equals<Extract<ReqKeys<AbiScopedNangoPort<">=2.2">>, "getStatus">, "getStatus">>;
  });

  it("the predicate SdkAbiRangeMeets22 matches the runtime lower-bound boundary", () => {
    type T = true; type F = false;
    type _a = Expect<Equals<SdkAbiRangeMeets22<">=2.2">, T>>;
    type _b = Expect<Equals<SdkAbiRangeMeets22<"^2.2">, T>>;
    type _c = Expect<Equals<SdkAbiRangeMeets22<"~2.2">, T>>;
    type _d = Expect<Equals<SdkAbiRangeMeets22<"2.2.0">, T>>;
    type _e = Expect<Equals<SdkAbiRangeMeets22<"2.2">, T>>;
    type _f = Expect<Equals<SdkAbiRangeMeets22<"2.10">, T>>;
    type _g = Expect<Equals<SdkAbiRangeMeets22<"^2">, F>>;
    type _h = Expect<Equals<SdkAbiRangeMeets22<"2.1">, F>>;
    type _i = Expect<Equals<SdkAbiRangeMeets22<"~2.1">, F>>;
    type _j = Expect<Equals<SdkAbiRangeMeets22<"2">, F>>;
    type _k = Expect<Equals<SdkAbiRangeMeets22<"^1">, F>>;
    type _l = Expect<Equals<SdkAbiRangeMeets22<"^3.2">, F>>;
    type _m = Expect<Equals<SdkAbiRangeMeets22<"">, F>>;
    type _n = Expect<Equals<SdkAbiRangeMeets22<"*">, F>>;
    type _o = Expect<Equals<SdkAbiRangeMeets22<undefined>, F>>;
    type _p = Expect<Equals<SdkAbiRangeMeets22<null>, F>>;
    // codex-flagged edge cases (must mirror runtime rangeBounds, fail closed):
    type _q = Expect<Equals<SdkAbiRangeMeets22<"2.01">, F>>;        // leading-zero minor (Number=1)
    type _r = Expect<Equals<SdkAbiRangeMeets22<"2.00">, F>>;        // leading-zero minor (Number=0)
    type _s = Expect<Equals<SdkAbiRangeMeets22<"2.2.0-beta">, F>>;  // malformed patch tail (runtime rejects)
    type _t = Expect<Equals<SdkAbiRangeMeets22<"2.2.foo">, F>>;     // non-numeric patch
    type _u = Expect<Equals<SdkAbiRangeMeets22<"2.2.">, F>>;        // trailing dot (empty patch)
    type _v = Expect<Equals<SdkAbiRangeMeets22<" >=2.2 ">, T>>;     // leading + trailing whitespace
    type _w = Expect<Equals<SdkAbiRangeMeets22<"2.2.0">, T>>;       // canonical exact patch
    type _x = Expect<Equals<SdkAbiRangeMeets22<"2.2.10">, T>>;      // canonical multi-digit patch
    type _y = Expect<Equals<SdkAbiRangeMeets22<"2.2.01">, F>>;      // leading-zero patch (non-canonical)
    type _z = Expect<Equals<SdkAbiRangeMeets22<"2.">, F>>;          // trailing dot, empty minor (runtime rejects)
    type _z2 = Expect<Equals<SdkAbiRangeMeets22<"2..0">, F>>;       // empty minor component
    type _z3 = Expect<Equals<SdkAbiRangeMeets22<">=2.">, F>>;       // empty minor after op
    type _z4 = Expect<Equals<SdkAbiRangeMeets22<"2.02">, F>>;       // leading-zero minor (non-canonical, fail closed)
    type _z5 = Expect<Equals<SdkAbiRangeMeets22<never>, F>>;        // never Range must not reach required branch
    // The five method names the policy keys off are stable + exhaustive.
    expect([...NANGO_ABI_2_2_ADDED_METHODS]).toEqual([
      "getStatus",
      "getFrontendConfig",
      "getPrimarySavedConnection",
      "getPrimarySavedConnections",
      "listConnectionRecords",
    ]);
  });
});

// ---------------------------------------------------------------------------
// ABI-evolution policy: least-privilege grant-typed ctx variant.
// GrantedHostContext exposes ONLY granted ports (+ ambient + identity); the
// runtime fail-loud stays as defense-in-depth. Additive: ExtensionHostContext
// (all ports required) is unchanged + still consumable.
// ---------------------------------------------------------------------------
describe("ABI least-privilege: GrantedHostContext compile-time grant typing", () => {
  it("exposes ONLY the granted ports + ambient ports + identity", () => {
    type Ctx = GrantedHostContext<"settings" | "nango">;
    type Keys = keyof Ctx;
    // Granted + ambient + identity are present.
    type _hasSettings = Expect<Equals<Extract<Keys, "settings">, "settings">>;
    type _hasNango = Expect<Equals<Extract<Keys, "nango">, "nango">>;
    type _hasLogger = Expect<Equals<Extract<Keys, "logger">, "logger">>; // ambient
    type _hasRuntime = Expect<Equals<Extract<Keys, "runtime">, "runtime">>; // ambient
    type _hasPkg = Expect<Equals<Extract<Keys, "packageName">, "packageName">>;
    type _hasAbi = Expect<Equals<Extract<Keys, "abiVersion">, "abiVersion">>;
    // UNGRANTED privileged ports are ABSENT from the type (compile-time least-privilege).
    type _noSecrets = Expect<Equals<Extract<Keys, "secrets">, never>>;
    type _noDb = Expect<Equals<Extract<Keys, "db">, never>>;
    type _noMcp = Expect<Equals<Extract<Keys, "mcp">, never>>;
    expect([...AMBIENT_HOST_PORTS]).toEqual(["logger", "runtime"]);
    // Parity with the test harness ambient list (and, by the test-host-context
    // tests, the host factory). Single canonical literal across all three.
    expect([...AMBIENT_HOST_PORTS]).toEqual([...TEST_AMBIENT_PORTS]);
  });

  it("is ADDITIVE — a full GrantedHostContext is assignable to ExtensionHostContext (sans nango-getter strictness)", () => {
    // A grant-typed ctx over the FULL port set with no >= 2.2 floor is structurally
    // the familiar surface: every full ExtensionHostContext satisfies it.
    type FullScoped = GrantedHostContext<HostPortName>;
    // ExtensionHostContext (the host factory result) is assignable to the full
    // grant-typed ctx — proving the new type does not break existing producers.
    type _producerCompat = Expect<
      Equals<ExtensionHostContext extends FullScoped ? true : false, true>
    >;
    expect(true).toBe(true);
  });

  it("a >= 2.2 grant-typed ctx gets the minimum-minor nango (getters required)", () => {
    // Within a >= 2.2 ctx, ctx.nango is the AbiScopedNangoPort with required getters.
    type Ctx = GrantedHostContext<"nango", ">=2.2">;
    type Nango = Ctx["nango"];
    type _scoped = Expect<Equals<Equals<Nango, AbiScopedNangoPort<">=2.2">>, true>>;
    // Sub-2.2 ctx keeps the base optional-getter nango.
    type CtxLow = GrantedHostContext<"nango", "^2">;
    type _base = Expect<Equals<Equals<CtxLow["nango"], HostNangoPort>, true>>;
    expect(true).toBe(true);
  });
});
