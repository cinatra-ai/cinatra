// Type declarations for the runtime `test-host-context.mjs` (the author-facing
// local test harness). The `.mjs` is plain JS so it is consumable BOTH by this
// TypeScript SDK and by the zero-dependency release-tooling validator/canary.
// These declarations give TS authors the full typed `ExtensionHostContext`.

import type { ExtensionHostContext, HostPortName, HostMcpToolRegistration } from "./host-context";

export declare const TEST_HOST_PORT_NAMES: readonly HostPortName[];
export declare const TEST_AMBIENT_PORTS: readonly HostPortName[];
export declare const HOST_RESERVED_PROVIDER_NAMESPACE: "@cinatra-ai/host";

export declare function isReservedHostProviderIdentity(packageName: string): boolean;

export declare function bindTestProviderIdentity(
  packageName: string,
  provider: { packageName?: string; impl: unknown },
): { packageName: string; impl: unknown };

/** Captures everything a `register(ctx)` registered through the test ctx. */
export type TestHostRecorder = {
  mcpTools: HostMcpToolRegistration[];
  capabilityProviders: Array<{ capability: string; provider: { packageName: string; impl: unknown } }>;
  objectTypes: Array<{ typeId: string; [k: string]: unknown }>;
  uiSetupSurfaces: unknown[];
  uiSettingsSurfaces: unknown[];
  uiActions: Array<{ id: string; handler: (input: unknown) => Promise<unknown> }>;
  jobsEnqueued: Array<{ jobName: string; payload: unknown; opts?: Record<string, unknown> }>;
  notificationsEmitted: Array<{ level: "info" | "warn" | "error"; title: string; body?: string }>;
  telemetryEmitted: unknown[];
};

export type CreateTestHostContextOptions = {
  /** REQUIRED — the authoritative provider identity (cinatra#150). */
  packageName: string;
  /** The manifest's `cinatra.requestedHostPorts`; ungranted ports fail loud. */
  grants?: readonly HostPortName[];
  /** Seeded host-service providers per capabilityId (host-service stubs). */
  capabilities?: Record<string, Array<{ packageName?: string; impl: unknown }>>;
  /** Seeded non-secret settings (live in-memory get/set/delete). */
  settings?: Record<string, unknown>;
  /** Seeded secrets (live in-memory get/set/delete). */
  secrets?: Record<string, string>;
  /** The actor `authSession` resolves; null to simulate an absent actor. */
  actor?: { userId?: string | null; organizationId?: string | null; orgRole?: string | null } | null;
  /** `runtime.mode` (default "development"). */
  runtimeMode?: "development" | "production";
  /** Boolean flags `runtime.flag(name)` reports (secret-shaped names always false). */
  flags?: Record<string, boolean>;
  /** `runtime.publicBaseUrl()` value. */
  publicBaseUrl?: string | null;
  /**
   * Explicit `db` override. GRANT-GATED: rejected (throws) unless "db" is in
   * `grants`. Even then, `db` stays fail-loud in author mode — production never
   * hands back a usable db (the port is RESERVED / not implemented in the host),
   * so the override CANNOT make `ctx.db` usable. Author code that touches `ctx.db`
   * still throws (prod parity); the option exists only to assert the grant
   * relationship without a false-pass.
   */
  db?: unknown;
  /**
   * INERT mode (release-time activation smoke — canary-verify): grant every port
   * inertly (nothing fail-louds), `db` becomes a benign read handle, `runtime.mode`
   * is "production", and unknown/future ports route to a chainable sink. NOT the
   * grant-aware author harness — proves only that a published `register(ctx)` runs
   * CLEAN. Authors leave this unset.
   */
  inert?: boolean;
};

export type CreateTestHostContextResult = {
  ctx: ExtensionHostContext;
  recorder: TestHostRecorder;
  diagnostics: string[];
};

/**
 * Build a faithful author-facing test `ExtensionHostContext`. Grant simulation,
 * capability identity binding (cinatra#150), host-service stubs, in-memory
 * fixtures, a registration recorder, and actionable diagnostics.
 */
export declare function createTestHostContext(
  opts: CreateTestHostContextOptions,
): CreateTestHostContextResult;

/** REDACTED summary of what a register registered — names/counts/ids only. */
export declare function summarizeRecorder(recorder: TestHostRecorder): string[];

/**
 * Sanitize an untrusted author-controlled atom (tool name, typeId, capability id,
 * provider packageName) for safe inclusion in a diagnostic: strips C0/C1 control
 * chars (incl. newline + ANSI ESC) and bounds the length. Exposed for the CLI
 * validator's diagnostics + parity tests.
 */
export declare function sanitizeAtom(value: unknown, max?: number): string;
