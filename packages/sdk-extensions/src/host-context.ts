// ExtensionHostContext — the privileged port surface the host passes to an
// extension's `register(ctx)` hook.
//
// STATUS: ABI FROZEN. The port set below is derived EMPIRICALLY from the
// extension inventory of what extensions actually import from `@/`
// (45 distinct host modules across 21 connectors). FROZEN: no port may be added
// or changed without an SDK ABI MAJOR bump.
//
// The `telemetry` port (`HostTelemetryPort`, the inverted
// `@cinatra-ai/metric-usage-api` surface) carries the usage/cost events
// `apollo-connector` (and future metered connectors) emit. Adding a port is a
// breaking ABI change; server-entry extensions pinning `sdkAbiRange: "^1"` must
// be moved to `"^2"` or the loader would (correctly) skip them as
// ABI-incompatible.
//
// TYPE-MODEL DECISION (deliberate): `ExtensionHostContext` exposes ALL ports as
// required properties — an author sees the full surface and least-privilege is
// enforced at RUNTIME (the host's grant-aware factory fail-louds on an ungranted
// or unwired port; see src/lib/extension-host-context.ts). Compile-time grant
// typing (a ctx parameterized by the manifest's `requestedHostPorts`) is a
// possible future refinement; this keeps the surface simple + uniform with
// runtime enforcement.
//
// Decoupling principle: an extension reaches every privileged host capability
// THROUGH these ports — never via a `@/lib/*`, `@/components/*`,
// `@/app/*` import. Method signatures here are intentionally narrow and
// least-privilege; `db` in particular is the exceptional, scoped escape hatch,
// not the default data path (config → `settings`, credentials → `secrets`).
//
// This module is type-only and host-agnostic on purpose: the SDK contract
// package must not import host internals OR host-core sibling packages — an
// standalone companion extension repo peer-depends on `react`/`next`/
// `@cinatra-ai/sdk-*` only (see package.json), so host-specific shapes are kept
// opaque here and refined when the ABI freezes.

// Type-only: the capability-id -> contract-surface map (compile-time ergonomics
// for the capabilities port; see `HostCapabilitiesPort.resolveProviders`). This
// is a `import type` of pure types — host-agnostic, no value import, so the
// "type-only, no host internals" invariant above holds.
import type {
  KnownCapabilityId,
  ResolvedCapabilityProvider,
} from "./capability-contract-map";

/**
 * Opaque scoped DB handle. Least-privilege; most extensions never need it.
 *
 * RESERVED — NOT wired yet. The host factory fail-louds on any access
 * (granted-but-not-implemented); no extension may declare
 * `requestedHostPorts: ["db"]` and rely on it yet. The runtime behind this port
 * — a scoped read surface over the extension's own tables (created by its
 * host-run node-pg-migrate migrations, #118) — is wired by a future release.
 *
 * The SDK ABI is ALREADY 2.0.0 (the `telemetry` port carries the 2.0 major). So
 * a future scoped `ctx.db` WRITE surface is an additive 2.x capability (a new
 * method behind a precise `sdkAbiRange` + grant) — or a 3.0 only if the `db`
 * port shape / privilege model changes. Writes must never be smuggled through
 * the read-only `query()`.
 */
export type HostDbPort = {
  /** Run a parameterized read within the extension's data scope. Reserved — not wired yet (a future release). */
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** The host schema the extension's host-run migrations target. Not wired yet (a future release). */
  readonly schema: string;
};

/** Non-secret per-extension / per-connector configuration persistence. */
export type HostSettingsPort = {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
};

/** Credential storage, deliberately separate from non-secret settings. */
export type HostSecretsPort = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

