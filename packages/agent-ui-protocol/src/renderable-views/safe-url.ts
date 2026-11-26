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

/**
 * THE SOURCE-LINK RULE, mirrored (cinatra#3092). The canonical rule is
 * `safeHttpHref` in `src/lib/artifacts/artifact-service.ts`, which
 * `connectorRefSourceUrl` applies to every "Open in source application" address
 * before it becomes `ArtifactSummary.sourceUrl` and the display props'
 * `actions.openInSource`: an absolute `http:` or `https:` URL, returned as its
 * parsed `URL.href`; anything else (`javascript:`, `data:`, a relative path, an
 * empty or non-string value) is null. Mirrored here, not imported, because the
 * review card and the review island reach this module already and the artifact
 * service is a server module neither may load. A suite pins this function equal
 * to the canonical one over a table of cases
 * (`src/lib/artifacts/__tests__/source-link-href-parity-3092.test.ts`).
 */
export function sourceLinkHref(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href;
}
