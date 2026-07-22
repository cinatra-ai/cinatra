export type AppRuntimeMode = "development" | "production";

const APP_RUNTIME_MODE_ENV_KEYS = ["CINATRA_RUNTIME_MODE", "APP_RUNTIME_MODE"] as const;

export function normalizeAppRuntimeMode(value: string | null | undefined): AppRuntimeMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "production" || normalized === "prod" ? "production" : "development";
}

export function getAppRuntimeMode(
  env: Record<string, string | undefined> = process.env,
): AppRuntimeMode {
  for (const key of APP_RUNTIME_MODE_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return normalizeAppRuntimeMode(value);
    }
  }

  return "development";
}

export function isAppDevelopmentMode(
  env: Record<string, string | undefined> = process.env,
) {
  return getAppRuntimeMode(env) === "development";
}

// ---------------------------------------------------------------------------
// Local-CLI connection-mode eligibility (cinatra#1926, epic #1873 M5) — the
// SINGLE, server-resolved source of truth for whether a provider connector may
// expose (and persist, and resolve transport for) its dev/preview "Local CLI"
// connection mode.
//
// Owner ruling (2026-07-21): every assistant connects through its provider
// connector via the respective API; the legacy local-CLI mechanism survives ONLY
// as a connection-mode CHOICE on the connector's setup page, and that choice is
// HIDDEN — not rendered at all, its write rejected, its transport refused —
// unless the installation is in development mode OR is a preview installation.
//
// This predicate is consumed identically by RENDERING (the connector setup route
// strips the gated option from the surface SERVER-SIDE before the form reaches
// the browser — never a client-side hide), CONFIG-WRITE gating (each connector's
// write handler rejects a local-CLI selection server-side), and TRANSPORT
// resolution (each connector resolves API-vs-local-CLI transport from its
// persisted config, falling back to API when this predicate is false). All three
// consume THIS helper (or the host `runtime-mode` service that wraps it) — never
// an independent re-derivation, so the three enforcement points can never drift.
//
// It lives HERE, alongside the runtime-mode primitives it composes, rather than
// in a standalone module, so that publishing it from the host runtime-mode
// service and importing it on the (dev-perf-locked) reachable graph of the
// assistant routes adds NO new first-party module edge (route-graph ratchet) —
// runtime-mode is already on every such graph. Server-resolved ONLY: both signals
// are read from the process environment on the server, never a client value. Pure
// env logic (no server-only APIs, no IO) so it is unit-testable against an
// explicit env.

/**
 * The server-side install-class flag introduced by cinatra#1926 (no
 * preview-installation signal existed in code before this). A preview
 * installation is provisioned with `CINATRA_INSTALL_CLASS=preview`; the flag is
 * read ONLY on the server (never from a client-supplied value). Any other value —
 * including unset — is a normal installation (fail-safe: only the exact string
 * `"preview"` opts in).
 */
export function isPreviewInstallation(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.CINATRA_INSTALL_CLASS === "preview";
}

/**
 * The single eligibility predicate: the local-CLI connection mode is eligible
 * when the app runs in development mode (`CINATRA_RUNTIME_MODE`/`APP_RUNTIME_MODE`
 * normalizes to `development` — the same normalization the rest of the codebase
 * gates on) OR the installation is a preview installation. Everything else — a
 * production, non-preview installation — is INELIGIBLE (the local-CLI option is
 * absent, its write rejected, its transport refused).
 *
 * The runtime-mode half reuses `getAppRuntimeMode` (the one place the runtime-mode
 * env keys + string are interpreted) rather than re-deriving the check, so the
 * dev-mode semantics stay byte-identical to `isAppDevelopmentMode()`.
 * Parameterized on `env` purely so it is exhaustively unit-testable; production
 * callers pass none and read `process.env`.
 */
export function localCliEligible(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return getAppRuntimeMode(env) === "development" || isPreviewInstallation(env);
}
