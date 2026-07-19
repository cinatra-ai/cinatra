import "server-only";

import { readConnectorConfigFromDatabase } from "@/lib/database";
import { normalizeOriginStrict } from "@/lib/widget-token-broker";
import { resolveAssistantWidgetBinding } from "@/lib/assistant-widget-handles";

// ---------------------------------------------------------------------------
// S5 (cinatra#1221) Lane B §7 — the `/embed/assistant` frame-ancestors resolver.
//
// Goal: the embed page declares `Content-Security-Policy: frame-ancestors <the
// verified instance origin>` so the browser refuses to frame it anywhere but the
// instance's registered site — a clickjacking / rogue-embed wall. The directive
// is computed HERE (read-only) and applied in `proxy.ts` for the one exact path
// (an RSC cannot set a per-request header).
//
// FAIL-CLOSED to `'none'` on EVERY failure mode (unknown assistant, missing /
// non-normalizable siteUrl, DUPLICATE matching instanceId rows, or ANY thrown
// DB/read/normalize exception — the resolver is exception-wrapped so a throw
// NEVER produces an unprotected error response). A `'none'` page
// still renders the shell but cannot be framed — a safe, debuggable failure.
//
// NOT AN AUTHORIZATION BOUNDARY. This resolver only NARROWS framing; it maps
// instanceId -> origin (the OPPOSITE direction from the authoritative
// origin -> instance `resolveCanonicalInstanceForOrigin`, widget-user-auth.ts).
// It CANNOT select a write target and MUST NEVER be used for authorization
// The server still re-derives the write instance from the tokens.
// ---------------------------------------------------------------------------

/** The CSP `frame-ancestors` value for a page that must NOT be framed anywhere. */
export const FRAME_ANCESTORS_NONE = "'none'" as const;

type StoredInstanceRow = { id?: unknown; siteUrl?: unknown };

/**
 * Read-only: resolve the single registered origin for `{instancesConfigKey,
 * instanceId}`, or `null` on ANY failure (missing / duplicate / non-normalizable
 * / thrown). Exception-wrapped: a DB/read/normalize throw becomes `null`, never
 * an escape. This is the authorization-UNUSABLE narrower — do NOT call it to
 * choose a write target.
 */
export function resolveInstanceFrameAncestor(input: {
  instancesConfigKey: string;
  instanceId: string;
}): string | null {
  try {
    const instancesConfigKey = String(input.instancesConfigKey ?? "").trim();
    const instanceId = String(input.instanceId ?? "").trim();
    if (!instancesConfigKey || !instanceId) return null;

    const config = readConnectorConfigFromDatabase<{ instances?: unknown }>(
      instancesConfigKey,
      { instances: [] },
    );
    const instances: StoredInstanceRow[] = Array.isArray(config?.instances)
      ? (config.instances.filter((r) => r && typeof r === "object") as StoredInstanceRow[])
      : [];

    const matches = instances.filter(
      (r) => typeof r.id === "string" && r.id.trim() === instanceId,
    );
    // Zero matches → no binding; DUPLICATE matches → ambiguous. Both fail closed;
    // NEVER select the first of several rows.
    if (matches.length !== 1) return null;

    const siteUrl = typeof matches[0].siteUrl === "string" ? matches[0].siteUrl : "";
    // normalizeOriginStrict returns "" for a missing / non-http(s) /
    // non-normalizable siteUrl.
    const origin = normalizeOriginStrict(siteUrl);
    return origin || null;
  } catch {
    // Any thrown DB/read/normalize exception → treat as unresolved (→ 'none').
    return null;
  }
}

/**
 * The full CSP `frame-ancestors` directive VALUE for `/embed/assistant?assistant
 * =…&instanceId=…`. Returns `'none'` on every failure; on success returns the
 * single registered origin with NO `'self'` (the policy is "ONLY the registered
 * site" — `'self'` would additionally permit the Cinatra origin to frame it,
 * contradicting the scope). `assistant` is mapped to its
 * instances-config key via the CLOSED host-side binding table (NEVER
 * caller-derived); an unknown/forged assistant → `'none'`.
 */
export function frameAncestorsDirectiveFor(input: {
  assistant: string | null | undefined;
  instanceId: string | null | undefined;
}): string {
  const binding = resolveAssistantWidgetBinding(String(input.assistant ?? ""));
  if (!binding) return FRAME_ANCESTORS_NONE;

  const origin = resolveInstanceFrameAncestor({
    instancesConfigKey: binding.instancesConfigKey,
    instanceId: String(input.instanceId ?? ""),
  });
  return origin ?? FRAME_ANCESTORS_NONE;
}
