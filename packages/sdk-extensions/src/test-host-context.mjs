// ---------------------------------------------------------------------------
// createTestHostContext — the AUTHOR-FACING local test harness host context.
//
// PURPOSE (cinatra-engineering#163, SDK-P1). An extension author writing a unit
// test for their `register(ctx)` hook needs a faithful `ExtensionHostContext`
// they can construct WITHOUT the server-only host (`@/lib/extension-host-
// context.ts` imports `server-only`, the DB, Nango, etc.). This module is the
// SINGLE canonical, dependency-free (Node builtins only — actually zero imports)
// definition of that harness context. It mirrors the host's grant-aware probe
// semantics so a `register` that passes here behaves the same way in production:
//
//   • GRANT SIMULATION — an ungranted privileged port is the FAIL-LOUD proxy
//     (any real method access throws a named, actionable error), exactly as the
//     host's `unavailablePort` does. The author sees least-privilege failures
//     locally instead of in production. Ambient ports (`logger`/`runtime`) are
//     always granted; `db` is fail-loud even when granted (it is RESERVED / not
//     implemented in the host — see host-context.ts HostDbPort — unless the
//     caller passes `db: <stub>` to override for a non-production test).
//
//   • IDENTITY ASSERTIONS — `capabilities.registerProvider` FORCES the host-
//     injected `packageName` onto the provider identity and REJECTS the reserved
//     `@cinatra-ai/host` namespace, identical to the host (cinatra#150
//     impersonation defense). A register that tries to claim another package's
//     identity is corrected (recorded under the real identity), and one claiming
//     the host namespace throws — locally, as in production.
//
//   • HOST-SERVICE STUBS — `capabilities.resolveProviders(id)` returns the
//     SEEDED providers passed as `capabilities[id]` PLUS any provider this same
//     ctx registered earlier (self-register-then-resolve parity). A register that
//     resolves a host facade (e.g. an email-send capability) at activation sees
//     the configured stubs instead of an empty registry.
//
//   • FIXTURES — `settings`/`secrets` are seeded from `settings`/`secrets` opts
//     and are live in-memory stores (get/set/delete round-trip). `authSession`
//     resolves the seeded `actor`.
//
//   • RECORDER + DIAGNOSTICS — the returned `recorder` captures what `register`
//     registered (mcp tools, capability providers, object types, ui surfaces/
//     actions, enqueued jobs, emitted notifications/telemetry). `diagnostics` is
//     a list of structured, ACTIONABLE notes (e.g. a capability resolved with no
//     configured provider). The CLI validator RENDERS these REDACTED (names/
//     counts/ids only — never `provider.impl`, handler functions, settings, or
//     secret values).
//
// This file is `.mjs` (plain JS, JSDoc-typed) so it is consumable BOTH by the
// TypeScript SDK (via a `.d.ts` + `.ts` re-export) AND by the zero-dependency
// release-tooling validator / canary verifier (which run unauthenticated in CI,
// before the @cinatra-ai registry is reachable, and so cannot `import` a built
// package). The release-tooling repo carries a BYTE-IDENTICAL vendored copy,
// guarded by a parity test (the build-server-entry.mjs precedent).
// ---------------------------------------------------------------------------

// FROZEN (codex HIGH): these exported arrays are the grant-authority surface.
// They are Object.freeze'd so untrusted top-level extension code that imports
// this module (e.g. via the register-probe child) cannot push a port and widen
// its own grants. The grant computation below ALSO reads from a private frozen
// snapshot, never from the mutable export, as defence in depth.
const _PORTS = Object.freeze([
  "db",
  "settings",
  "secrets",
  "nango",
  "authSession",
  "mcp",
  "objects",
  "jobs",
  "notifications",
  "ui",
  "logger",
  "runtime",
  "capabilities",
  "telemetry",
]);
const _AMBIENT = Object.freeze(["logger", "runtime"]);

/** The 14 canonical host ports (mirrors host-context.HOST_PORT_NAMES, ABI FROZEN). */
export const TEST_HOST_PORT_NAMES = _PORTS;

