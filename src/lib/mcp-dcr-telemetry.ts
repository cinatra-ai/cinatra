// Dynamic Client Registration (DCR) usage telemetry.
//
// WHY THIS EXISTS. MCP specification revision `2026-07-28` deprecates DCR with a
// twelve-month minimum removal window, and the recorded maintainer decision on
// cinatra#2218 is RETAIN + instrument: DCR stays enabled through the window,
// usage telemetry is added now so that any later removal is evidence-gated, and
// removal only ever ships alongside the successor mechanism (Client ID Metadata
// Documents). The full disposition — including what this telemetry can and
// cannot decide — is recorded in
// `docs/internals/contracts/mcp-supported-revisions.md`, "Deprecated features".
//
// WHAT IT OBSERVES. There are two ways a registration can be served, and the
// difference decides how much work a removal is, so they are counted apart:
//
//   - `plugin-default`      — the request is forwarded to
//                             `@better-auth/oauth-provider` untouched.
//   - `cinatra-scope-shim`  — cinatra's own route shim unioned the required MCP
//                             scope into a client-supplied `scope` first. The
//                             provider applies `clientRegistrationDefaultScopes`
//                             ONLY when `scope` is FALSY — `if (!body.scope)`,
//                             i.e. absent, `undefined` or `""` — so a client
//                             that registers with an explicit narrow scope (the
//                             MCP CLI proxy does) would otherwise fail the
//                             subsequent authorize with `invalid_scope`.
//
// TRANSPORT. One structured line per attempt via
// `console.info(JSON.stringify({ event, ... }))` — the convention already used
// for machine-readable events in this repo (see the skill-match maintenance
// sweeps in `packages/skills/src/llm-matching/drift-sampler.ts`). Deliberately
// NOT the `@cinatra-ai/metric-contracts` usage bus: that bus is the
// producer/consumer seam for PRICED usage events that get persisted into the
// cost tables, and a client registration is neither priced nor billable.
//
// PAYLOAD CONTRACT — dimensions and counts only. The event carries NO
// `client_id`, NO `client_secret`, NO bearer/session token, NO `redirect_uris`,
// NO `client_name` / `software_id`, NO request headers, NO response body, and NO
// verbatim client-supplied scope string. A DCR response mints a fresh client
// secret; nothing derived from one is logged, and no client-authored string is
// echoed. Widen this payload only with the same rule applied.
//
// This module is deliberately free of `server-only`, database access and the
// `@/lib/auth` graph so it stays directly unit-testable.

/** The stable event name. Grep target for the observation window. */
export const DCR_REGISTRATION_EVENT = "mcp_dcr_registration";

/**
 * The scope the Cinatra MCP resource requires to authorize (`requiredScopes` in
 * `packages/mcp-server/src/index.tsx`). Exported so the route shim and the
 * telemetry classification cannot drift apart.
 */
export const REQUIRED_MCP_SCOPE = "mcp:connect";

/** Which of the two registration paths served the attempt. */
export type DcrRegistrationPath = "plugin-default" | "cinatra-scope-shim";

/**
 * Which branch of the scope rule the client landed in. The partition tracks the
 * provider's OWN rule (`if (!body.scope) body.scope = clientRegistrationDefaultScopes`)
 * so a recorded disposition describes what the provider will actually do:
 *
 * - `omitted`          — `scope` is absent, `undefined`, or `""`. All three are
 *                        falsy, so the provider applies
 *                        `clientRegistrationDefaultScopes` itself.
 * - `already-required` — the client asked for the required scope on its own.
 * - `widened`          — the shim unioned the required scope in. This is the
 *                        only disposition that implies a reliance on cinatra
 *                        code rather than on the provider alone.
 * - `unusable-scope`   — `scope` is PRESENT but yields no usable token set:
 *                        whitespace-only (truthy, so the provider does NOT fill
 *                        in its defaults) or a non-string value (which the
 *                        endpoint's own body validation rejects). Deliberately
 *                        distinct from `omitted`: conflating them would report a
 *                        client the provider defaults for and a client it does
 *                        not as the same observation. Forwarded untouched — this
 *                        lane records admission behaviour, it does not change it.
 * - `unreadable-body`  — the body was not JSON, or not a JSON object; forwarded
 *                        untouched for the provider to reject on its own terms.
 */
export type DcrScopeDisposition =
  | "omitted"
  | "already-required"
  | "widened"
  | "unusable-scope"
  | "unreadable-body";

/** Whether the attempt succeeded, was refused, or never produced a response. */
export type DcrRegistrationOutcome = "accepted" | "rejected" | "handler-error";

