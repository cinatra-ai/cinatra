// ---------------------------------------------------------------------------
// Sentry runtime-safe shared helpers.
//
// This module is imported by all three Sentry runtime configs
// (sentry.client/server/edge.config.ts) and so MUST NOT pull in any
// server-only modules or Node-only APIs. The server-only surface (capture
// helpers, server-action wrapper) lives in src/lib/sentry.ts and never
// re-exports from this file in a way that re-introduces server-only.
//
// Exports:
//   - shouldInitSentry(): gate for runtime configs
//   - buildSentryClientOptions({ runtime }): init opts per runtime
//   - beforeSendFilter / beforeBreadcrumbFilter: PII scrubbing
// ---------------------------------------------------------------------------

const SENTRY_REDACTED_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
]);

const SENTRY_REDACTED_BODY_KEYS = new Set([
  "password",
  "newpassword",
  "currentpassword",
  "apikey",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "clientsecret",
  "privatekey",
]);

const REDACTED_PLACEHOLDER = "[Filtered]";

export type SentryClientRuntime = "node" | "edge" | "browser";

export type SentryClientOptions = Record<string, unknown>;

/**
 * Returns true when the runtime should initialise Sentry.
 *
 * Browser builds receive `SENTRY_DSN` only when it is injected at build time,
 * so the browser path also accepts the conventional `NEXT_PUBLIC_SENTRY_DSN`
 * variable. Server and edge runtimes still read `SENTRY_DSN` directly.
 */
export function shouldInitSentry(): boolean {
  const dsn = resolveDsn();
  return typeof dsn === "string" && dsn.length > 0;
}

function resolveDsn(): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  // Browser bundles can only read NEXT_PUBLIC_* envs (Next inlines those at
  // build time). Server / edge bundles have direct access to SENTRY_DSN.
  return process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;
}

export function buildSentryClientOptions(
  args: { runtime: SentryClientRuntime },
): SentryClientOptions {
  const dsn = resolveDsn() ?? "";
  const environment =
    (process.env && process.env.SENTRY_ENVIRONMENT) ||
    (process.env && process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT) ||
    (process.env && process.env.NODE_ENV) ||
    "development";
  const release =
    (process.env && process.env.SENTRY_RELEASE) ||
    (process.env && process.env.NEXT_PUBLIC_SENTRY_RELEASE);
  const tracesSampleRate = parseSampleRate(
    (process.env && process.env.SENTRY_TRACES_SAMPLE_RATE) ||
      (process.env && process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE),
    args.runtime === "browser" ? 0 : 0.1,
  );

  const base: SentryClientOptions = {
    dsn,
    environment,
    release,
    tracesSampleRate,
    sendDefaultPii: false,
    beforeSend: beforeSendFilter,
    beforeBreadcrumb: beforeBreadcrumbFilter,
  };

  if (args.runtime === "node") {
    // Cinatra's NodeTracerProvider owns provider.register(). We attach
    // Sentry's OTel pieces in src/lib/otel-bootstrap.ts instead.
    base.skipOpenTelemetrySetup = true;
  }

  return base;
}

function parseSampleRate(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---------------------------------------------------------------------------
// PII scrubbing — minimal allowlist, applied to every event payload.
// ---------------------------------------------------------------------------

type SentryEvent = {
  request?: {
    headers?: Record<string, unknown>;
    data?: unknown;
    cookies?: unknown;
  };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  user?: Record<string, unknown> | null;
  breadcrumbs?: Array<{
    data?: Record<string, unknown> | undefined;
  }>;
};

export function beforeSendFilter<T extends SentryEvent>(event: T): T {
  if (event.request) {
    if (event.request.headers) {
      event.request.headers = redactObject(
        event.request.headers,
        SENTRY_REDACTED_HEADERS,
      );
    }
    if (event.request.cookies) {
      event.request.cookies = REDACTED_PLACEHOLDER;
    }
    if (event.request.data !== undefined && event.request.data !== null) {
      event.request.data = redactValue(event.request.data);
    }
  }
  if (event.extra) {
    event.extra = redactValue(event.extra) as Record<string, unknown>;
  }
  if (event.user) {
    // Keep Sentry's identification fields; drop anything else as a safety net.
    const allowedUserKeys = new Set(["id", "email", "username", "ip_address"]);
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(event.user)) {
      if (allowedUserKeys.has(k)) {
        sanitized[k] = v;
      }
    }
    event.user = sanitized;
  }
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((b) => {
      if (b.data) {
        return { ...b, data: redactValue(b.data) as Record<string, unknown> };
      }
      return b;
    });
  }
  return event;
}

export function beforeBreadcrumbFilter<T extends { data?: unknown }>(
  breadcrumb: T,
): T {
  if (breadcrumb.data !== undefined && breadcrumb.data !== null) {
    return {
      ...breadcrumb,
      data: redactValue(breadcrumb.data),
    };
  }
  return breadcrumb;
}

function redactObject(
  source: Record<string, unknown>,
  redactKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    if (redactKeys.has(k.toLowerCase())) {
      out[k] = REDACTED_PLACEHOLDER;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Redact a value of any shape.
 *
 * Plain objects and arrays are walked recursively. Strings that look like
 * JSON ({...} or [...]) are parsed, redacted, and re-stringified — Cinatra's
 * API surface is JSON-heavy and Sentry sometimes captures raw bodies as
 * already-stringified payloads.
 *
 * URLSearchParams / FormData / Buffer never reach Sentry's event payload as
 * non-redacted plain objects; they would be serialised by the integration
 * before this hook runs. If a future integration ever surfaces them, they
 * pass through unchanged for now — the explicit gap is documented in
 * https://docs.cinatra.ai/guides/hosting/error-reporting/.
 */
function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth + 1));
  }
  if (typeof value === "string") {
    return redactJsonLikeString(value, depth);
  }
  if (typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENTRY_REDACTED_BODY_KEYS.has(k.toLowerCase())) {
      out[k] = REDACTED_PLACEHOLDER;
      continue;
    }
    out[k] = redactValue(v, depth + 1);
  }
  return out;
}

function redactJsonLikeString(value: string, depth: number): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return value;
  const first = trimmed.charCodeAt(0);
  const looksLikeJson = first === 123 /* { */ || first === 91 /* [ */;
  if (!looksLikeJson) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return value;
  }
  const redacted = redactValue(parsed, depth + 1);
  try {
    return JSON.stringify(redacted);
  } catch {
    return value;
  }
}