/** Nango OAuth gateway access (the `@/lib/nango` surface, inverted). */
export type HostNangoPort = {
  isConfigured(): Promise<boolean>;
  getConnection(connectionId: string, providerConfigKey: string): Promise<unknown>;
  ensureConnectSession(input: Record<string, unknown>): Promise<unknown>;
  /**
   * Render-time data getters for connector setup/settings pages (ABI 2.2.0,
   * additive/optional). A connector consumes these null-safe
   * (`ctx.nango.getStatus?.()`) so a host pinned to an older minor degrades
   * gracefully. `connectorKey` is `string` (the SDK does not import the host's
   * connector-roster union; the host narrows at the boundary).
   */
  getStatus?(): Promise<{ status: "connected" | "not_connected"; detail?: string }>;
  getFrontendConfig?(): Promise<{ apiURL?: string; baseURL?: string }>;
  getPrimarySavedConnection?(
    connectorKey: string,
    opts?: { scope?: "app" | "user"; userId?: string },
  ): Promise<{
    connectionId: string;
    providerConfigKey?: string;
    displayName?: string;
    email?: string;
  } | null>;
  getPrimarySavedConnections?(opts?: {
    scope?: "app" | "user";
    userId?: string;
  }): Promise<
    Record<
      string,
      {
        connectorKey: string;
        connectionId: string;
        providerConfigKey: string;
        connectedAt: string;
        scope?: "app" | "user";
        userId?: string;
        displayName?: string;
        email?: string;
        authMode?: string;
        metadata?: Record<string, unknown>;
      } | null
    >
  >;
  listConnectionRecords?(
    connectorKey: string,
  ): Promise<{ connectionId: string; metadata?: Record<string, unknown> }[]>;
  /**
   * The canonical OAuth callback URL Nango sends to providers
   * (`${NANGO_PUBLIC_SERVER_URL}/oauth/callback`) — the exact `redirect_uri` a
   * connector's setup page must tell admins to register in the provider app.
   * Optional + null-safe (`ctx.nango.getNangoOAuthCallbackUrl?.()`): it was
   * ADDED AFTER the 2.2.0 baseline, so it is deliberately NOT one of the five
   * `NANGO_ABI_2_2_ADDED_METHODS` and stays optional even at a `>= 2.2` floor —
   * a connector must read it null-safe regardless of its declared minor, and
   * fall back when a host predates it. Return the literal URL; do NOT normalize
   * (case/port/trailing-slash) — any divergence from what Nango actually sends
   * breaks the registered-equals-sent guarantee.
   */
  getNangoOAuthCallbackUrl?(): Promise<string>;
};

// ---------------------------------------------------------------------------
// ABI-evolution policy: MINIMUM-MINOR semantics keyed off `sdkAbiRange`.
//
// `HostNangoPort` keeps the five 2.2.0-additive render getters OPTIONAL so a host
// pinned to an OLDER minor still type-checks (a connector reads them null-safe,
// `ctx.nango.getStatus?.()`). That optionality is correct WHEN an extension does
// not declare a 2.2 floor — but it produces "optional-method sprawl" for an
// extension that DOES require 2.2: such a connector wrote `getStatus!()` /
// non-null assertions everywhere, with no type-level proof the host actually
// provides the method.
//
// MINIMUM-MINOR fixes this at the TYPE level: a manifest declaring
// `sdkAbiRange` whose lower bound is `>= 2.2` gets a HostNangoPort whose five
// 2.2-added members are NON-OPTIONAL (required), so the host must supply them
// and the connector drops the null-safe ceremony; below a 2.2 floor (e.g. `^2`,
// `~2.1`, `1.x`, unpinned) they stay OPTIONAL exactly as today.
//
// PURELY TYPE-LEVEL + ADDITIVE: no value changes, no ABI bump. `HostNangoPort`
// is untouched (its members stay optional — the legacy/below-2.2 contract). The
// runtime host factory still builds ONE nango impl that provides all getters; the
// minimum-minor type only sharpens what an extension can RELY on given its
// declared floor. `AbiScopedNangoPort<Range>` is the parameterized refinement; an
// author writes `register(ctx: GrantedHostContext<Ports, Range>)` (below) or
// `ctx.nango satisfies AbiScopedNangoPort<"^2.2">` to opt in.
// ---------------------------------------------------------------------------

/** The five render-time getters HostNangoPort ADDED in ABI 2.2.0 (optional on the
 * base port). At a declared `>= 2.2` floor these become required (minimum-minor). */
export const NANGO_ABI_2_2_ADDED_METHODS = [
  "getStatus",
  "getFrontendConfig",
  "getPrimarySavedConnection",
  "getPrimarySavedConnections",
  "listConnectionRecords",
] as const;
export type NangoAbi220AddedMethod = (typeof NANGO_ABI_2_2_ADDED_METHODS)[number];

