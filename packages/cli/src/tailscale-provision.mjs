// ---------------------------------------------------------------------------
// Pure provision-decision helpers.
//
// Plain ESM `.mjs` — NO TypeScript, NO `@/` aliases, NO `server-only`,
// NO `node:child_process`, NO DB, NO network. Same leaf-purity contract
// as `clone-runtime.mjs` so BOTH the plain-Node CLI (`runCloneStart`)
// and the `cinatra dev tunnel` verb import the exact same proven decision
// boundary, hermetically unit-testable without Docker / Tailscale.
//
// This module owns two safety-critical, reviewable concerns:
//
//   MagicDNS hostname-collision guard
//     After a node registers, the registered `Self.DNSName` hostname
//     segment MUST equal `deriveDevTailscaleHostname(...)`. A Tailscale
//     `-1` collision suffix yields a dead predicted URL → callers must
//     fail loud and NOT write `publicBaseUrl`. The guard returns a typed
//     result (never throws an untyped error).
//
//   Write-vs-skip purity
//     The decision to write `publicBaseUrl` depends ONLY on
//     `(funnelUrl present)` AND `(hostname matches prediction)` — NEVER
//     on a reachability/cert-warmup probe. `shouldWritePublicBaseUrl`
//     takes a SINGLE object argument; that arity is the structural lock
//     (regression-guarded in the test) that a probe arg can never be
//     silently threaded in.
//
// `deriveDevTailscaleHostname` is the SINGLE source of truth for the
// predicted hostname — imported via the exact relative specifier
// `index.mjs` already resolves; this module NEVER re-derives it.
//
// Public surface:
//   - TailscaleProvisionError (typed, `.code`)
//   - extractTailscaleHostnameSegment(dnsNameOrUrl) → string ("" on bad input)
//   - verifyRegisteredHostnameMatchesPrediction({ registered, dbUrl, schema })
//   - shouldWritePublicBaseUrl({ funnelUrl, hostnameCheck })
// ---------------------------------------------------------------------------

// `deriveDevTailscaleHostname` (the single source of truth for the predicted
// hostname) lives in the gitignored `extensions/cinatra-ai/` clone-back target,
// ABSENT on a fresh checkout. It is loaded lazily inside
// `verifyRegisteredHostnameMatchesPrediction` so this module — and any host
// (CLI) module that statically imports it — resolves on an extension-empty
// checkout. By the time a provisioning caller invokes verify, `cinatra setup
// dev` has populated the extension.

/**
 * Errors returned (not thrown) by this module are tagged with `.code`
 * so callers can fail loud and map to UI without parsing strings.
 *
 * Mirrors the shape of `TailscaleApiError` in
 * `packages/connector-tailscale/src/tailscale-api.mjs` but is a SIBLING
 * type — we deliberately do NOT import from `index.mjs` (cycle) nor from
 * the connector (keep this leaf dependency-free apart from the pure
 * hostname-derivation single source of truth).
 *
 * Codes:
 *   - "tailscale.hostname_collision"  registered segment !== prediction
 *   - "tailscale.hostname_unresolved" registered DNSName couldn't be parsed
 */
export class TailscaleProvisionError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "TailscaleProvisionError";
    this.code = code;
  }
}

/**
 * Extract the Tailscale hostname label from a registered `Self.DNSName`
 * or a full Funnel URL.
 *
 * Normalisation:
 *   1. Coerce to string; strip a leading `https://` (or `http://`) scheme.
 *   2. Strip a single trailing `/`.
 *   3. Strip a single trailing `.` (MagicDNS FQDN trailing dot).
 *   4. The input MUST end in `.ts.net`. No `.ts.net` suffix → "".
 *   5. The shape is `<hostname>.<tailnet>.ts.net` where `<tailnet>` may
 *      itself contain dots (e.g. `acme.github` →
 *      `myhost.foo.ts.net`). There MUST be at least one hostname
 *      label AND a non-empty tailnet portion before `.ts.net`. The
 *      hostname is ONLY the first label (everything up to the first `.`).
 *      The tailnet remainder is NOT returned and NOT compared by callers.
 *   6. Any malformed / garbage / no-suffix / zero-label input → "" (NEVER
 *      throws). The caller's verify step converts "" into a typed
 *      `tailscale.hostname_unresolved` error → fail-loud, no write.
 *
 * @param {string | null | undefined} dnsNameOrUrl
 * @returns {string} hostname label, or "" when it cannot be resolved
 */