/** Always-available ambient ports (mirrors host-context AMBIENT_PORTS). */
export const TEST_AMBIENT_PORTS = _AMBIENT;

/** The reserved provider-identity namespace for HOST-published services. */
export const HOST_RESERVED_PROVIDER_NAMESPACE = "@cinatra-ai/host";

// Serialization / inspection hooks the framework probes on EVERY value (RSC
// Flight, JSON.stringify, console/inspect). A fail-loud port must answer these
// inertly (undefined) instead of throwing, or merely PASSING ctx through a
// serializer crashes — mirrors host-context SERIALIZATION_PROBE_PROPS.
const SERIALIZATION_PROBE_PROPS = new Set(["toJSON", "then", "catch", "finally", "$$typeof"]);

// Author-controlled atoms (tool names, typeIds, capability ids, provider
// packageNames) are UNTRUSTED strings printed in diagnostics. Strip control
// chars / ANSI escapes / newlines and bound the length so a crafted id cannot
// inject misleading lines, terminal escapes, or smuggle a long secret into the
// "names/counts/ids only" summary (codex MED).
const _CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F]", "g");
export function sanitizeAtom(value, max = 120) {
  const s = typeof value === "string" ? value : String(value ?? "");
  const stripped = s.replace(_CONTROL_CHARS, "·");
  return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
}

/** A chainable, callable, non-thenable inert sink (forward-compat for the
 * INERT release smoke — an unknown/future port or method never throws). */
function makeChainableSink() {
  const sink = new Proxy(function () {}, {
    get: (_t, p) => (p === "then" ? undefined : sink),
    apply: () => sink,
  });
  return sink;
}

/** True iff `packageName` is (or is under) the reserved host namespace. */
export function isReservedHostProviderIdentity(packageName) {
  return (
    packageName === HOST_RESERVED_PROVIDER_NAMESPACE ||
    (typeof packageName === "string" && packageName.startsWith(`${HOST_RESERVED_PROVIDER_NAMESPACE}:`))
  );
}

/**
 * Bind a capability registration to the HOST-INJECTED `packageName` — the only
 * authoritative provider identity (cinatra#150). Caller-supplied
 * `provider.packageName` is UNTRUSTED and OVERRIDDEN, never trusted. Registering
 * under the reserved host namespace from the extension port is REJECTED. Mirrors
 * host-context.bindProviderIdentity EXACTLY.
 */
export function bindTestProviderIdentity(packageName, provider) {
  if (isReservedHostProviderIdentity(packageName)) {
    throw new Error(
      `[testHostContext] "${packageName}" may not register a capability provider via the extension port: ` +
        `the "${HOST_RESERVED_PROVIDER_NAMESPACE}" namespace is reserved for host-published services`,
    );
  }
  if (provider == null || typeof provider !== "object") {
    throw new Error(
      `[testHostContext] ${packageName}: ctx.capabilities.registerProvider received a non-object provider`,
    );
  }
  return { ...provider, packageName };
}

/**
 * The fail-loud proxy for a port the extension did not grant. Any REAL method
 * access throws a named, actionable error; serialization/inspection probes
 * answer inertly so passing ctx through a serializer never crashes. Mirrors
 * host-context.unavailablePort.
 *
 * @param {string} packageName
 * @param {string} port
 * @param {"not-granted"|"not-implemented"} reason
 */
function unavailableTestPort(packageName, port, reason) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === "symbol" || SERIALIZATION_PROBE_PROPS.has(prop)) {
          return undefined;
        }
        if (reason === "not-granted") {
          throw new Error(
            `[testHostContext] ${packageName}: host port "${port}".${String(prop)} accessed but NOT GRANTED — ` +
              `add "${port}" to the extension manifest's cinatra.requestedHostPorts (least-privilege).`,
          );
        }
        throw new Error(
          `[testHostContext] ${packageName}: host port "${port}".${String(prop)} is RESERVED / not implemented ` +
            `by the host — it cannot be used yet (see the SDK HostDbPort docs).`,
        );
      },
    },
  );
}