// The parser below is intentionally STRICT and FAIL-CLOSED-to-FALSE: on any form
// that is NOT an unambiguous CANONICAL `2.<minor>[.<patch>]` floor — a non-numeric
// or empty component, a malformed patch tail, stray characters, OR a non-canonical
// leading-zero numeric (`2.02`) — it resolves to `false` (the getters stay
// OPTIONAL). Failing closed to OPTIONAL is the SAFE direction: it NEVER wrongly
// forces the 2.2 getters required.
//
// This is deliberately a touch STRICTER than the runtime `rangeBounds`
// (register.ts), which tolerates leading-zero numerics via `Number(\d+)`
// (`2.02` → floor 2.2). The divergence is one-sided and safe: where they differ,
// the TYPE under-promotes (stays optional) — it never over-promotes a malformed
// range to required. Real `sdkAbiRange` values are canonical semver, so the two
// agree on every realistic input; the strictness only covers pathological literals.

/** True iff the single ASCII digit is `>= 2`. */
type DigitGte2 = {
  "0": false; "1": false; "2": true; "3": true; "4": true;
  "5": true; "6": true; "7": true; "8": true; "9": true;
};
type SingleDigit = keyof DigitGte2;

/**
 * A CANONICAL numeric semver component (no leading zero unless the whole value is
 * the single digit `"0"`), compared against `>= 2`. Mirrors runtime `Number(...)`
 * on a `\d+`-matched component WITHOUT the leading-zero ambiguity codex flagged:
 *  - single digit            → the lookup table (`"2".."9"` ⇒ true).
 *  - 2+ canonical digits     → `>= 10` ⇒ true.
 *  - leading-zero multi-digit (`"01"`, `"00"`) / non-numeric → `false`
 *    (NON-CANONICAL ⇒ unsupported ⇒ fail closed to optional).
 * Returns `false` (NOT `never`) for a non-canonical component: `never` is
 * assignable to `true`, so a `never` sentinel would WRONGLY satisfy a downstream
 * `extends true` test — the bug a `2.01` literal exposed.
 */
type CanonicalNumGte2<Comp extends string> = Comp extends ""
  ? false // empty component (e.g. the "2." trailing-dot / "2..0" forms) → unsupported
  : Comp extends SingleDigit
    ? DigitGte2[Comp]
    : Comp extends `0${string}`
      ? false // leading-zero multi-digit: non-canonical, fail closed
      : IsAllDigits<Comp> extends true
        ? true // 2+ canonical digits (no leading zero) ⇒ >= 10 ⇒ >= 2
        : false;

/** True iff every char of `S` is an ASCII digit (no `x`/`*`/`-`/`.`/letters). */
type IsAllDigits<S extends string> = S extends ""
  ? true
  : S extends `${infer D}${infer Rest}`
    ? D extends SingleDigit
      ? IsAllDigits<Rest>
      : false
    : false;

/** Strip a single leading comparator/operator (`>=`, `^`, `~`, `=`) then trim spaces. */
type StripOp<S extends string> = S extends `>=${infer R}`
  ? TrimStart<R>
  : S extends `^${infer R}`
    ? TrimStart<R>
    : S extends `~${infer R}`
      ? TrimStart<R>
      : S extends `=${infer R}`
        ? TrimStart<R>
        : S;
type TrimStart<S extends string> = S extends ` ${infer R}` ? TrimStart<R> : S;
type TrimEnd<S extends string> = S extends `${infer R} ` ? TrimEnd<R> : S;
type Trim<S extends string> = TrimEnd<TrimStart<S>>;

/** Is the PATCH tail a runtime-accepted form? `\d+` (canonical) or an x-range
 * wildcard (`x`/`X`/`*`). A patch never affects the major.minor floor, but a
 * MALFORMED patch (`-beta`, `foo`) makes the whole range unsupported → false. */
type ValidPatch<P extends string> = P extends "x" | "X" | "*"
  ? true
  : IsAllDigits<P> extends true
    ? P extends "" // an empty patch (trailing dot) is malformed
      ? false
      : P extends `0${string}`
        ? P extends "0"
          ? true
          : false // leading-zero multi-digit patch: non-canonical
        : true
    : false;

