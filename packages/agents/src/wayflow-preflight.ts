/**
 * Preflight check for WayFlow agent registration.
 *
 * Problem: `agent_run` enqueues a BullMQ job that later fetches the agent
 * card from the WayFlow runtime. If the runtime hasn't picked up a freshly
 * published agent yet (because the reload signal didn't reach it, the
 * container was rebooted mid-publish, the materialize-to-disk step skipped
 * the package, or the runtime image does not expose the reload endpoint), the card endpoint
 * 404s and the BullMQ job fails ~60s later — by which point the user has
 * moved on.
 *
 * The WayFlow runtime exposes `/.internal/reload-agents`, and
 * `agent_source_publish` calls it after publish. When this preflight
 * sees a 404 it now ATTEMPTS A RELOAD then re-probes once before surfacing
 * the error, which closes the small window between publish → materialize
 * → reload during which the agent might briefly not be reachable.
 *
 * Three outcomes (callers must distinguish them):
 *
 *   1. `OK` — endpoint reachable and not 404 (200, 5xx, 4xx-non-404, etc.).
 *      The runtime might still have issues but the agent IS registered
 *      somehow. Proceed with normal dispatch; the BullMQ worker handles
 *      transient runtime errors via its own retry/error path.
 *
 *   2. `WAYFLOW_AGENT_NOT_REGISTERED` — explicit 404 from the runtime.
 *      Caller MUST surface this immediately. Refusing to enqueue keeps
 *      the agent_runs table free of "doomed" rows that will never
 *      complete and that the chat would have to poll uselessly.
 *
 *   3. `WAYFLOW_NOT_CONFIGURED` — deterministic configuration failure
 *      (missing WAYFLOW_BASE_URL, malformed packageName). The run will
 *      definitely fail; surface so the chat tells the operator/dev to
 *      fix the config or republish under a valid scope.
 *
 *   4. `PREFLIGHT_UNAVAILABLE` — transient probe failure (timeout, network
 *      error). The agent might be registered; we just couldn't tell.
 *      Proceed with normal dispatch. The worker has its own error paths.
 *
 * The preflight uses a 2s timeout so a slow WayFlow doesn't delay the chat.
 * Timeout is implemented via Promise.race AND AbortController to be robust
 * to fetch impls that ignore abort signals (custom mocks, polyfills).
 */

import { resolveWayflowUrl } from "./wayflow-url";
import { triggerWayflowReload, type ReloadResult } from "./wayflow-reload-client";

export const WAYFLOW_PREFLIGHT_TIMEOUT_MS = 2000;

export type WayflowPreflightResult =
  | { code: "OK"; recoveredViaReload?: boolean }
  | {
      code: "WAYFLOW_AGENT_NOT_REGISTERED";
      error: string;
      packageName: string;
      expectedUrl: string;
      /** Preflight attempted /.internal/reload-agents and re-probed; this is the reload outcome. */
      reloadAttempt?: ReloadResult;
    }
  | {
      code: "WAYFLOW_NOT_CONFIGURED";
      error: string;
      reason: string;
    }
  | { code: "PREFLIGHT_UNAVAILABLE"; reason: string };

export type PreflightFetch = (
  url: string,
  init: { method: string; signal: AbortSignal },
) => Promise<{ status: number }>;

const defaultFetch: PreflightFetch = (url, init) =>
  fetch(url, init).then((res) => ({ status: res.status }));

const PREFLIGHT_TIMEOUT_SENTINEL = Symbol("wayflow-preflight-timeout");

/**
 * Probe the WayFlow agent-card endpoint for `packageName`. See module
 * docstring for full semantics. Returns one of OK |
 * WAYFLOW_AGENT_NOT_REGISTERED | WAYFLOW_NOT_CONFIGURED |
 * PREFLIGHT_UNAVAILABLE.
 */