/**
 * Build a faithful author-facing test ExtensionHostContext.
 *
 * @param {{
 *   packageName: string,
 *   grants?: readonly string[],
 *   capabilities?: Record<string, Array<{ packageName?: string, impl: unknown }>>,
 *   settings?: Record<string, unknown>,
 *   secrets?: Record<string, string>,
 *   actor?: { userId?: string|null, organizationId?: string|null, orgRole?: string|null } | null,
 *   runtimeMode?: "development"|"production",
 *   flags?: Record<string, boolean>,
 *   publicBaseUrl?: string|null,
 *   db?: unknown,
 *   inert?: boolean,
 * }} [opts]
 * @returns {{ ctx: object, recorder: object, diagnostics: string[] }}
 */
export function createTestHostContext(opts = {}) {
  const {
    packageName,
    grants = [],
    capabilities = {},
    settings = {},
    secrets = {},
    actor = { userId: "test-user", organizationId: "test-org", orgRole: "admin" },
    runtimeMode = "development",
    flags = {},
    publicBaseUrl = null,
    db, // explicit non-production override only
    // INERT mode (the release-time activation smoke — canary-verify): grant EVERY
    // port inertly (nothing fail-louds), `db` becomes a benign inert read handle,
    // and `runtime.mode` defaults to "production". This is NOT the grant-aware
    // author harness — a packument read cannot prove an extension's grants, so
    // the smoke only proves `register(ctx)` runs CLEAN against an inert host. The
    // ONE faithful guard kept is objects.registerType's descriptor shape check.
    inert = false,
  } = opts;

  if (typeof packageName !== "string" || packageName.length === 0) {
    throw new Error(
      `[testHostContext] createTestHostContext requires a non-empty { packageName } — ` +
        `it is the authoritative provider identity (cinatra#150). The CLI derives it from package.json#name.`,
    );
  }
  if (!Array.isArray(grants) || grants.some((g) => !_PORTS.includes(g))) {
    const bad = (Array.isArray(grants) ? grants : []).filter((g) => !_PORTS.includes(g));
    throw new Error(
      `[testHostContext] ${packageName}: { grants } must be a subset of the ${_PORTS.length} host ports` +
        (bad.length ? ` (unknown: ${bad.map((b) => JSON.stringify(b)).join(", ")})` : ""),
    );
  }
  if (capabilities == null || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new Error(`[testHostContext] ${packageName}: { capabilities } must be an object of capabilityId -> provider[]`);
  }

  // INERT mode grants every port (the release smoke is not grant-aware);
  // otherwise grant the declared ports + the always-on ambient ports. Read from
  // the private frozen snapshots, never the mutable exports (codex HIGH).
  const granted = inert
    ? new Set(_PORTS)
    : new Set([...grants, ..._AMBIENT]);
  const diagnostics = [];

  const recorder = {
    mcpTools: [],
    capabilityProviders: [],
    objectTypes: [],
    uiSetupSurfaces: [],
    uiSettingsSurfaces: [],
    uiActions: [],
    jobsEnqueued: [],
    notificationsEmitted: [],
    telemetryEmitted: [],
  };

  // Live in-memory fixture stores. Seeds are namespaced by the raw key the
  // author would pass (the host namespaces by org/package; here a flat map is
  // faithful enough for a single-extension local test).
  const settingsStore = new Map(Object.entries(settings));
  const secretsStore = new Map(Object.entries(secrets));

  // Seeded host-service providers, indexed by capabilityId. Validate seed shape
  // up front so a malformed seed is an actionable error, not a runtime surprise.
  const seededProviders = new Map();
  for (const [capId, providers] of Object.entries(capabilities)) {
    if (!Array.isArray(providers)) {
      throw new Error(
        `[testHostContext] ${packageName}: capabilities[${JSON.stringify(capId)}] must be an array of { packageName?, impl }`,
      );
    }
    seededProviders.set(
      capId,
      providers.map((p, i) => {
        if (p == null || typeof p !== "object" || !("impl" in p)) {
          throw new Error(
            `[testHostContext] ${packageName}: capabilities[${JSON.stringify(capId)}][${i}] must be { packageName?, impl }`,
          );
        }
        return { packageName: typeof p.packageName === "string" ? p.packageName : `host-stub:${capId}`, impl: p.impl };
      }),
    );
  }
  // Providers registered THROUGH this ctx, so self-register-then-resolve works.
  const liveProviders = new Map();
  const resolveProviders = (capability) => {
    const seeded = seededProviders.get(capability) ?? [];
    const live = liveProviders.get(capability) ?? [];
    const all = [...seeded, ...live];
    if (all.length === 0) {
      const safe = sanitizeAtom(capability);
      diagnostics.push(
        `capability "${safe}" resolved with NO provider configured — pass it via ` +
          `createTestHostContext({ capabilities: { "${safe}": [{ impl }] } }) to simulate a host service.`,
      );
    }
    return all;
  };

  const noop = () => {};

  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };

  const runtime = {
    // Inert release smoke runs as "production" (matches the packument the host
    // serves); the author harness defaults to "development".
    mode: inert ? "production" : runtimeMode,
    flag: (name) => {
      if (/SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL|PRIVATE/i.test(name)) return false;
      return flags[name] === true;
    },
    publicBaseUrl: () => publicBaseUrl,
  };

  // Granted port builders — each records or stubs faithfully.
  const asyncNoop = async () => {};
  const builders = {
    // INERT (canary parity): the old probe's set/delete were async noops and get
    // returned null. Author mode round-trips the seeded in-memory store.
    settings: () => ({
      get: async (key) => (settingsStore.has(key) ? settingsStore.get(key) : null),
      set: inert ? asyncNoop : async (key, value) => { settingsStore.set(key, value); },
      delete: inert ? asyncNoop : async (key) => { settingsStore.delete(key); },
    }),
    secrets: () => ({
      get: async (key) => (secretsStore.has(key) ? secretsStore.get(key) : null),
      set: inert ? asyncNoop : async (key, value) => { secretsStore.set(key, value); },
      delete: inert ? asyncNoop : async (key) => { secretsStore.delete(key); },
    }),
    nango: () =>
      // INERT (canary release-smoke parity): nango is a chainable inert sink so a
      // connector reaching ANY nango method (incl. ones not enumerated here)
      // degrades gracefully — the old canary probe used a sink here.
      inert
        ? makeChainableSink()
        : {
            isConfigured: async () => false,
            getConnection: async () => null,
            ensureConnectSession: async () => ({ sessionToken: "test-nango-session" }),
            getStatus: async () => ({ status: "not_connected" }),
            getFrontendConfig: async () => ({}),
            getPrimarySavedConnection: async () => null,
            getPrimarySavedConnections: async () => ({}),
            listConnectionRecords: async () => [],
          },
    authSession: () =>
      // INERT (canary parity): the old probe returned `getActor: null` +
      // `requireOrganizationId: "probe-org"` unconditionally (a packument read has
      // no real actor). Author mode resolves the seeded actor and requires an org.
      inert
        ? { getActor: async () => null, requireOrganizationId: async () => "probe-org" }
        : {
            getActor: async () => actor,
            requireOrganizationId: async () => {
              const orgId = actor && actor.organizationId;
              if (!orgId) {
                throw new Error(
                  `[testHostContext] ${packageName}: ctx.authSession.requireOrganizationId() — ` +
                    `no organizationId on the test actor (pass { actor: { organizationId } }).`,
                );
              }
              return orgId;
            },
          },
    mcp: () => ({
      registerTool: (tool) => {
        recorder.mcpTools.push(tool);
      },
      // INERT (canary parity): the old probe's callPrimitive was an async noop
      // (returns undefined, never throws). Author mode fail-louds (no live MCP).
      callPrimitive: inert
        ? async () => undefined
        : async (primitiveName) => {
            throw new Error(
              `[testHostContext] ${packageName}: ctx.mcp.callPrimitive(${JSON.stringify(primitiveName)}) is not ` +
                `available in the local test harness (no live host MCP server).`,
            );
          },
      listExternalServers: async () => [],
      getPublicBaseUrl: async () => ({ publicBaseUrl: inert ? null : publicBaseUrl }),
    }),
    objects: () => ({
      registerType: (descriptor) => {
        // The ONE faithful guard kept in BOTH modes: a structurally-broken
        // (non-object) descriptor is what the real host registry throws on, so it
        // must surface as register-threw. The stricter non-empty-typeId check is
        // AUTHOR-mode only — the SDK HostObjectsPort contract names `typeId`, so
        // it is a real authoring aid; but the INERT release smoke must NOT newly
        // reject a connector the old canary passed (which only checked non-object).
        if (descriptor == null || typeof descriptor !== "object") {
          throw new Error(`[testHostContext] ${packageName}: ctx.objects.registerType received a non-object descriptor`);
        }
        if (!inert && (typeof descriptor.typeId !== "string" || descriptor.typeId.length === 0)) {
          throw new Error(
            `[testHostContext] ${packageName}: ctx.objects.registerType requires a non-empty string typeId`,
          );
        }
        recorder.objectTypes.push(descriptor);
      },
      read: async () => null,
      write: async () => ({ id: inert ? "probe-noop" : `test-object-${recorder.objectTypes.length}` }),
      history: async () => [],
    }),
    jobs: () => ({
      enqueue: async (jobName, payload, jobOpts) => {
        recorder.jobsEnqueued.push({ jobName, payload, opts: jobOpts });
        return { id: inert ? "probe-noop" : `test-job-${recorder.jobsEnqueued.length}` };
      },
      // INERT (canary parity): the old probe's registerWorker was a noop. Author
      // mode fail-louds (the host runs a STATIC dispatcher; registerWorker is
      // unsupported — surface that to the author).
      registerWorker: inert
        ? () => {}
        : () => {
            throw new Error(
              `[testHostContext] ${packageName}: ctx.jobs.registerWorker is not supported — the host runs a static ` +
                `background-job dispatcher. Use ctx.jobs.enqueue against a host-recognised job name.`,
            );
          },
    }),
    notifications: () => ({
      emit: async (input) => {
        recorder.notificationsEmitted.push(input);
      },
    }),
    ui: () => ({
      registerSetupSurface: (surface) => {
        recorder.uiSetupSurfaces.push(surface);
      },
      registerSettingsSurface: (surface) => {
        recorder.uiSettingsSurfaces.push(surface);
      },
      registerAction: (action) => {
        recorder.uiActions.push(action);
      },
    }),
    capabilities: () =>
      // INERT (canary parity): the old probe's registerProvider was a pure noop
      // and resolveProviders returned []. The release smoke must NOT newly reject
      // a connector that registers a provider (identity binding + the reserved-
      // namespace/non-object rejection are AUTHOR-mode enforcement only — the
      // host applies them at LIVE activation, which a packument read is not).
      inert
        ? { registerProvider: () => {}, resolveProviders: () => [] }
        : {
            registerProvider: (capability, provider) => {
              // Identity enforcement parity with the host (cinatra#150): force
              // identity, reject the reserved host namespace + non-object provider.
              const bound = bindTestProviderIdentity(packageName, provider);
              recorder.capabilityProviders.push({ capability, provider: bound });
              const arr = liveProviders.get(capability) ?? [];
              arr.push(bound);
              liveProviders.set(capability, arr);
            },
            resolveProviders,
          },
    telemetry: () => ({
      emitUsage: (event) => {
        recorder.telemetryEmitted.push(event);
      },
    }),
  };

  const gated = (port) =>
    granted.has(port) ? builders[port]() : unavailableTestPort(packageName, port, "not-granted");

  const ctx = {
    abiVersion: "2.2.0",
    packageName,
    logger,
    runtime,
    // `db` is RESERVED / not implemented in the host even when granted. Fail loud
    // here too (production parity) UNLESS the caller passes an explicit override
    // for a non-production test (codex HIGH), or in INERT mode where the release
    // smoke uses a benign inert read handle (it does not exercise grants).
    db:
      db !== undefined
        ? db
        : inert
          ? { query: async () => [], schema: "inert" }
          : granted.has("db")
            ? unavailableTestPort(packageName, "db", "not-implemented")
            : unavailableTestPort(packageName, "db", "not-granted"),
    settings: gated("settings"),
    secrets: gated("secrets"),
    nango: gated("nango"),
    authSession: gated("authSession"),
    mcp: gated("mcp"),
    objects: gated("objects"),
    jobs: gated("jobs"),
    notifications: gated("notifications"),
    ui: gated("ui"),
    capabilities: gated("capabilities"),
    telemetry: gated("telemetry"),
  };

  if (inert) {
    // Forward-compat (canary parity): an extension pinned to a NEWER ABI minor
    // may reach a port not enumerated here. In the release smoke that must
    // degrade gracefully (a chainable, callable, non-thenable inert sink) rather
    // than throw — the smoke proves register RUNS, not grant correctness.
    const sink = makeChainableSink();
    return {
      ctx: new Proxy(ctx, { get: (t, p) => (p in t ? t[p] : sink) }),
      recorder,
      diagnostics,
    };
  }

  return { ctx, recorder, diagnostics };
}