/**
 * Compile-time predicate: does the declared `sdkAbiRange` literal have a LOWER
 * BOUND of `>= 2.2`? Mirrors the runtime `rangeBounds` lower-bound semantics
 * (register.ts): the floor's major must be exactly `2` AND its minor `>= 2`.
 * Forms that meet it: `>=2.2[.z]`, `^2.2[.z]`, `~2.2[.z]`, exact `2.2.z`, `2.2`,
 * `2.2.x`, `2.10` (minor 10 ≥ 2). Forms that do NOT: `^2` / `2` / `2.0` / `2.1` /
 * `~2.1` (floor minor < 2), any major != 2 (`^1`, `^3`, `1.x`), a malformed/
 * non-canonical form (`2.01`, `2.2.0-beta`, `2.2.`), and unpinned (`""`, `"*"`,
 * `undefined`, `null`) — all fail closed to `false` (getters stay optional).
 *
 * Scoped to the 2.x line (the line that ADDED the 2.2 getters). A future
 * `^3`-floor extension is handled when a 3.x additive method is introduced;
 * today only the 2.2 boundary matters.
 */
export type SdkAbiRangeMeets22<Range extends string | null | undefined> =
  // `[never]` guard: `never` distributes/short-circuits and `never` is assignable
  // to `true`, so a `never` Range (or any internal `never`) must NOT reach the
  // required branch. Fail closed to `false`.
  [Range] extends [never]
    ? false
    : Range extends string
    ? StripOp<Trim<Range>> extends `2.${infer MinorAndRest}`
      ? MinorAndRest extends `${infer Minor}.${infer Patch}`
        ? ValidPatch<Patch> extends true
          ? CanonicalNumGte2<Minor> extends true
            ? true // "2.<minor>.<patch>" with a valid patch + minor >= 2
            : false
          : false // malformed patch tail (e.g. "2.2.0-beta") → unsupported
        : CanonicalNumGte2<MinorAndRest> extends true
          ? true // "2.<minor>" (no patch) with minor >= 2
          : false
      : false // major != 2 (or bare "2" → floor 2.0 < 2.2)
    : false;

/** Make the named keys of `T` REQUIRED (drop `?`), keep the rest as-is. */
type RequireKeys<T, K extends keyof T> = Omit<T, K> & {
  [P in K]-?: NonNullable<T[P]>;
};

/**
 * `HostNangoPort` REFINED for a declared `sdkAbiRange`: when the range's lower
 * bound is `>= 2.2` the five 2.2-added getters are REQUIRED (minimum-minor);
 * otherwise the port is exactly the base (getters optional). Type-only — the
 * runtime impl is unchanged.
 */
export type AbiScopedNangoPort<Range extends string | null | undefined> =
  SdkAbiRangeMeets22<Range> extends true
    ? RequireKeys<HostNangoPort, NangoAbi220AddedMethod>
    : HostNangoPort;

/** Current actor / session (the `@/lib/auth-session` surface, inverted). */
export type HostAuthSessionPort = {
  getActor(): Promise<{
    userId: string | null;
    organizationId: string | null;
    orgRole: string | null;
  } | null>;
  requireOrganizationId(): Promise<string>;
};

/**
 * A tool an extension registers with the host MCP server via `ctx.mcp.registerTool`.
 * `handler` returns a PLAIN result (object/array/scalar); the host wraps it into
 * the MCP content/structuredContent envelope at replay time (arrays → `{ items }`,
 * objects → as-is, scalars → `{ result }`). `inputSchema` is an opaque
 * Standard Schema value (e.g. a zod schema — the MCP SDK validates against its
 * `~standard` interface); omit it for a no-argument tool (the host defaults to an
 * empty passthrough object). Typed `unknown` so the SDK stays leaf (no zod dep).
 */
export type HostMcpToolRegistration = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  handler: (input: unknown) => unknown | Promise<unknown>;
};

/** MCP tool registration + self-client + external-server registry. */
export type HostMcpPort = {
  registerTool(tool: HostMcpToolRegistration): void;
  callPrimitive(primitiveName: string, input: unknown): Promise<unknown>;
  listExternalServers(): Promise<unknown[]>;
  /**
   * The operator-configured public base URL of this deployment's MCP server, or
   * `null` when unset. Connector setup pages use it to render the public
   * `${publicBaseUrl}/api/mcp` endpoint for client configuration — without
   * importing host MCP internals (mirror-gate-safe: the host implements this
   * port, the connector only consumes `ctx.mcp.getPublicBaseUrl()`).
   */
  getPublicBaseUrl?(): Promise<{ publicBaseUrl: string | null }>;
};

