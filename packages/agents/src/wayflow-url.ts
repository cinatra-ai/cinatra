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

/**
 * The `.env.local` key an install (`cinatra install` / `scripts/setup.sh`)
 * records to say what it decided about the WayFlow runtime. Mirrors the
 * `WAYFLOW_RUNTIME_KEY` constant in cinatra-cli's `wayflow-runtime.mjs` —
 * that module and `cinatra doctor` are the canonical source for this
 * three-way split; keep the mode strings in sync with it.
 */
export const WAYFLOW_RUNTIME_KEY = "CINATRA_WAYFLOW_RUNTIME";

/** local    — this install owns a local stack and starts WayFlow in it.
 *  off      — deliberate opt-out (`--no-wayflow` / `NO_WAYFLOW=1`).
 *  external — this install owns no local stack, so it neither owns nor
 *             starts a local WayFlow runtime; WAYFLOW_BASE_URL points at
 *             one the operator runs elsewhere. */
export type WayflowRuntimeMode = "local" | "off" | "external";

const VALID_RUNTIME_MODES = new Set<WayflowRuntimeMode>([
  "local",
  "off",
  "external",
]);

/**
 * Normalize a recorded `CINATRA_WAYFLOW_RUNTIME` value. An unknown or absent
 * value falls back to `"local"` — default-on is the contract, so a checkout
 * that predates this key (or an unset env in a non-CLI context) is read as
 * "should have a runtime" rather than silently excused. Matches
 * `normalizeWayflowRuntimeMode` in cinatra-cli.
 */
export function normalizeWayflowRuntimeMode(
  raw: string | null | undefined,
): WayflowRuntimeMode {
  const value = String(raw ?? "").trim().toLowerCase();
  return VALID_RUNTIME_MODES.has(value as WayflowRuntimeMode)
    ? (value as WayflowRuntimeMode)
    : "local";
}

/**
 * Build a `docker compose` invocation pinned to the live stack's compose
 * project (`-p cinatra_cinatra`) and its two compose files, with `action`
 * appended verbatim (e.g. `"up -d --build wayflow"`, `"build wayflow"`).
 *
 * Every WayFlow-recovery message in this module goes through this one
 * builder so the project flag and profile can never drift between surfaces
 * again — an unpinned invocation forks a SEPARATE compose project that
 * can't see the running network. Exported so other surfaces that need a
 * WayFlow compose command (e.g. the agent-not-registered preflight in
 * `wayflow-preflight.ts`, whose recovery action differs — rebuild + force
 * recreate rather than a plain `up`) build it from the same source instead
 * of hand-writing the project/profile flags again.
 */
export function wayflowComposeCommand(action: string): string {
  return (
    `docker compose -p cinatra_cinatra -f docker-compose.yml -f docker-compose.dev.yml ` +
    `--profile wayflow ${action}`
  );
}

/**
 * The complete, project-pinned docker fallback for bringing the WayFlow
 * service up directly, without the CLI. Pinned to the live stack's compose
 * project (`-p cinatra_cinatra`) so it never forks a second, network-isolated
 * project, and preceded by the bridge-token env generator the wayflow
 * container needs to boot at all.
 */
const DOCKER_FALLBACK =
  "`source .env.local && node scripts/gen-wayflow-env.mjs --require-bridge-token " +
  `&& ${wayflowComposeCommand("up -d --build wayflow")}\``;

/** `cinatra instance wayflow start`, always caveated: it is not on every
 *  released CLI yet (a fresh install runs the released CLI), so a bare
 *  operator following it verbatim can hit a nonexistent command. */
const CLI_START_HINT =
  "`cinatra instance wayflow start` if your cinatra-cli has it (not every " +
  "released CLI does yet)";

