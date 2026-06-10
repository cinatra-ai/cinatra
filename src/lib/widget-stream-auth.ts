import "server-only";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

import type { GeneratedWidgetStreamAuth } from "@/lib/generated/extensions.server";
import { readConnectorConfigFromDatabase } from "@/lib/database";

// Generic widget-stream auth/CORS for the /api/agents/[agentSlug]/stream route.
//
// Replaces the per-CMS trios (resolveDrupalWidgetOrigin/validateDrupalWidgetToken/
// buildDrupalCorsHeaders and the WordPress equivalents) with ONE implementation
// parameterized by the extension's `cinatra.widgetStream.auth` declaration
// (carried in the generated manifest):
//   - `instancesConfigKey`      — the connector_config key whose `instances[]`
//                                 rows carry the admin-configured `siteUrl`s
//                                 that form the CORS Origin allowlist
//   - `requiredInstanceFields`  — instance fields that must be non-empty for a
//                                 row to count (mirrors each CMS's settings
//                                 validity filter, so the allowlist never
//                                 broadens to half-configured instances)
//   - `tokenConfigKey`          — the connector_config key whose `apiKey` is
//                                 the widget's Bearer token
// The host never names a CMS here; policy differences are declaration data.

/**
 * Normalize a stored instance siteUrl for Origin comparison. Superset of the
 * per-CMS read-side normalizers (drupal: trim + strip trailing slashes;
 * wordpress: default https:// + strip hash/search + strip trailing slash) —
 * equivalent in effect for Origin matching, since an Origin header is always
 * `scheme://host[:port]` (no path/hash/search).
 */
function normalizeStoredSiteUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return withProtocol.replace(/\/+$/, "");
  }
}

const forCompare = (v: string) => v.replace(/\/+$/, "").toLowerCase();

/**
 * CORS origin allowlist for a widget-stream agent. Reflects the exact Origin
 * header value when it matches the normalized siteUrl of a VALID configured
 * instance (all `requiredInstanceFields` non-empty). Returns null otherwise.
 * Never a wildcard: responses are scoped to a configured CMS site origin.
 */
export function resolveWidgetStreamOrigin(
  originHeader: string | null,
  auth: GeneratedWidgetStreamAuth,
): string | null {
  if (!originHeader) return null;
  const config = readConnectorConfigFromDatabase<{ instances?: unknown }>(
    auth.instancesConfigKey,
    { instances: [] },
  );
  const instances = Array.isArray(config?.instances) ? config.instances : [];
  const want = forCompare(originHeader.trim());
  if (!want) return null;
  for (const raw of instances) {
    if (!raw || typeof raw !== "object") continue;
    const instance = raw as Record<string, unknown>;
    const siteUrl = String(instance.siteUrl ?? "").trim();
    if (!siteUrl) continue;
    const valid = auth.requiredInstanceFields.every(
      (field) => String(instance[field] ?? "").trim().length > 0,
    );
    if (!valid) continue;
    if (forCompare(normalizeStoredSiteUrl(siteUrl)) === want) return originHeader;
  }
  return null;
}

/**
 * Bearer token validator for a widget-stream agent. Compares against the
 * `apiKey` stored under the declared connector_config key (the UUID-pair the
 * connector's auth-config generation wrote). Constant-time comparison.
 */
export function validateWidgetStreamToken(
  token: string,
  auth: GeneratedWidgetStreamAuth,
): boolean {
  if (!token) return false;
  const config = readConnectorConfigFromDatabase<{ apiKey?: unknown } | null>(
    auth.tokenConfigKey,
    null,
  );
  const apiKey = typeof config?.apiKey === "string" ? config.apiKey : "";
  if (!apiKey) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(apiKey);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * CORS headers reflecting the validated origin. Use only after
 * resolveWidgetStreamOrigin returns non-null. (The former per-CMS builders
 * emitted this exact header set.)
 */
export function buildWidgetStreamCorsHeaders(allowedOrigin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "false",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