/**
 * Object-type registration + object store + version history. `ioSpec` is kept
 * opaque (`unknown`) so the SDK contract does not depend on `@cinatra-ai/objects`
 * — the concrete `AgentIOSpec` shape is validated host-side at registration.
 */
export type HostObjectsPort = {
  registerType(descriptor: { typeId: string; ioSpec?: unknown; [k: string]: unknown }): void;
  read<T = unknown>(typeId: string, id: string): Promise<T | null>;
  write<T = unknown>(typeId: string, value: T): Promise<{ id: string }>;
  history(typeId: string, id: string): Promise<unknown[]>;
};

/** Background job enqueue + worker registration (the `@/lib/background-jobs` surface). */
export type HostJobsPort = {
  enqueue(jobName: string, payload: unknown, opts?: Record<string, unknown>): Promise<{ id: string }>;
  registerWorker(jobName: string, handler: (payload: unknown) => Promise<void>): void;
};

/** Host notification emission (the `@/lib/notifications` surface). */
export type HostNotificationsPort = {
  emit(input: { level: "info" | "warn" | "error"; title: string; body?: string }): Promise<void>;
};

/**
 * UI SURFACE registration — NOT a bag of host components. Visual primitives live
 * in `@cinatra-ai/sdk-ui` (a peerDependency); `ctx.ui` registers connector
 * setup/settings surfaces, schema-driven config, and named actions.
 */
export type HostUiPort = {
  registerSetupSurface(surface: unknown): void;
  registerSettingsSurface(surface: unknown): void;
  registerAction(action: { id: string; handler: (input: unknown) => Promise<unknown> }): void;
};

/** Structured logging scoped to the extension. */
export type HostLoggerPort = {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
};

/** Runtime mode / environment flags (the `@/lib/runtime-mode` surface). */
export type HostRuntimePort = {
  readonly mode: "development" | "production";
  flag(name: string): boolean;
  publicBaseUrl(): string | null;
};

/**
 * Capability / facade registration — connectors register providers behind a
 * capability facade (e.g. the email-send facade resolves gmail OR resend; the
 * capability-based dependency model). This is how a connector advertises what it
 * can DO without dependents pinning a concrete provider.
 */
// `resolveProviders` carries an ADDITIVE typed overload: for a first-party
// capability id KNOWN to `CapabilityContractMap` it returns providers whose
// `impl` is the mapped surface type (compile-time ergonomics — callers no longer
// hand-cast `impl as Partial<TSurface>`); the open `string` overload is kept so
// ANY capability id still resolves to `{ packageName; impl: unknown }[]`. The
// registry stores `unknown` either way — the typed overload narrows the COMPILE
// type only, so the host's structural `isXSurface` guards remain the runtime
// trust boundary (this is NOT a runtime validator and NOT a closed roster).
export type HostCapabilitiesPort = {
  registerProvider(capability: string, provider: { packageName: string; impl: unknown }): void;
  resolveProviders<Id extends KnownCapabilityId>(
    capability: Id,
  ): ResolvedCapabilityProvider<Id>[];
  resolveProviders(capability: string): { packageName: string; impl: unknown }[];
};

/**
 * A usage/cost telemetry event a connector emits through `ctx.telemetry`. This
 * MIRRORS the PUBLIC discriminated union of `@cinatra-ai/metric-usage-api`'s
 * `UsageEvent` but is declared HERE so the leaf SDK never imports the host
 * package — the host factory maps it 1:1 onto the real emitter, so the variants
 * must stay in sync (a new metered `source` is an additive SDK change). `source`
 * discriminates; `occurredAt` is ISO-8601; `idempotencyKey` dedupes at-least-once
 * emission. The strict shape rejects malformed events at compile time rather than
 * letting them silently fail downstream.
 */
export type HostLlmUsageEvent = {
  source: "llm";
  provider: "openai" | "anthropic" | "gemini";
  model: string;
  operation: "generate" | "stream";
  agentLabel: string | null;
  skillLabel: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  idempotencyKey: string;
  occurredAt: string;
  requestedProvider?: string | null;
  effectiveProvider?: string | null;
};

export type HostApolloUsageEvent = {
  source: "apollo";
  operation: string;
  agentLabel: string | null;
  requestCount: number;
  resultCount: number;
  creditsConsumed: number;
  idempotencyKey: string;
  occurredAt: string;
};

