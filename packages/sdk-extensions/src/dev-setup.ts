// Extension-declared DEV-MODE provisioning HOOK contract (cinatra-ai/cinatra#976,
// epic #978 wave W-D).
//
// A connector MAY declare `cinatra.devSetup` (a package-relative module path,
// recommended `./src/dev-setup`) whose module exposes a `runDevSetup(ctx)` entry.
// On a dev boot the host's dev-only orchestration shell (server-side, gated on
// `CINATRA_RUNTIME_MODE==="development"`, fire-and-forget, soft-fail) discovers
// each MATERIALIZED connector declaring the hook, dynamically imports it, builds
// an `ExtensionDevSetupContext`, and invokes `runDevSetup(ctx)` IDEMPOTENTLY —
// the same "core owns the orchestration MECHANISM, the connector owns its own
// vendor provisioning" inversion the epic's doctrine mandates.
//
// Unlike `./dev-fixtures` (DECLARATIVE data — `setting`/`object` surfaces only),
// a devSetup hook is IMPERATIVE: it wires a local docker fixture (mint a
// credential, register an instance row, push a widget config) that cannot be
// expressed as static data. It runs ONLY in dev, ONLY against localhost, and
// reaches host services through the capability port on its context — never a
// host `@/` import (the host-peer value-import ban). The imperative IO it needs
// (docker exec, HTTP probes) is supplied by the host through `helpers`, so the
// connector never imports `node:child_process` for provisioning.
//
// This module is LEAF (no host imports, no runtime deps — the SDK stays
// dependency-free). The context/status/helper shapes here are the STABLE
// contract that every connector `dev-setup.ts` and the host shell share; the
// guard is hand-rolled (no zod) to keep the package dependency-free.
//
// NOT part of the FROZEN `register(ctx)` ABI (see `./register`): the devSetup
// context is a SEPARATE, host-owned, dev-only shape. A change to it is a dev-DX
// concern, not an SDK ABI break.

/**
 * The soft-fail status a devSetup hook returns to the host shell (mirrors the
 * shell's own per-connector result). A hook NEVER throws to the shell — it
 * soft-fails by returning `skipped`/`error`; the shell logs it and moves on so
 * a single connector's docker/credential hiccup never blocks dev boot.
 */
export type ExtensionDevSetupStatus =
  | { status: "created"; siteUrl: string; detail?: string }
  | { status: "already-wired"; siteUrl: string; detail?: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

/**
 * Host-provided, dev-only IO helpers a devSetup hook uses to probe + drive its
 * local docker fixture. All are host-owned and controlled-input only (fixed
 * container names, localhost URLs) so a connector's provisioning never reaches
 * for `node:child_process` / raw sockets itself.
 */
export type ExtensionDevSetupHelpers = {
  /**
   * `docker exec <container> <argv...>` in capture mode (combined stdout+stderr).
   * argv-based (NO shell string) so credential material never passes through
   * shell interpolation. Returns the exit code + combined output; never throws
   * (a non-zero exit is reported via `code`).
   */
  dockerExecCapture(container: string, argv: string[]): { code: number; out: string };
  /** True when a docker container with EXACTLY this name is running. */
  probeDockerContainer(name: string): boolean;
  /** True when the URL answers a 2xx (a `curl -f`-style hard probe). */
  probeHttp(url: string, timeoutSeconds?: number): boolean;
  /**
   * Bounded-retry reachability: resolves true as soon as the URL ANSWERS — any
   * HTTP status, including a redirect / 4xx / 5xx (a freshly installed fixture
   * serves a non-2xx while it settles) — within the retry window, and false
   * only when it never answered (genuine connection refusal / timeout).
   */
  probeHttpReachableWithRetry(
    url: string,
    options?: { attempts?: number; delayMs?: number; timeoutSeconds?: number },
  ): Promise<boolean>;
  /** True when the URL's host is a loopback address (localhost / 127.0.0.1 / ::1). */
  isLocalhostUrl(url: string): boolean;
  /** Linear trailing-slash trim (ReDoS-safe; the shared host normaliser). */
  trimTrailingSlashes(input: string): string;
};

/**
 * The narrowed capability-resolution surface a devSetup hook uses to reach the
 * host services it needs. Deliberately the SAME string-keyed `resolveProviders`
 * shape as `HostCapabilitiesPort` (so the host can hand its real capabilities
 * registry straight through): a hook resolves `@cinatra-ai/host:*` service ids
 * (+ `nango-system`), then STRUCTURALLY narrows each `impl` before use.
 *
 * READ-ONLY by contract: a devSetup hook only RESOLVES — it never REGISTERS a
 * provider (publication into the registry is the `register(ctx)` activation
 * path, not a dev-boot concern).
 */
export type ExtensionDevSetupCapabilities = {
  resolveProviders(capability: string): Array<{ packageName: string; impl: unknown }>;
};

/**
 * The context the host's dev-only shell passes to a connector's `runDevSetup`.
 * DEV-ONLY and NOT part of the frozen `register(ctx)` ABI — a separate,
 * host-owned shape scoped to dev-boot provisioning.
 */
export type ExtensionDevSetupContext = {
  /** Host service resolution (see `ExtensionDevSetupCapabilities`). */
  capabilities: ExtensionDevSetupCapabilities;
  /** Host-provided imperative IO helpers (see `ExtensionDevSetupHelpers`). */
  helpers: ExtensionDevSetupHelpers;
  /** Emit a dev log line (the host prefixes it with the connector package). */
  log: (message: string) => void;
  /**
   * Mint (or rotate) a per-site `cnx_` connect-site credential bound to the
   * host-seeded dev actor's org for the given CMS `client` + browser
   * `widgetOrigin`, or null when unavailable (non-dev / non-loopback origin /
   * mint failed). The plaintext is returned exactly once for the caller to push
   * into the CMS widget config in the SAME step (the host handles the secret
   * boundary at the call site). Host-gated: strictly dev + loopback only.
   */
  mintDevConnectCredential: (client: string, widgetOrigin: string) => string | null;
  /**
   * Browser-reachable Cinatra origin (`http://localhost:<PORT>`) for the CMS
   * widget config — it must resolve from the admin's BROWSER on the host, never
   * a container-only origin. Tracks the actual dev-server port.
   */
  browserBaseUrl: string;
};

/**
 * The module shape a `cinatra.devSetup` path must expose: a single
 * `runDevSetup(ctx)` entry the host shell invokes. Idempotent + soft-fail by
 * contract (returns a status; never throws to the shell).
 */
export type ExtensionDevSetupModule = {
  runDevSetup(
    ctx: ExtensionDevSetupContext,
  ): Promise<ExtensionDevSetupStatus> | ExtensionDevSetupStatus;
};

/**
 * Structural guard the host shell uses after `import()`ing a `cinatra.devSetup`
 * module to confirm it exposes the `runDevSetup` entry BEFORE invoking it — a
 * missing / malformed hook is soft-skipped, never a boot crash. Pure (no IO);
 * unit-tested in isolation.
 */
export function isExtensionDevSetupModule(mod: unknown): mod is ExtensionDevSetupModule {
  return (
    !!mod &&
    typeof mod === "object" &&
    typeof (mod as { runDevSetup?: unknown }).runDevSetup === "function"
  );
}
