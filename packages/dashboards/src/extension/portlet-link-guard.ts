// Portlet LINK / URL validation (cinatra#1628, S11c / AC4).
//
// AC4 requires "link validation" on the declarative portlet-contribution path: an
// extension-shipped `cinatra/dashboard.json` (or any write) must not smuggle a
// dangerous URL into a portlet config that a render component could later turn
// into a live `href`/`src`. The core bundled kinds deliberately carry NO link
// field (the entity-summary items are label/value only — see `kinds.ts`), but the
// portlet `config` blob is an opaque `Record<string, unknown>`, an extension may
// alias a kind whose component DOES render a link, and future kinds may add link
// fields — so this is the fail-closed floor: at install/write time, EVERY string
// value under a URL-bearing key (anywhere in the config tree) must be a SAFE URL.
//
// SAFE = relative / same-page / protocol-relative, or an `http|https|mailto|tel`
// scheme. UNSAFE = any other scheme, notably `javascript:` / `data:` / `vbscript:`
// / `blob:` / `file:` — the classic stored-XSS and local-file vectors. Detection
// MIRRORS browser URL normalization (tab/newline/CR are stripped anywhere, leading
// C0/space is ignored) so an obfuscated `java<TAB>script:` cannot slip through.
//
// PURE — no store, no I/O. Wired into `assertConfigV12` (the single write/install
// validator) so it covers extension materialize AND every operator/agent write.

import type { PortletConfigError } from "../portlets/registry";

/** Schemes a portlet URL may use. Everything else (incl. javascript:/data:/
 *  vbscript:/blob:/file:) is rejected fail-closed. */
export const SAFE_PORTLET_URL_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/** Config KEYS that carry a URL and therefore get the STRICT allowlist check. A
 *  key is URL-bearing when a url-word is the WHOLE key, follows a `.`/`_`
 *  separator (`icon_url`, `logo.href`), is a camelCase suffix (`imageUrl`,
 *  `iconHref`), or is any of those pluralized (`links`, `urls`). A word that
 *  merely CONTAINS the letters (`curl`, `source`, `redaction`) is NOT url-bearing.
 *  This is only the STRICT-allowlist trigger; the dangerous-scheme DENYLIST below
 *  runs on EVERY string regardless of key, so an unexpected/mislabeled key can
 *  never smuggle a `javascript:`/`data:` value past the guard. */
const URL_WORD =
  "href|url|uri|src|link|redirect|action|to|destination|website|image|icon|logo|avatar|thumbnail|poster|callback|webhook|endpoint";
// Anchored / separator form, case-insensitive, optional trailing plural `s`
// (href, URL, icon_url, logo.href, links, urls).
const URL_KEY_SEP_RE = new RegExp(`(^|[._])(${URL_WORD})s?$`, "i");
// camelCase form, case-SENSITIVE (imageUrl, iconHref, linkTo) — the capital first
// letter is the signal, so `curl`/`source` (lowercase) never match.
const URL_KEY_CAMEL_RE = new RegExp(`[a-z](${URL_WORD.replace(/\b(\w)/g, (m) => m.toUpperCase())})s?$`);

/** True iff `key` names a URL-bearing config field (STRICT-allowlist trigger). */
export function isUrlBearingKey(key: string): boolean {
  return URL_KEY_SEP_RE.test(key) || URL_KEY_CAMEL_RE.test(key);
}

/**
 * The classic script/exfil schemes that must NEVER be the scheme of ANY string
 * value, regardless of the key name (defence-in-depth against a mislabeled link
 * field the key heuristic would miss). `javascript:`/`vbscript:`/`blob:` are
 * matched UNCONDITIONALLY — leading whitespace after the colon is still valid,
 * executable JavaScript (`javascript: alert(1)`), and these prefixes never appear
 * as legitimate prose. `data:` requires a non-space payload so ordinary labels
 * ("Data: 42 rows") are not a false positive, while a real `data:text/html,…`
 * URI (no space after the colon) is always caught. Any `data:` under an actual
 * URL-bearing key is additionally caught by the strict allowlist layer.
 */
const DANGEROUS_SCHEME_RE = /^(?:javascript|vbscript|blob):|^data:[^ ]/i;

/** True iff `raw` uses a known-dangerous scheme (after browser-style
 *  normalization) — flagged under ANY key. */