export function extractTailscaleHostnameSegment(dnsNameOrUrl) {
  let s = String(dnsNameOrUrl ?? "").trim();
  if (!s) return "";

  // 1. Strip scheme (https:// preferred; tolerate http://).
  s = s.replace(/^https?:\/\//i, "");
  // 2 + 3. Strip a single trailing slash, then a single trailing dot
  //        (order tolerates both `…ts.net/` and `…ts.net./`).
  s = s.replace(/\/+$/, "");
  s = s.replace(/\.+$/, "");
  if (!s) return "";

  // 4. Require the `.ts.net` tailnet TLD.
  const SUFFIX = ".ts.net";
  if (!s.toLowerCase().endsWith(SUFFIX)) return "";

  // 5. Everything before `.ts.net` is `<hostname>.<tailnet…>`. Require a
  //    non-empty hostname label AND a non-empty tailnet portion (so a
  //    bare `foo.ts.net` with zero tailnet labels is rejected).
  const beforeSuffix = s.slice(0, s.length - SUFFIX.length);
  if (!beforeSuffix) return "";

  const firstDot = beforeSuffix.indexOf(".");
  if (firstDot <= 0) return ""; // no hostname label, or no tailnet label
  const hostname = beforeSuffix.slice(0, firstDot);
  const tailnet = beforeSuffix.slice(firstDot + 1);
  if (!hostname || !tailnet) return "";

  return hostname;
}

/**
 * Collision guard. Compare the registered Tailscale hostname segment
 * against the deterministic prediction from the SINGLE source of truth
 * (`deriveDevTailscaleHostname`). Returns a typed result — NEVER throws.
 *
 *   - segment === prediction          → { ok: true, predicted, registered }
 *   - segment !== prediction          → { ok: false, predicted, registered,
 *                                          error: TailscaleProvisionError(
 *                                            "tailscale.hostname_collision") }
 *   - segment unresolved ("" parsed)  → { ok: false, predicted, registered:"",
 *                                          error: TailscaleProvisionError(
 *                                            "tailscale.hostname_unresolved") }
 *
 * `error` is ALWAYS a `TailscaleProvisionError` (has `.code`), never a
 * bare `Error`.
 *
 * @param {object} args
 * @param {string | null | undefined} args.registered  registered Self.DNSName
 *   (trailing-dot / `.ts.net` / full `https://` URL forms all accepted)
 * @param {string | null | undefined} args.dbUrl   SUPABASE_DB_URL
 * @param {string | null | undefined} args.schema  SUPABASE_SCHEMA
 * @returns {Promise<{ ok: boolean, predicted: string, registered: string,
 *             error?: TailscaleProvisionError }>}
 */
export async function verifyRegisteredHostnameMatchesPrediction({
  registered,
  dbUrl,
  schema,
}) {
  // Single source of truth — NEVER re-derive here. Discovered + loaded lazily
  // through the connector's `cinatra.devCliModules` manifest declaration
  // (cinatra#151 Stage 5c) so this module imports cleanly when the gitignored
  // connector source is absent and names no extension.
  const { loadDevCliModule } = await import("./dev-cli-modules.mjs");
  const { deriveDevTailscaleHostname } = await loadDevCliModule("tailscale-hostname");
  const predicted = deriveDevTailscaleHostname({ dbUrl, schema });
  const segment = extractTailscaleHostnameSegment(registered);

  if (!segment) {
    return {
      ok: false,
      predicted,
      registered: "",
      error: new TailscaleProvisionError(
        "tailscale.hostname_unresolved",
        `Could not resolve a Tailscale hostname from the registered ` +
          `node identity (expected "<hostname>.<tailnet>.ts.net"). ` +
          `Predicted hostname was "${predicted}". Refusing to write ` +
          `publicBaseUrl.`,
      ),
    };
  }

  if (segment !== predicted) {
    return {
      ok: false,
      predicted,
      registered: segment,
      error: new TailscaleProvisionError(
        "tailscale.hostname_collision",
        `Tailscale registered hostname "${segment}" does not match the ` +
          `predicted hostname "${predicted}" (likely a MagicDNS ` +
          `collision suffix). The predicted Funnel URL would be dead — ` +
          `refusing to write publicBaseUrl.`,
      ),
    };
  }

  return { ok: true, predicted, registered: segment };
}

/**
 * Write-vs-skip decision. Decides whether to write `publicBaseUrl`
 * purely from `(funnelUrl present)` AND `(hostnameCheck.ok === true)`.
 *
 * DECOUPLING INVARIANT — this function takes a SINGLE object argument
 * and DELIBERATELY accepts NO probe / reachability / cert-warmup
 * parameter. Its arity (`.length === 1`) is the reviewable structural
 * lock (regression-guarded in the test) that the write decision can
 * never be silently re-coupled to a reachability probe.
 *
 *   - funnelUrl truthy AND hostnameCheck.ok === true → true
 *   - funnelUrl falsy                                → false (always)
 *   - hostnameCheck missing / not ok                 → false (always)
 *
 * @param {object} args
 * @param {string | null | undefined} args.funnelUrl  derived Funnel URL
 * @param {{ ok?: boolean } | null | undefined} args.hostnameCheck
 *   result of verifyRegisteredHostnameMatchesPrediction
 * @returns {boolean}
 */
export function shouldWritePublicBaseUrl({ funnelUrl, hostnameCheck }) {
  if (!funnelUrl) return false;
  return hostnameCheck != null && hostnameCheck.ok === true;
}