export async function preflightWayflowAgent(
  packageName: string,
  options: { fetchImpl?: PreflightFetch; timeoutMs?: number } = {},
): Promise<WayflowPreflightResult> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? WAYFLOW_PREFLIGHT_TIMEOUT_MS;

  let baseUrl: string;
  try {
    baseUrl = resolveWayflowUrl(packageName);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      code: "WAYFLOW_NOT_CONFIGURED",
      error:
        `WayFlow is not configured for agent '${packageName}': ${reason}. ` +
        `Set WAYFLOW_BASE_URL (typically http://localhost:3010 in dev) ` +
        `and ensure the package name matches /^@<vendor>/<slug>$/ before retrying.`,
      reason,
    };
  }

  const expectedUrl = `${baseUrl.replace(/\/+$/, "")}/.well-known/agent-card.json`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<typeof PREFLIGHT_TIMEOUT_SENTINEL>(
    (resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(PREFLIGHT_TIMEOUT_SENTINEL);
      }, timeoutMs);
    },
  );

  try {
    // Race fetch vs timeout: robust to fetch impls that ignore AbortSignal
    // (e.g. custom mocks). The AbortController still fires for impls that
    // do honour it, so well-behaved fetches abort cleanly.
    const raced = await Promise.race([
      fetchImpl(expectedUrl, {
        method: "GET",
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);

    if (raced === PREFLIGHT_TIMEOUT_SENTINEL) {
      return {
        code: "PREFLIGHT_UNAVAILABLE",
        reason: `WayFlow preflight exceeded ${timeoutMs}ms timeout`,
      };
    }

    if (raced.status === 404) {
      // Auto-recovery attempts /.internal/reload-agents and re-probes
      // once before surfacing the error. Closes the publish → materialize →
      // reload window during which the agent might briefly not be reachable.
      // Also self-heals the case where the chat-builder's reload call timed
      // out / hit a transient network blip but the materialize did land.
      const reloadAttempt = await triggerWayflowReload({ timeoutMs });
      if (reloadAttempt.ok) {
        // Re-probe once with a fresh controller. The original AbortController
        // already fired or is racing — must use a new one.
        const reprobeController = new AbortController();
        let reprobeTimer: ReturnType<typeof setTimeout> | null = null;
        const reprobeTimeout = new Promise<typeof PREFLIGHT_TIMEOUT_SENTINEL>(
          (resolve) => {
            reprobeTimer = setTimeout(() => {
              reprobeController.abort();
              resolve(PREFLIGHT_TIMEOUT_SENTINEL);
            }, timeoutMs);
          },
        );
        try {
          const reprobeRaced = await Promise.race([
            fetchImpl(expectedUrl, {
              method: "GET",
              signal: reprobeController.signal,
            }),
            reprobeTimeout,
          ]);
          if (
            reprobeRaced !== PREFLIGHT_TIMEOUT_SENTINEL &&
            reprobeRaced.status !== 404
          ) {
            return { code: "OK", recoveredViaReload: true };
          }
        } finally {
          if (reprobeTimer !== null) clearTimeout(reprobeTimer);
        }
      }

      // Reload didn't help (or itself failed). Surface the actual reason so
      // the operator knows whether to rebuild the container, check env vars,
      // or accept that the agent's tarball is missing cinatra/oas.json.
      const reloadDiagnostic = _formatReloadDiagnostic(reloadAttempt);
      return {
        code: "WAYFLOW_AGENT_NOT_REGISTERED",
        error:
          `Agent '${packageName}' is published but not registered with the WayFlow runtime at ${expectedUrl}. ` +
          `auto-recovery attempted a reload via /.internal/reload-agents — ${reloadDiagnostic}. ` +
          `Likely causes: (a) the wayflow container does not expose /.internal/reload-agents — rebuild and restart: ` +
          `\`docker compose --profile wayflow build wayflow && docker compose --profile wayflow up -d --force-recreate wayflow\`; ` +
          `(b) the agent's package tarball does not include cinatra/oas.json (use publishAgentPackageFromGitDir, not publishAgentPackage); ` +
          `(c) the agent's oas.json failed to parse on the runtime — check \`docker logs cinatra-wayflow-1\` for the parse error.`,
        packageName,
        expectedUrl,
        reloadAttempt,
      };
    }

    return { code: "OK" };
  } catch (err) {
    return {
      code: "PREFLIGHT_UNAVAILABLE",
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function _formatReloadDiagnostic(result: ReloadResult): string {
  if (result.ok) {
    return `reload succeeded but the agent is still not mounted (likely tarball-missing-oas or parse-failure on the runtime)`;
  }
  switch (result.reason) {
    case "no_token":
      return `reload skipped because CINATRA_BRIDGE_TOKEN is unset`;
    case "no_base_url":
      return `reload skipped because WAYFLOW_BASE_URL is unset`;
    case "timeout":
      return `reload timed out — wayflow runtime may be unreachable or missing reload endpoint support`;
    case "http_error":
      return `reload returned HTTP error: ${result.detail ?? "no detail"} — wayflow runtime may be missing /.internal/reload-agents support`;
    case "network":
      return `reload network error: ${result.detail ?? "no detail"}`;
    default: {
      const exhaustive: never = result.reason;
      return `reload failed: ${String(exhaustive)}`;
    }
  }
}
