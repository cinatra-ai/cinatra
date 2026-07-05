// Connector-owned DEV-MODE provisioning hook contract (cinatra#976, epic #978
// wave W-D) — the IMPERATIVE sibling of the declarative-only `./dev-fixtures`
// contract.
//
// An extension MAY declare `cinatra.devSetup` (a package-relative module path,
// recommended `./src/dev-setup`) pointing at a module that exports a named
// `runDevSetup` function of type `ExtensionDevSetupHook`. The host's dev-only
// auto-setup shell (`src/lib/dev-auto-setup.ts`) iterates the generated
// dev-setup registry (`src/lib/generated/dev-setup.server.ts`, emitted by
// `scripts/extensions/generate-extension-manifest.mjs` from each materialized
// extension's manifest) and invokes each hook idempotently on every dev boot.
//
// OWNERSHIP DOCTRINE (#978): the hook body is the connector's OWN dev fixture
// provisioning (docker wiring, key mint, instance registration) and lives in
// the connector repo; core keeps only the orchestration shell plus the docker
// fixture harness itself (`docker/wordpress`, `docker/drupal`, entrypoints —
// explicitly core-for-now). Adding a new connector's dev fixture is therefore
// a connector-repo change (this manifest field + the hook module), never a
// core `dev-auto-setup.ts` edit.
//
// CONTRACT RULES (each hook MUST hold all of these — the shell also
// defense-in-depth try/catches every invocation):
//   - DEV-ONLY: the shell only runs in `CINATRA_RUNTIME_MODE === "development"`;
//     hooks must additionally keep any credential-minting fallbacks gated to
//     loopback targets (never a general production affordance).
//   - IDEMPOTENT: safe to invoke on every boot; reuse-first / probe-then-rotate
//     for minted credentials (never mint on a transient failure).
//   - SOFT-FAIL: never throw; return a `skipped`/`error` status instead — app
//     boot is never blocked by a fixture hiccup.
//   - SECRET BOUNDARY: never log or return credential material; failure
//     details are fixed, hook-owned labels (never a lower-layer error text).
//
// This module is LEAF and TYPE-ONLY for extensions (`import type` — the
// host-peer value-import ban applies to extension code); the host types its
// shell against the same shapes.

/** Per-hook outcome — the shell logs it under the owning package's name. */
export type ExtensionDevSetupStatus =
  | { status: "created"; siteUrl: string; detail?: string }
  | { status: "already-wired"; siteUrl: string; detail?: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

/**
 * The capability-resolution port the shell passes to hooks — the SAME
 * provider-registry surface `register(ctx).capabilities` exposes (impls are
 * `unknown` by contract; hooks narrow structurally before use, exactly like
 * `register(ctx)` consumers do).
 */
export type ExtensionDevSetupCapabilityPort = {
  resolveProviders(capability: string): Array<{ packageName: string; impl: unknown }>;
};

/**
 * Generic, vendor-agnostic MECHANISM helpers the host shell owns (docker/HTTP
 * probing + argv-based container exec). Hooks use these instead of shelling
 * out themselves so the exec surface stays argv-based (no shell interpolation
 * of credential material) and the probe semantics stay uniform across hooks.
 */
export type ExtensionDevSetupHelpers = {
  /** True when a docker container with exactly this name is running. */
  probeDockerContainer(name: string): boolean;
  /** 2xx-only HTTP liveness probe (curl -f semantics). */
  probeHttp(url: string, timeoutSeconds?: number): boolean;
  /** Any-HTTP-answer liveness probe (redirect/403/5xx count as reachable). */
  probeHttpAnswered(url: string, timeoutSeconds?: number): boolean;
  /** Bounded linear-backoff retry over `probeHttpAnswered`. */
  probeHttpReachableWithRetry(
    url: string,
    opts?: { attempts?: number; delayMs?: number; timeoutSeconds?: number },
  ): Promise<boolean>;
  /**
   * Argv-based `docker exec` (spawnSync; never a shell string). Returns the
   * exit code and COMBINED stdout+stderr. SECRET BOUNDARY: argv may carry
   * credential material — callers must never log the argv or raw output.
   */
  dockerExecCapture(containerName: string, args: string[]): { code: number; out: string };
  /** True when the URL's host is a loopback address (localhost/127.0.0.1/::1). */
  isLocalhostUrl(url: string): boolean;
  /** Linear (ReDoS-safe) trailing-slash trim. */
  trimTrailingSlashes(input: string): string;
};

/** The invocation context the host's dev-only shell passes to each hook. */
export type ExtensionDevSetupContext = {
  capabilities: ExtensionDevSetupCapabilityPort;
  /**
   * Browser-reachable Cinatra origin (`http://localhost:<PORT>`) for CMS
   * widget configs — the widget bundle/SSE load in the admin's BROWSER, so
   * this is host-resolved from the actual dev-server port.
   */
  browserBaseUrl: string;
  /** Prefixed dev-boot logger (`[dev-auto-setup:<pkg>] ...`). */
  log(message: string): void;
  helpers: ExtensionDevSetupHelpers;
  /**
   * Mint (or rotate in place) a per-site `cnx_` connect-site credential bound
   * to the host-seeded dev actor's org (cinatra#410). Returns the plaintext
   * `cnx_` exactly once, or null when unavailable (non-dev runtime, unknown
   * client, non-loopback origin, or no dev actor). SECRET BOUNDARY: callers
   * push the value into their own fixture config and never log it.
   */
  mintDevConnectCredential(client: string, widgetOrigin: string): string | null;
};

/**
 * The hook signature: the module declared by `cinatra.devSetup` exports this
 * as a NAMED export `runDevSetup` (the generator validates the declaration
 * fail-closed at emit time; the shell re-validates at invocation).
 */
export type ExtensionDevSetupHook = (
  ctx: ExtensionDevSetupContext,
) => Promise<ExtensionDevSetupStatus>;