export function hasDangerousScheme(raw: string): boolean {
  return DANGEROUS_SCHEME_RE.test(normalizeForSchemeCheck(raw));
}

/** Strip the chars a browser removes from a URL before scheme resolution (TAB,
 *  LF, CR anywhere) + leading C0/space, then compare the scheme case-insensitively. */
function normalizeForSchemeCheck(raw: string): string {
  return raw.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+/, "");
}

/**
 * True iff `raw` is a SAFE portlet URL. Empty, relative (`/`, `./`, `../`),
 * same-page (`#...`), query (`?...`), and protocol-relative (`//host`) URLs are
 * safe (no script surface); a value with an explicit scheme is safe only when the
 * scheme is allowlisted. Fail-closed on an unknown scheme.
 */
export function isSafePortletUrl(raw: string): boolean {
  const s = normalizeForSchemeCheck(raw);
  if (s.length === 0) return true;
  const first = s[0];
  if (first === "/" || first === "#" || first === "?" || first === ".") return true;
  // A scheme is the token before the FIRST ":" when it matches the scheme grammar
  // AND precedes any path separator. Anchored at start so no separator precedes it.
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
  if (!m) return true; // no scheme so a relative reference
  return SAFE_PORTLET_URL_SCHEMES.has(m[1].toLowerCase());
}

/** The scheme token of `raw` (lowercased) for a diagnostic, or `"<none>"`. */
function schemeOf(raw: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(normalizeForSchemeCheck(raw));
  return m ? m[1].toLowerCase() : "<none>";
}

/**
 * Walk an arbitrary config value and collect every UNSAFE URL, path-qualified.
 * Recurses objects + arrays; only a string under a URL-bearing KEY is checked
 * (an array element inherits the parent key's URL-bearing-ness so
 * `config.links[0]` is checked when `links` is URL-bearing).
 */
function collectUnsafeUrls(
  value: unknown,
  path: string,
  keyIsUrlBearing: boolean,
  out: { path: string; scheme: string }[],
): void {
  if (typeof value === "string") {
    // Layer 1: a definite URL field must pass the strict allowlist.
    // Layer 2: ANY string using a known-dangerous scheme is rejected, even under
    // an unexpected key (closes the key-name-heuristic bypass).
    if ((keyIsUrlBearing && !isSafePortletUrl(value)) || hasDangerousScheme(value)) {
      out.push({ path, scheme: schemeOf(value) });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((el, i) => collectUnsafeUrls(el, `${path}[${i}]`, keyIsUrlBearing, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectUnsafeUrls(v, path ? `${path}.${k}` : k, isUrlBearingKey(k), out);
    }
  }
}

/** A portlet instance shape the guard inspects (config + inputs). */
export type PortletForLinkValidation = {
  readonly instanceId?: string;
  readonly config?: unknown;
  readonly inputs?: unknown;
};

/**
 * Validate one portlet's config (+ input bindings) for unsafe URLs. Returns []
 * when clean. The error `code` is stable (`portlet_unsafe_url`) for callers that
 * branch on it.
 */
export function validatePortletLinks(portlet: PortletForLinkValidation): PortletConfigError[] {
  const found: { path: string; scheme: string }[] = [];
  collectUnsafeUrls(portlet.config ?? {}, "config", false, found);
  collectUnsafeUrls(portlet.inputs ?? {}, "inputs", false, found);
  return found.map((f) => ({
    code: "portlet_unsafe_url",
    message: `${f.path} is not a safe URL (scheme "${f.scheme}" is not allowed; use http/https/mailto/tel or a relative URL)`,
  }));
}

/** A dashboard config with portlets to scan (the persisted/materialized shape). */
export type DashboardConfigForLinkValidation = {
  readonly portlets?: readonly PortletForLinkValidation[];
};

/**
 * Validate EVERY portlet in a dashboard config for unsafe URLs. Returns a flat
 * list of human-readable errors (prefixed with the portlet instanceId), [] when
 * clean — the caller (`assertConfigV12`) throws a config-invalid error fail-closed
 * when non-empty.
 */
export function collectUnsafeDashboardLinks(config: DashboardConfigForLinkValidation): string[] {
  const errors: string[] = [];
  for (const p of config.portlets ?? []) {
    for (const e of validatePortletLinks(p)) {
      errors.push(`portlet "${p.instanceId ?? "?"}": ${e.message}`);
    }
  }
  return errors;
}