export type HostUsageEvent = HostLlmUsageEvent | HostApolloUsageEvent;

/**
 * Usage / cost telemetry emission — the inverted `@cinatra-ai/metric-usage-api`
 * surface. A metered connector (e.g. `apollo-connector`) reports per-call usage
 * through `ctx.telemetry.emitUsage(event)` instead of importing the host package.
 * Fire-and-forget by contract: emission MUST NOT throw or block the connector's
 * primary operation (the host swallows collection errors), so the method returns
 * `void`, not a Promise.
 */
export type HostTelemetryPort = {
  emitUsage(event: HostUsageEvent): void;
};

/**
 * The full privileged port surface passed to `register(ctx)`.
 *
 * ABI FROZEN — derived from the extension inventory; all ports required (runtime
 * grant enforcement; see the type-model decision in the file header).
 * Granted least-privilege: the host supplies only the subset an extension's
 * manifest `requestedHostPorts` declares + an admin approves (enforcement
 * progressive, designed here).
 */
export type ExtensionHostContext = {
  readonly abiVersion: string;
  readonly packageName: string;
  db: HostDbPort;
  settings: HostSettingsPort;
  secrets: HostSecretsPort;
  nango: HostNangoPort;
  authSession: HostAuthSessionPort;
  mcp: HostMcpPort;
  objects: HostObjectsPort;
  jobs: HostJobsPort;
  notifications: HostNotificationsPort;
  ui: HostUiPort;
  logger: HostLoggerPort;
  runtime: HostRuntimePort;
  capabilities: HostCapabilitiesPort;
  telemetry: HostTelemetryPort;
};

/** The canonical list of port names — the unit the manifest's
 * `requestedHostPorts` and the security grant model reference. */
export const HOST_PORT_NAMES = [
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
] as const;

export type HostPortName = (typeof HOST_PORT_NAMES)[number];

// ---------------------------------------------------------------------------
// ABI-evolution policy: LEAST-PRIVILEGE in the TYPE SYSTEM — a grant-typed ctx.
//
// `ExtensionHostContext` (above) exposes ALL ports as required props, and
// least-privilege is enforced at RUNTIME (the host grant-aware factory fail-louds
// on an ungranted port; see src/lib/extension-host-context.ts). That stays — it
// is the defense-in-depth backstop and the contract the `register(ctx)` ABI
// freezes against.
//
// `GrantedHostContext<Ports, Range>` is an ADDITIVE compile-time refinement: a
// context type that exposes ONLY the ports an extension's manifest
// `requestedHostPorts` declares (plus the always-available AMBIENT ports
// `logger`/`runtime`, and the immutable `abiVersion`/`packageName` identity).
// An author who types `register(ctx: GrantedHostContext<["settings","nango"]>)`
// gets a compile error on `ctx.secrets` (never granted) — least-privilege caught
// at build time, BEFORE the runtime fail-loud ever fires.
//
// It is parameterized by the declared `sdkAbiRange` too, so a `>= 2.2` extension's
// `ctx.nango` is the minimum-minor `AbiScopedNangoPort` (the 2.2 getters
// required); below 2.2 it is the base optional-getter port. This unifies both
// ABI-evolution-policy mechanisms behind one author-facing ctx type.
//
// PURELY ADDITIVE — `ExtensionHostContext` is unchanged; existing consumers keep
// the full required-prop surface. `GrantedHostContext<Ports>` is STRUCTURALLY a
// subtype of (assignable to a Pick of) `ExtensionHostContext`, so the host's
// grant-aware factory result still satisfies an author's narrower grant typing.
// ---------------------------------------------------------------------------

/** Ambient ports always present regardless of grants (no manifest declaration
 * required). MUST mirror the host factory's `AMBIENT_PORTS`
 * (src/lib/extension-host-context.ts) and the test harness's
 * `TEST_AMBIENT_PORTS` (test-host-context); the abi-2.2.0-contracts test pins it
 * to `["logger","runtime"]` and asserts equality with `TEST_AMBIENT_PORTS`. */
export const AMBIENT_HOST_PORTS = ["logger", "runtime"] as const;
export type AmbientHostPort = (typeof AMBIENT_HOST_PORTS)[number];

