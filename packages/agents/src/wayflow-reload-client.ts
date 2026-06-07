import "server-only";

// Outbound client that POSTs to the WayFlow runtime's
// /.internal/reload-agents endpoint. Called from `agent_source_publish`
// (single-package publish) and from `installAgentPackageWithDependencies`
// (extension install of full dep tree) AFTER the durable side-effects
// succeed. Reload failure is reported via the result object — never
// throws — so the caller can surface `installed_pending_reload: true`
// in its response without aborting the install.
//
// Design contract:
//   - This helper is the ONLY place that sends the POST. Never duplicate.
//   - Callers MUST call it exactly once per top-level operation:
//       agent_source_publish: once after publishAgentPackageFromGitDir +
//         installAgentFromPackage succeed.
//       installAgentPackageWithDependencies: once after the full dep tree
//         installs (NOT inside installAgentFromPackage — that would fire
//         N times for an N-dep tree).

const DEFAULT_TIMEOUT_MS = 10_000;

export type ReloadReport = {
  added: string[];
  changed: string[];
  removed: string[];
  failed: Array<{ label: string; kind: string; error: string }>;
  agents: number;
  last_reload_at: string | null;
};

export type ReloadResult =
  | { ok: true; report: ReloadReport }
  | {
      ok: false;
      reason: "no_token" | "no_base_url" | "http_error" | "timeout" | "network";
      detail?: string;
    };

export type TriggerWayflowReloadOptions = {
  /** Override the default 10s timeout (ms). */
  timeoutMs?: number;
  /** Override the env-derived base URL (test injection). */
  baseUrl?: string;
  /** Override the env-derived bridge token (test injection). */
  bridgeToken?: string;
  /** Override the fetch implementation (test injection). */
  fetchImpl?: typeof fetch;
};

/**
 * POST to ${WAYFLOW_BASE_URL}/.internal/reload-agents with the bridge token.
 *
 * Returns a result object — never throws. Network/timeout/HTTP errors are
 * reported via `{ ok: false, reason }`. Callers should not block durable
 * side-effects on reload success; treat failure as a warning surfaced via
 * `installed_pending_reload: true`.
 *
 * Trailing slashes on WAYFLOW_BASE_URL are stripped.
 */
export async function triggerWayflowReload(
  options?: TriggerWayflowReloadOptions,
): Promise<ReloadResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options?.fetchImpl ?? fetch;

  const rawBaseUrl = options?.baseUrl ?? process.env.WAYFLOW_BASE_URL ?? "";
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  if (!baseUrl) {
    return { ok: false, reason: "no_base_url" };
  }

  const rawToken = options?.bridgeToken ?? process.env.CINATRA_BRIDGE_TOKEN ?? "";
  const bridgeToken = rawToken.trim();
  if (!bridgeToken) {
    return { ok: false, reason: "no_token" };
  }

  const url = `${baseUrl}/.internal/reload-agents`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "X-Cinatra-Bridge-Token": bridgeToken,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: "http_error",
        detail: `HTTP ${res.status}`,
      };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (parseErr) {
      return {
        ok: false,
        reason: "http_error",
        detail: `response parse failure: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      };
    }
    // Validate response shape; a malformed body must not pass through as
    // `ok: true`.
    const validated = _validateReloadReport(body);
    if (validated === null) {
      return {
        ok: false,
        reason: "http_error",
        detail: "response body did not match ReloadReport shape",
      };
    }
    return { ok: true, report: validated };
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === "AbortError") {
      return { ok: false, reason: "timeout", detail: `aborted after ${timeoutMs}ms` };
    }
    return {
      ok: false,
      reason: "network",
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function _validateReloadReport(body: unknown): ReloadReport | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.added) || !b.added.every((x) => typeof x === "string")) return null;
  if (!Array.isArray(b.changed) || !b.changed.every((x) => typeof x === "string")) return null;
  if (!Array.isArray(b.removed) || !b.removed.every((x) => typeof x === "string")) return null;
  if (
    !Array.isArray(b.failed) ||
    !b.failed.every(
      (x) =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as Record<string, unknown>).label === "string" &&
        typeof (x as Record<string, unknown>).kind === "string" &&
        typeof (x as Record<string, unknown>).error === "string",
    )
  ) {
    return null;
  }
  if (typeof b.agents !== "number") return null;
  if (b.last_reload_at !== null && typeof b.last_reload_at !== "string") return null;
  return {
    added: b.added as string[],
    changed: b.changed as string[],
    removed: b.removed as string[],
    failed: b.failed as ReloadReport["failed"],
    agents: b.agents as number,
    last_reload_at: b.last_reload_at as string | null,
  };
}
