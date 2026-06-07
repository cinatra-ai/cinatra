/**
 * Single source for resolving a WayFlow A2A URL from a package name.
 *
 * Strict regex validation rejects path-traversal and URL-injection chars.
 * Output URL pattern is:
 *
 *   `${WAYFLOW_BASE_URL}/agents/<vendor>/<slug>/`
 *
 * Each `vendor` and `slug` segment must match `[a-z0-9][a-z0-9-]*` — leading
 * dash, uppercase, dot, underscore, slash, percent-encoded slash, whitespace,
 * `?`, `#`, `..`, `.`, and any other URL-injection character is rejected.
 */
const PACKAGE_NAME_RE = /^@([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/;

/**
 * Undici headers/body timeout for outbound calls to WayFlow.
 *
 * Set above WayFlow's blocking-mode cap so the AbortSignal (the A2A
 * client `timeoutMs`) governs cancellation rather than undici's internal
 * headers/body timer firing first ("fetch failed" with no upstream
 * context). Used by both
 * `packages/agent-builder/src/execution.ts` and
 * `src/app/api/a2a/agents/[...slug]/route.ts`. Lift through this shared
 * constant so tuning the WayFlow cap requires editing one place rather
 * than hunting through call sites.
 *
 * The timeout is 86_400_000 ms (24h) to match the WayFlow ApiNode + A2A
 * + blocking timeout patches in `docker/wayflow/agent_loader.py`. Without
 * this, the undici transport timer would kill connections at 12.5min for
 * batch LLM workloads that legitimately take hours.
 */
export const WAYFLOW_UNDICI_TIMEOUT_MS = 86_400_000;

/**
 * 24h AbortSignal ceiling used by every
 * `createExternalA2AClient({ ... timeoutMs })` call going to a local
 * WayFlow `sendTask` endpoint. Paired with the WayFlow Python timeout
 * patches in `docker/wayflow/agent_loader.py`. Operators who want a
 * shorter timeout for a specific call can still pass an explicit
 * `timeoutMs` per call; this constant just centralizes the default
 * batch-LLM-safe value.
 */
export const WAYFLOW_A2A_TIMEOUT_MS = 86_400_000;

/**
 * Maximum value accepted by the MCP `agent_run` handler's
 * `timeoutSeconds` parameter (validated at
 * `packages/agents/src/mcp/handlers.ts` and the Zod schema at
 * `packages/agents/src/mcp/schemas.ts`). 24h matches the OpenAI batch
 * SLA upper bound and the WayFlow loader patches.
 */
export const AGENT_RUN_TIMEOUT_MAX_SECONDS = 86_400;

export function resolveWayflowUrl(
  packageName: string | null | undefined,
): string {
  if (typeof packageName !== "string" || packageName.length === 0) {
    throw new Error(
      `resolveWayflowUrl: packageName must be a non-empty '@vendor/slug' string; got ${JSON.stringify(packageName)}`,
    );
  }
  const m = PACKAGE_NAME_RE.exec(packageName);
  if (!m) {
    throw new Error(
      `resolveWayflowUrl: packageName '${packageName}' does not match strict @vendor/slug pattern ` +
        `(/^@([a-z0-9][a-z0-9-]*)\\/([a-z0-9][a-z0-9-]*)$/). ` +
        `Rejected for path-traversal or URL-injection characters.`,
    );
  }
  const [, vendor, slug] = m;
  const baseUrl = process.env.WAYFLOW_BASE_URL;
  if (!baseUrl) {
    throw new Error("resolveWayflowUrl: WAYFLOW_BASE_URL is not set");
  }
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  return `${trimmedBase}/agents/${vendor}/${slug}/`;
}

/**
 * Build a `fetch` impl whose underlying undici dispatcher has long
 * `headersTimeout` / `bodyTimeout` suitable for blocking `sendTask`
 * calls to WayFlow that may legitimately take up to 24h (batch LLM
 * polling, long web_search ApiNode calls).
 *
 * `globalThis.fetch` uses the default undici dispatcher whose
 * `headersTimeout` is 300s — without this helper, blocking sendTask
 * calls die at 5 min even with a 24h AbortSignal `timeoutMs`.
 *
 * Used by every `createExternalA2AClient({ fetchImpl: ... })` call
 * targeting a local WayFlow endpoint. The dispatcher is pool-friendly
 * (Undici Agent does its own connection pooling) — call this once at
 * call-site init and pass the returned fetch through.
 *
 * All local WayFlow A2A call sites use this helper so resume and approval
 * flows share the same long-timeout behavior as the main execution path.
 */
export function createWayflowFetch(): typeof globalThis.fetch {
  // Dynamic require so this module remains side-effect-free for callers
  // that import other helpers (resolveWayflowUrl, etc.) without needing
  // undici loaded.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const undici = require("undici") as {
    Agent: new (opts: { headersTimeout: number; bodyTimeout: number }) => unknown;
    fetch: typeof globalThis.fetch;
  };
  const dispatcher = new undici.Agent({
    headersTimeout: WAYFLOW_UNDICI_TIMEOUT_MS,
    bodyTimeout: WAYFLOW_UNDICI_TIMEOUT_MS,
  });
  // Cast the wrapper to globalThis.fetch — the `dispatcher` field is an
  // undici extension to RequestInit that's not in the TS lib but is
  // honored by undici.fetch at runtime.
  return ((url: string | URL | Request, init?: RequestInit) =>
    undici.fetch(url as never, {
      ...(init ?? {}),
      dispatcher,
    } as never)) as typeof globalThis.fetch;
}