/**
 * Map a dispatch error thrown while reaching the WayFlow runtime into an
 * actionable run-error string that names the target URL and the underlying
 * cause (#562), then tailors the recovery guidance to what this install
 * actually recorded about the runtime (`CINATRA_WAYFLOW_RUNTIME`) —
 * following `cinatra doctor`'s local/off/external split so the guidance
 * never tells an operator to "start" a runtime this install never owned, or
 * stays silent about a deliberate opt-out.
 *
 * When `client.sendTask` can't connect, undici's `fetch` throws a bare
 * `TypeError: fetch failed` whose only useful context lives in `err.cause`
 * (e.g. `Error: connect ECONNREFUSED 127.0.0.1:8001` with `.code`). Recording
 * `err.message` alone surfaces just "fetch failed" on the run — no endpoint, no
 * reason — which is undebuggable (the issue's exact symptom: started_at null,
 * no steps, bare "fetch failed").
 *
 * This helper is pure (no I/O, no direct env read) so it stays unit-testable
 * and so the call site can both log the structured form server-side and
 * store the returned string on the run. The runtime mode is passed in by the
 * caller (which reads `process.env.CINATRA_WAYFLOW_RUNTIME`) rather than read
 * here, keeping the env access at the single call site. Non-fetch errors
 * (e.g. a WayFlow 500 surfaced by the A2A client) pass through unchanged so
 * existing actionable messages — like the OpenAI-key 401 that the error panel
 * already linkifies — are preserved.
 *
 * @param err         The thrown dispatch error (unknown shape).
 * @param wayflowUrl  The resolved WayFlow A2A URL the dispatch targeted.
 * @param options.runtimeMode  The raw `CINATRA_WAYFLOW_RUNTIME` value from
 *   the caller's environment (normalized here); absent/unknown reads as
 *   `"local"`, matching cinatra-cli's own fallback.
 */
export function describeWayflowDispatchError(
  err: unknown,
  wayflowUrl: string,
  options: { runtimeMode?: string | null } = {},
): string {
  const message = err instanceof Error ? err.message : String(err);

  // Only rewrite the bare connectivity failure. A non-"fetch failed" error
  // (HTTP 4xx/5xx body, validation error, etc.) already carries actionable
  // text and must pass through verbatim.
  if (!/fetch failed/i.test(message)) {
    return message;
  }

  // undici nests the real reason in `.cause` (and occasionally a deeper
  // `.cause.cause`). Walk a bounded chain to pull the first code/message.
  let cause: unknown =
    err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  let causeCode: string | undefined;
  let causeMessage: string | undefined;
  for (let depth = 0; depth < 4 && cause != null; depth += 1) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0 && !causeCode) {
      causeCode = code;
    }
    const msg = (cause as { message?: unknown }).message;
    if (typeof msg === "string" && msg.length > 0 && !causeMessage) {
      causeMessage = msg;
    }
    cause = (cause as { cause?: unknown }).cause;
  }

  const detail = causeCode ?? causeMessage;
  const reason = detail ? ` (${detail})` : "";
  const preamble = `Could not reach the agent runtime at ${wayflowUrl} — fetch failed${reason}.`;
  const mode = normalizeWayflowRuntimeMode(options.runtimeMode);

  if (mode === "off") {
    return (
      `${preamble} The WayFlow runtime is disabled for this install ` +
      `(${WAYFLOW_RUNTIME_KEY}=off, e.g. \`--no-wayflow\` at install time), ` +
      `so agent runs fail until you enable it. Re-run the install without the ` +
      `opt-out, start it now with ${CLI_START_HINT}, or bring it up directly ` +
      `from the checkout root: ${DOCKER_FALLBACK}.`
    );
  }

  if (mode === "external") {
    return (
      `${preamble} This install is configured for an external WayFlow runtime ` +
      `(${WAYFLOW_RUNTIME_KEY}=external) — it starts no local WayFlow container. ` +
      `Check that the runtime WAYFLOW_BASE_URL points at is running and reachable.`
    );
  }

  // "local": this install should own a running runtime and it is not
  // reachable. An unset/legacy key normalizes to "local" too (an install
  // predating the key never recorded an opt-out, so it reads as "promised" —
  // truthful, since its agent runs do fail the same way); word that case as
  // "expected" rather than falsely claiming a value was recorded.
  const recordedLocal =
    normalizeWayflowRuntimeMode(options.runtimeMode) === "local" &&
    String(options.runtimeMode ?? "").trim().toLowerCase() === "local";
  const localClause = recordedLocal
    ? `recorded as local (${WAYFLOW_RUNTIME_KEY}=local)`
    : `expected to be local (no ${WAYFLOW_RUNTIME_KEY} recorded — this install predates it, or the key is unset here)`;
  return (
    `${preamble} This install's WayFlow runtime is ${localClause} — it ` +
    `should be running and is not. Check that it's up and reachable (e.g. ` +
    `the dev tunnel/Funnel and WAYFLOW_BASE_URL). Start it with ${CLI_START_HINT}. ` +
    `Otherwise, bring it up directly from the checkout root: ${DOCKER_FALLBACK}.`
  );
}

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