export type DcrRegistrationUsageEvent = {
  event: typeof DCR_REGISTRATION_EVENT;
  path: DcrRegistrationPath;
  scopeDisposition: DcrScopeDisposition;
  /** Count of distinct scopes the CLIENT asked for, before any union. */
  clientRequestedScopeCount: number;
  outcome: DcrRegistrationOutcome;
  /** HTTP status of the registration response; `null` when the handler threw. */
  status: number | null;
  occurredAt: string;
};

/**
 * The result of reading a registration body: the telemetry dimensions, plus the
 * scope string the shim should substitute (`null` = forward untouched).
 *
 * One classification drives BOTH the shim and the telemetry, so the recorded
 * `path` can never disagree with what actually happened to the request.
 */
export type DcrRegistrationClassification = {
  path: DcrRegistrationPath;
  scopeDisposition: DcrScopeDisposition;
  clientRequestedScopeCount: number;
  /** Space-delimited replacement scope, or `null` to forward the body as-is. */
  rewrittenScope: string | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classify a parsed DCR request body. Pure — no I/O, no request rebuilding.
 *
 * `body` is `undefined` when the request payload could not be parsed as JSON at
 * all; that is reported as `unreadable-body` rather than silently treated as a
 * scope-less registration, because the two have different causes and a removal
 * decision should not conflate a malformed client with a well-behaved one.
 */
export function classifyDcrRegistration(
  body: unknown,
  requiredScope: string = REQUIRED_MCP_SCOPE,
): DcrRegistrationClassification {
  if (!isPlainObject(body)) {
    return {
      path: "plugin-default",
      scopeDisposition: "unreadable-body",
      clientRequestedScopeCount: 0,
      rewrittenScope: null,
    };
  }

  const raw = body.scope;

  // Falsy `scope` (absent, undefined, or "") → the provider's own
  // `if (!body.scope)` fires and fills in `clientRegistrationDefaultScopes`,
  // which already includes the required scope. Nothing for the shim to do.
  if (raw === undefined || raw === "") {
    return {
      path: "plugin-default",
      scopeDisposition: "omitted",
      clientRequestedScopeCount: 0,
      rewrittenScope: null,
    };
  }

  // Present but unusable: a non-string value (rejected by the endpoint's body
  // schema) or a whitespace-only string (TRUTHY, so the provider does NOT
  // substitute its defaults). Forwarded untouched — behaviour is unchanged from
  // before this telemetry existed — but recorded as its own observation rather
  // than smuggled in under `omitted`.
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      path: "plugin-default",
      scopeDisposition: "unusable-scope",
      clientRequestedScopeCount: 0,
      rewrittenScope: null,
    };
  }

  const scopes = new Set(raw.trim().split(/\s+/).filter(Boolean));
  const clientRequestedScopeCount = scopes.size;

  if (scopes.has(requiredScope)) {
    return {
      path: "plugin-default",
      scopeDisposition: "already-required",
      clientRequestedScopeCount,
      rewrittenScope: null,
    };
  }

  scopes.add(requiredScope);
  return {
    path: "cinatra-scope-shim",
    scopeDisposition: "widened",
    clientRequestedScopeCount,
    rewrittenScope: [...scopes].join(" "),
  };
}

/**
 * Emit one usage event.
 *
 * Best-effort by construction: a telemetry failure must never turn a working
 * client registration into a failed one, so the emit is wrapped and swallowed —
 * the same posture as the usage-event bus in `@cinatra-ai/metric-contracts`.
 *
 * That trade-off has a consequence the removal decision must respect, and it is
 * recorded here rather than left implicit: because a broken log sink is
 * swallowed, ZERO OBSERVED EVENTS IS NOT BY ITSELF PROOF OF NON-USE. It is
 * necessary but not sufficient. A removal proposal has to establish separately
 * that this build was deployed across the declared window and that its stdout
 * was actually collected — see the "can and cannot decide" note in
 * `docs/internals/contracts/mcp-supported-revisions.md`.
 */
export function recordDcrRegistrationUsage(input: {
  path: DcrRegistrationPath;
  scopeDisposition: DcrScopeDisposition;
  clientRequestedScopeCount: number;
  outcome: DcrRegistrationOutcome;
  status: number | null;
}): void {
  try {
    const event: DcrRegistrationUsageEvent = {
      event: DCR_REGISTRATION_EVENT,
      path: input.path,
      scopeDisposition: input.scopeDisposition,
      clientRequestedScopeCount: input.clientRequestedScopeCount,
      outcome: input.outcome,
      status: input.status,
      occurredAt: new Date().toISOString(),
    };
    console.info(JSON.stringify(event));
  } catch {
    // Intentionally swallowed — DCR usage telemetry must never break a
    // registration.
  }
}

/** Map a registration response status onto the recorded outcome. */
export function dcrOutcomeForStatus(status: number): DcrRegistrationOutcome {
  return status >= 200 && status < 300 ? "accepted" : "rejected";
}