/**
 * Build a REDACTED, human-readable summary of what a `register` registered —
 * NAMES / COUNTS / IDS only. NEVER include `provider.impl`, handler functions,
 * settings values, or secret values (codex HIGH — recorder contents are
 * sensitive). Used by the CLI validator's `--register-probe` diagnostics.
 *
 * @param {object} recorder
 * @returns {string[]}
 */
export function summarizeRecorder(recorder) {
  const lines = [];
  // Every printed id is an UNTRUSTED author-controlled string — sanitize it
  // (strip control/ANSI chars, bound length) so a crafted name cannot inject
  // misleading lines, terminal escapes, or smuggle a secret (codex MED).
  const idsOf = (arr, pick) =>
    arr.map(pick).filter((x) => typeof x === "string" && x.length > 0).map((x) => sanitizeAtom(x));
  if (recorder.mcpTools.length) {
    lines.push(`mcp tools: ${recorder.mcpTools.length} [${idsOf(recorder.mcpTools, (t) => t && t.name).join(", ")}]`);
  }
  if (recorder.capabilityProviders.length) {
    lines.push(
      `capability providers: ${recorder.capabilityProviders.length} [` +
        recorder.capabilityProviders
          .map((c) => `${sanitizeAtom(c.capability)} <- ${sanitizeAtom(c.provider && c.provider.packageName)}`)
          .join(", ") +
        `]`,
    );
  }
  if (recorder.objectTypes.length) {
    lines.push(`object types: ${recorder.objectTypes.length} [${idsOf(recorder.objectTypes, (o) => o && o.typeId).join(", ")}]`);
  }
  if (recorder.uiSetupSurfaces.length) lines.push(`ui setup surfaces: ${recorder.uiSetupSurfaces.length}`);
  if (recorder.uiSettingsSurfaces.length) lines.push(`ui settings surfaces: ${recorder.uiSettingsSurfaces.length}`);
  if (recorder.uiActions.length) {
    lines.push(`ui actions: ${recorder.uiActions.length} [${idsOf(recorder.uiActions, (a) => a && a.id).join(", ")}]`);
  }
  if (recorder.jobsEnqueued.length) {
    lines.push(`jobs enqueued: ${recorder.jobsEnqueued.length} [${idsOf(recorder.jobsEnqueued, (j) => j && j.jobName).join(", ")}]`);
  }
  if (recorder.notificationsEmitted.length) lines.push(`notifications emitted: ${recorder.notificationsEmitted.length}`);
  if (recorder.telemetryEmitted.length) lines.push(`telemetry events: ${recorder.telemetryEmitted.length}`);
  return lines;
}