/** The two identity fields every ctx carries irrespective of grants. */
type HostContextIdentity = Pick<ExtensionHostContext, "abiVersion" | "packageName">;

/**
 * The compile-time type of a port `P` on a grant-typed ctx, applying the
 * minimum-minor refinement: `nango` becomes `AbiScopedNangoPort<Range>` (its 2.2
 * getters required at a `>= 2.2` floor), every other port is its base type.
 */
type ScopedPort<P extends HostPortName, Range extends string | null | undefined> =
  P extends "nango" ? AbiScopedNangoPort<Range> : ExtensionHostContext[P];

/**
 * Least-privilege, ABI-scoped host context: exposes ONLY the granted `Ports`
 * (plus ambient ports + identity), each at its `Range`-refined type. Accessing a
 * port outside `Ports ∪ ambient` is a COMPILE error; the runtime fail-loud check
 * remains as defense-in-depth.
 *
 * @typeParam Ports - the manifest's `requestedHostPorts` (a tuple/union of
 *   `HostPortName`). Defaults to the full set so an un-parameterized use is the
 *   familiar full surface (just with nango ABI-scoped).
 * @typeParam Range - the declared `cinatra.sdkAbiRange` (drives minimum-minor).
 */
export type GrantedHostContext<
  Ports extends HostPortName = HostPortName,
  Range extends string | null | undefined = undefined,
> = HostContextIdentity & {
  readonly [P in Ports | AmbientHostPort]: ScopedPort<P, Range>;
};

// ---------------------------------------------------------------------------
// ABI-evolution policy: per-port lifecycle TIER. Codifies "reserved-port
// tiering" as DATA — previously it lived only as prose in the `db` TSDoc above +
// a hardcoded `"not-implemented"` branch in the host factory
// (src/lib/extension-host-context.ts). This TS table is the CANONICAL source: the
// host factory imports it directly to drive its `"not-implemented"` branch, so
// wiring a reserved port is a one-line tier flip here. The build-time manifest
// generator runs under bare Node and cannot import this TS module, so it keeps a
// literal mirror of the derived reserved set — a guarded-parity copy, asserted to
// match this table by a vitest parity test (drift fails CI), NOT a second source
// of truth.
//
// ADDITIVE / NON-BREAKING: this changes NO existing type. `ExtensionHostContext`
// keeps every port a required property (the deliberate type-model decision in the
// file header at the top) — the tier is METADATA *about* a port, not a change to
// the surface. No ABI bump: declaring a tier adds no port and wires none.
//
// EVOLUTION RULE (the policy this codifies):
//   - adding a NEW port              → ABI MAJOR.
//   - wiring a `reserved` → `stable` → ABI MINOR (the port already exists; an
//                                      older host just fail-louds it).
//   - removing / reshaping a port    → ABI MAJOR.
// ---------------------------------------------------------------------------

/** ABI lifecycle tier of a host port. */
export const HOST_PORT_TIERS = ["stable", "reserved"] as const;
export type HostPortTier = (typeof HOST_PORT_TIERS)[number];

/**
 * Per-port ABI tier.
 *  - `stable`   — wired, frozen, safe to grant. The real host impl is returned.
 *  - `reserved` — declared in the frozen surface but NOT wired. Granting it is
 *    fail-loud (`"not-implemented"`) until a future MINOR wires it.
 *
 * Today only `db` is reserved (the scoped escape hatch; see its TSDoc above).
 * The host factory's not-implemented branch derives from THIS map directly (a TS
 * import); the bare-Node manifest generator keeps a literal mirror guarded by a
 * parity test that asserts it equals the derived `RESERVED_HOST_PORTS` below.
 */
export const HOST_PORT_TIER: Readonly<Record<HostPortName, HostPortTier>> = {
  db: "reserved",
  settings: "stable",
  secrets: "stable",
  nango: "stable",
  authSession: "stable",
  mcp: "stable",
  objects: "stable",
  jobs: "stable",
  notifications: "stable",
  ui: "stable",
  logger: "stable",
  runtime: "stable",
  capabilities: "stable",
  telemetry: "stable",
} as const;

/** The reserved-tier ports, derived from `HOST_PORT_TIER` (today: `["db"]`). */
export const RESERVED_HOST_PORTS: readonly HostPortName[] = HOST_PORT_NAMES.filter(
  (p) => HOST_PORT_TIER[p] === "reserved",
);
