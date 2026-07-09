// ---------------------------------------------------------------------------
// Scheme-allowlisting for renderable-view href/src values (cinatra#1220, S4).
//
// Renderable-view payloads arrive off the untrusted wire and their URL-bearing
// fields (artifact href, citation url) are LLM/tool-controlled. Sanitizing at
// the SCHEMA layer means every surface's renderer receives an already-safe
// value — the hostile-defense is not re-implemented per component. Mirrors the
// `safeHref` allowlist the markdown renderer applies (relative/internal paths,
// http(s), mailto only; javascript:, data:, protocol-relative and control-char
// masked schemes dropped).
// ---------------------------------------------------------------------------

// Deliberately strip control chars (masking a dangerous scheme, e.g. `java\0script:`).
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * Return `url` when it uses an allowed scheme (or is a relative/internal path),
 * otherwise `undefined`. A dropped URL is rendered as inert text by the view
 * component rather than an active link.
 */
export function safeUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  // Strip control chars used to mask a dangerous scheme (e.g. `java\0script:`).
  const cleaned = url.replace(CONTROL_CHARS, "").trim();
  if (cleaned.length === 0) return undefined;

  // A backslash has no legitimate use in an http(s)/mailto/relative web URL, but
  // WHATWG URL parsing normalizes `\` to `/` — so `\\evil`, `/\evil`, `\/evil`
  // are all protocol-relative equivalents that smuggle a cross-origin authority.
  // Reject any backslash outright (simpler and strictly safer than normalizing).
  if (cleaned.includes("\\")) return undefined;

  // Protocol-relative (`//evil.example`) is dropped — the surface's origin is
  // ambiguous and it can smuggle a cross-origin navigation.
  if (cleaned.startsWith("//")) return undefined;

  // A relative or internal absolute path (no scheme) is safe.
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  if (!schemeMatch) return cleaned;

  const scheme = schemeMatch[1].toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto") {
    return cleaned;
  }
  return undefined;
}
