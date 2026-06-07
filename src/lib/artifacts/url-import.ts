import "server-only";

// ---------------------------------------------------------------------------
// URL → readable markdown helper for the "Add URL" library import path.
// Pure, dependency-injectable (fetch + DNS resolver are accepted as opts
// for testability). Does NOT touch the DB / blob store — that's the caller's job
// (`importArtifactFromUrl` in `library-import-actions.ts`).
//
// Security and robustness requirements:
//   1. SSRF protection — block localhost / private / link-local IPs
//      before issuing fetch + re-check after every redirect; reject
//      userinfo in URL.
//   2. Manual redirect handling — `redirect: "manual"`, max 5 hops,
//      validate each target's hostname/IP.
//   3. Streaming body size cap — abort at 5 MB so cheerio doesn't
//      parse a runaway response.
//   4. Empty-content rejection — JS-rendered SPAs return tiny / empty
//      cleaned text; refuse rather than ship a useless artifact.
//   5. Output is `text/markdown` (normalized) so matchers that filter
//      on markdown still classify it.
// ---------------------------------------------------------------------------

import { lookup as dnsLookupCallback } from "node:dns";
import { lookup as dnsLookupPromise } from "node:dns/promises";
import { isIP } from "node:net";
// The npm `undici` Agent is version-matched ONLY with the npm `undici`
// `fetch`, NOT with Node's bundled `globalThis.fetch` (different undici
// major). Import BOTH from the same package so the dispatcher is accepted.
import { Agent, fetch as undiciFetch } from "undici";
import * as cheerio from "cheerio";
// Reuse the battle-tested CIDR-based SSRF classifier instead of a parallel
// hand-rolled one. `validateAddress(ip, family)` returns TRUE when the
// address is publicly routable (safe), FALSE when it's in any blocked range
// (loopback / RFC1918 / CGNAT / link-local / 6to4 / NAT64 / docs /
// IPv4-mapped-IPv6 / etc. — full BigInt CIDR match).
import {
  validateAddress,
  stripBrackets,
} from "@/app/api/llm-bridge/_url-validation";

// Loose alias for cheerio's domhandler node shape. We don't pull
// `domhandler` directly — it's a transitive dep, not declared.
type CheerioLikeNode = {
  type?: string;
  name?: string;
  data?: string;
  children?: CheerioLikeNode[];
};

export const URL_IMPORT_MAX_RAW_BYTES = 5 * 1024 * 1024; // 5 MiB
const MAX_REDIRECTS = 5;
/** Minimum cleaned-text length to count as a real page. A SPA shell
 *  typically produces <500 chars of body text. */
const MIN_READABLE_BODY_CHARS = 200;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "cinatra/url-import (+https://cinatra.ai; admin-only library import)";

export type UrlImportError = {
  ok: false;
  reason:
    | "invalid-url"
    | "userinfo-not-allowed"
    | "private-ip-blocked"
    | "dns-failed"
    | "redirect-loop"
    | "too-many-redirects"
    | "bad-status"
    | "content-too-large"
    | "fetch-failed"
    | "fetch-timeout"
    | "no-readable-content"
    | "unsupported-content-type";
  message: string;
  /** Final URL the redirect chain settled on (for diagnostics). */
  finalUrl?: string;
};

export type UrlImportSuccess = {
  ok: true;
  /** Final URL after redirects (may differ from input). */
  finalUrl: string;
  /** Page title (from `<title>` or first `<h1>`), used as artifact title. */
  title: string;
  /** Normalized markdown rendering of the page body. */
  markdown: string;
  /** Raw byte count of the fetched HTML (post-redirect, pre-normalize). */
  rawBytes: number;
};

export type UrlImportResult = UrlImportSuccess | UrlImportError;

/** Test-time dependency injection. Production callers pass nothing
 *  and get the default global fetch + node:dns/promises.lookup.
 *
 *  NEVER exposed as a server-action parameter; letting an external request
 *  override `maxRawBytes` / `fetchTimeoutMs` / `maxRedirects` would let any
 *  authenticated user weaken the resource caps. The server action calls
 *  `fetchUrlAsMarkdown` / `importArtifactFromUrlService` without deps;
 *  tests import the helpers DIRECTLY with deps. */
export type UrlImportDeps = {
  fetch?: typeof globalThis.fetch;
  dnsLookup?: (host: string) => Promise<{ address: string; family: 4 | 6 }>;
  /** All-records DNS lookup, used by the undici Agent's connect-time
   *  validator. Defaults to `node:dns.lookup` with `{ all: true }`.
   *  Tests inject a fake to simulate multi-record DNS or rebinding. */
  dnsLookupAll?: (host: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  /** Override the redirect cap (tests). */
  maxRedirects?: number;
  /** Override the body cap (tests). */
  maxRawBytes?: number;
  /** Override the fetch timeout (tests). */
  fetchTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Connect-time SSRF enforcement.
//
// The preflight DNS check is necessary but not sufficient — between
// the preflight and the actual fetch socket open, the DNS resolution
// can return a DIFFERENT address (DNS rebinding, low-TTL records).
// To close the TOCTOU, we provide an undici `Agent` whose `connect`
// option carries a custom `lookup` that re-validates the resolved
// address(es) AT CONNECT TIME. Any private/loopback/link-local
// resolution returned by the connect-time DNS aborts the connection
// before the socket is opened.
//
// `fetch` accepts a `dispatcher` option (undici-style); we pass our
// safe-Agent so the body-fetch path goes through this validator.
// ---------------------------------------------------------------------------

function buildSsrfSafeAgent(deps: UrlImportDeps): Agent {
  return new Agent({
    connect: {
      // Cast away the strict undici/Agent LookupFunction signature —
      // we don't use the `options` arg + we always treat `all: true`
      // internally to validate every record. The function shape
      // matches at runtime (`(hostname, options, callback) => void`).
      lookup: ((hostname: string, _options: unknown, callback: (err: Error | null, address?: string, family?: number) => void) => {
        // Always resolve ALL records and validate every one — partial
        // public + partial private is treated as private (worst-case).
        const lookup = deps.dnsLookupAll
          ? deps.dnsLookupAll(hostname).then((r) => r).catch((e) => {
              throw e;
            })
          : new Promise<Array<{ address: string; family: 4 | 6 }>>(
              (resolve, reject) => {
                dnsLookupCallback(
                  hostname,
                  { all: true },
                  (err, addresses) => {
                    if (err) return reject(err);
                    resolve(
                      (addresses as Array<{ address: string; family: number }>).map((a) => ({
                        address: a.address,
                        family: a.family as 4 | 6,
                      })),
                    );
                  },
                );
              },
            );
        lookup.then(
          (addrs) => {
            if (addrs.length === 0) {
              callback(
                Object.assign(new Error(`DNS returned no addresses for ${hostname}`), {
                  code: "EAI_NODATA",
                }),
              );
              return;
            }
            for (const a of addrs) {
              const reason = classifyPrivateIp(a.address);
              if (reason) {
                callback(
                  Object.assign(
                    new Error(
                      `SSRF connect-time block: ${hostname} resolved to ${reason} address ${a.address}`,
                    ),
                    { code: "SSRF_BLOCKED" },
                  ),
                );
                return;
              }
            }
            // Pass the first vetted address back.
            callback(null, addrs[0].address, addrs[0].family);
          },
          (err: Error) => {
            callback(
              Object.assign(err, { code: (err as NodeJS.ErrnoException).code ?? "EAI_FAIL" }),
            );
          },
        );
      }) as unknown as Agent.Options["connect"] extends { lookup?: infer L } ? L : never,
    },
  });
}

// ---------------------------------------------------------------------------
// IP-block predicate. Thin wrapper over the shared, CIDR-accurate
// `validateAddress` from `_url-validation.ts`. Reuse the proven classifier
// rather than maintaining a parallel one. The shared validator covers the full
// RFC6890 + NAT64 + 6to4 + IPv4-mapped-IPv6 + IPv6 special ranges via BigInt
// CIDR matching.
//
// Return shape kept as `"blocked" | null` so the rest of url-import
// (which only branches on truthiness for the UX message) is unchanged.
// ---------------------------------------------------------------------------

export type PrivateIpReason = "blocked";

export function classifyPrivateIp(address: string): PrivateIpReason | null {
  const family = isIP(address);
  if (family !== 4 && family !== 6) {
    // Not a literal IP — caller resolves first, then re-checks.
    return null;
  }
  // validateAddress returns TRUE = publicly routable (safe).
  return validateAddress(address, family as 4 | 6) ? null : "blocked";
}

// ---------------------------------------------------------------------------
// URL parse + SSRF gate. Returns a normalized URL object or a typed
// rejection. Caller chains this BEFORE every fetch attempt (initial
// + each redirect).
// ---------------------------------------------------------------------------

export type ValidatedUrl = {
  parsed: URL;
  /** Resolved IP. Set when DNS was performed; absent when the
   *  hostname is already a literal IP. */
  resolvedAddress?: string;
  resolvedFamily?: 4 | 6;
};

export type ValidateUrlError = {
  ok: false;
  reason:
    | "invalid-url"
    | "userinfo-not-allowed"
    | "private-ip-blocked"
    | "dns-failed";
  message: string;
};

export async function validateAndResolveUrl(
  raw: string,
  deps: UrlImportDeps = {},
): Promise<{ ok: true; value: ValidatedUrl } | { ok: false; error: ValidateUrlError }> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      ok: false,
      error: {
        ok: false,
        reason: "invalid-url" as const,
        message: `URL is malformed: "${raw}"`,
      },
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error: {
        ok: false,
        reason: "invalid-url" as const,
        message: `Only http:// and https:// URLs are accepted (got ${parsed.protocol})`,
      },
    };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      error: {
        ok: false,
        reason: "userinfo-not-allowed" as const,
        message: "URLs with embedded credentials (user:pass@) are not allowed.",
      },
    };
  }

  // If the hostname is already a literal IP, check it directly.
  // Node's URL parser preserves brackets around IPv6 literals
  // (`http://[::1]/` → hostname `"[::1]"`); strip them so
  // classifyPrivateIp sees the raw address.
  const hostnameForCheck = stripBrackets(parsed.hostname);
  const literalCheck = classifyPrivateIp(hostnameForCheck);
  if (literalCheck) {
    return {
      ok: false,
      error: {
        ok: false,
        reason: "private-ip-blocked" as const,
        message: `URL hostname is a ${literalCheck} address (${hostnameForCheck}) — SSRF blocked.`,
      },
    };
  }

  // DNS lookup to verify the hostname does NOT resolve to a private/
  // loopback/link-local address. Tests inject `deps.dnsLookup`.
  const resolver = deps.dnsLookup ?? defaultDnsLookup;
  let resolved: { address: string; family: 4 | 6 };
  try {
    resolved = await resolver(parsed.hostname);
  } catch (err) {
    return {
      ok: false,
      error: {
        ok: false,
        reason: "dns-failed" as const,
        message: `DNS lookup failed for ${parsed.hostname}: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  const resolvedCheck = classifyPrivateIp(resolved.address);
  if (resolvedCheck) {
    return {
      ok: false,
      error: {
        ok: false,
        reason: "private-ip-blocked" as const,
        message: `Hostname ${parsed.hostname} resolved to a ${resolvedCheck} address (${resolved.address}) — SSRF blocked.`,
      },
    };
  }
  return {
    ok: true,
    value: { parsed, resolvedAddress: resolved.address, resolvedFamily: resolved.family },
  };
}

async function defaultDnsLookup(
  host: string,
): Promise<{ address: string; family: 4 | 6 }> {
  const r = await dnsLookupPromise(host);
  return { address: r.address, family: r.family as 4 | 6 };
}

// ---------------------------------------------------------------------------
// fetchUrlAsMarkdown — the public surface. Walks the redirect chain
// manually (re-validating each hop), streams the body with a cap,
// parses with cheerio, normalizes to markdown, returns success or a
// typed rejection.
// ---------------------------------------------------------------------------

export async function fetchUrlAsMarkdown(
  rawUrl: string,
  deps: UrlImportDeps = {},
): Promise<UrlImportResult> {
  // Use the npm `undici` fetch (NOT Node's bundled `globalThis.fetch`) so it's
  // version-matched with the npm `undici` `Agent` dispatcher. A test-injected
  // `deps.fetch` skips the dispatcher entirely (no socket to validate).
  const fetchImpl = (deps.fetch ??
    (undiciFetch as unknown as typeof globalThis.fetch));
  const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS;
  const maxRawBytes = deps.maxRawBytes ?? URL_IMPORT_MAX_RAW_BYTES;
  const timeoutMs = deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  // Connect-time SSRF enforcement. Only attach the dispatcher when using the
  // REAL undici fetch; a test-injected fetch doesn't accept `dispatcher`.
  const usingRealFetch = !deps.fetch;
  const dispatcher = usingRealFetch ? buildSsrfSafeAgent(deps) : undefined;

  let currentUrl = rawUrl;
  const seenUrls = new Set<string>();
  let lastResponseBody: string | null = null;
  let lastRawBytes = 0;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await validateAndResolveUrl(currentUrl, deps);
    if (!validated.ok) return validated.error;

    const normalized = validated.value.parsed.toString();
    if (seenUrls.has(normalized)) {
      return {
        ok: false,
        reason: "redirect-loop",
        message: `Redirect loop detected at ${normalized}`,
        finalUrl: normalized,
      };
    }
    seenUrls.add(normalized);

    let response: Response;
    try {
      response = await fetchImpl(normalized, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        // Cheap defense-in-depth: omit any cookies / credentials. Node's fetch
        // has no browser cookie jar but explicit is better.
        credentials: "omit",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        },
        // Connect-time SSRF enforcement via undici Agent with a custom DNS
        // lookup that validates the resolved address(es) at the socket-open
        // step. Closes the TOCTOU between the preflight DNS check and the
        // actual fetch.
        ...(dispatcher
          ? // The dispatcher option is typed for undici's RequestInit.
            // Node 24's fetch accepts it but TS RequestInit may not
            // include it — cast at the call site.
            ({ dispatcher } as unknown as { dispatcher: typeof dispatcher })
          : {}),
      });
    } catch (err) {
      // Surface SSRF connect-time blocks as a typed rejection, not a generic
      // fetch-failed.
      const errCode = err instanceof Error && "cause" in err
        ? (err as { cause?: { code?: string } }).cause?.code
        : undefined;
      if (
        errCode === "SSRF_BLOCKED" ||
        (err instanceof Error && /SSRF connect-time block/.test(err.message))
      ) {
        return {
          ok: false,
          reason: "private-ip-blocked",
          message: `Connect-time SSRF block at ${normalized}: ${err instanceof Error ? err.message : String(err)}`,
          finalUrl: normalized,
        };
      }
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      return {
        ok: false,
        reason: isTimeout ? "fetch-timeout" : "fetch-failed",
        message: `Fetch failed for ${normalized}: ${err instanceof Error ? err.message : String(err)}`,
        finalUrl: normalized,
      };
    }

    // 3xx — follow manually with re-validation.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return {
          ok: false,
          reason: "bad-status",
          message: `Redirect (status ${response.status}) without Location header at ${normalized}`,
          finalUrl: normalized,
        };
      }
      // Resolve relative redirects against the current URL.
      try {
        currentUrl = new URL(location, normalized).toString();
      } catch {
        return {
          ok: false,
          reason: "invalid-url",
          message: `Redirect Location header has invalid URL: "${location}"`,
          finalUrl: normalized,
        };
      }
      continue;
    }

    if (!response.ok) {
      return {
        ok: false,
        reason: "bad-status",
        message: `HTTP ${response.status} ${response.statusText} from ${normalized}`,
        finalUrl: normalized,
      };
    }

    // Content-Type gate — accept text/* and application/xhtml+xml.
    const contentType = (response.headers.get("content-type") ?? "")
      .toLowerCase()
      .split(";")[0]
      .trim();
    const supported =
      contentType === "" ||
      contentType.startsWith("text/") ||
      contentType === "application/xhtml+xml" ||
      contentType === "application/xml";
    if (!supported) {
      return {
        ok: false,
        reason: "unsupported-content-type",
        message: `Unsupported Content-Type "${contentType}" from ${normalized}; only text/* + xhtml are accepted.`,
        finalUrl: normalized,
      };
    }

    // Content-Length early reject.
    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader) {
      const declaredLen = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declaredLen) && declaredLen > maxRawBytes) {
        return {
          ok: false,
          reason: "content-too-large",
          message: `Declared Content-Length ${declaredLen} exceeds ${maxRawBytes}-byte cap`,
          finalUrl: normalized,
        };
      }
    }

    // Streaming body read with cap.
    const bodyRead = await readBodyWithCap(response, maxRawBytes);
    if (!bodyRead.ok) return { ...bodyRead.error, finalUrl: normalized };
    lastResponseBody = bodyRead.body;
    lastRawBytes = bodyRead.bytes;

    // Normalize → markdown.
    const normalized2 = normalizeHtmlToMarkdown(lastResponseBody);
    if (normalized2.cleanedTextChars < MIN_READABLE_BODY_CHARS) {
      return {
        ok: false,
        reason: "no-readable-content",
        message: `Page at ${normalized} contains less than ${MIN_READABLE_BODY_CHARS} characters of readable text (likely JS-rendered SPA, paywall, or empty).`,
        finalUrl: normalized,
      };
    }
    return {
      ok: true,
      finalUrl: normalized,
      title: normalized2.title,
      markdown: normalized2.markdown,
      rawBytes: lastRawBytes,
    };
  }

  // Loop fell through without returning — exceeded redirect cap.
  return {
    ok: false,
    reason: "too-many-redirects",
    message: `Exceeded redirect cap (${maxRedirects})`,
    finalUrl: currentUrl,
  };
}

// ---------------------------------------------------------------------------
// Stream the response body with a hard byte cap. AbortController-
// based; reading stops as soon as the cap is exceeded.
// ---------------------------------------------------------------------------

async function readBodyWithCap(
  response: Response,
  cap: number,
): Promise<
  | { ok: true; body: string; bytes: number }
  | { ok: false; error: Omit<UrlImportError, "finalUrl"> }
> {
  if (!response.body) {
    return { ok: true, body: "", bytes: 0 };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > cap) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return {
          ok: false,
          error: {
            ok: false,
            reason: "content-too-large",
            message: `Response body exceeds ${cap}-byte cap (read ${bytes} bytes before abort)`,
          },
        };
      }
      chunks.push(value);
    }
  } catch (err) {
    return {
      ok: false,
      error: {
        ok: false,
        reason: "fetch-failed",
        message: `Body read failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  // Concatenate into one Uint8Array then decode as UTF-8.
  const total = new Uint8Array(bytes);
  let off = 0;
  for (const c of chunks) {
    total.set(c, off);
    off += c.byteLength;
  }
  const body = new TextDecoder("utf-8", { fatal: false }).decode(total);
  return { ok: true, body, bytes };
}

// ---------------------------------------------------------------------------
// HTML → Markdown normalizer (minimal, cheerio-based). Walks the DOM
// and emits a markdown subset: H1-H6, paragraphs, links, lists,
// inline emphasis, code blocks. Drops scripts / styles / nav /
// header / footer / svg / form / iframe / aside.
//
// Not a faithful renderer; goal is "enough text content for the
// matcher to classify, plus a recognizable title and headings."
// ---------------------------------------------------------------------------

const STRIP_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "svg",
  "canvas",
  "form",
  "header",
  "footer",
  "nav",
  "aside",
];

type CheerioNode = CheerioLikeNode;

function normalizeHtmlToMarkdown(
  html: string,
): { title: string; markdown: string; cleanedTextChars: number } {
  const $ = cheerio.load(html);
  for (const sel of STRIP_SELECTORS) {
    $(sel).remove();
  }
  // Title: <title> > first <h1> > fallback "Untitled".
  const rawTitle = ($("title").first().text() || $("h1").first().text() || "")
    .replace(/\s+/g, " ")
    .trim();
  const title = rawTitle || "Untitled";

  // Find the most-content-y root for the body walk. Prefer <main>,
  // then <article>, then <body>.
  let root = $("main").first();
  if (root.length === 0) root = $("article").first();
  if (root.length === 0) root = $("body");
  const rootNode = root.get(0) ?? $.root().get(0);

  const parts: string[] = [`# ${title}`, ""];
  if (rootNode) walkNode(rootNode as CheerioNode, $, parts, 0);

  const markdown = parts
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // collapse runs of blank lines
    .trim();
  // Count cleaned text chars (excluding the markdown title line) for
  // the SPA-shell check.
  const cleanedTextChars = markdown.replace(/^# .*\n+/, "").trim().length;
  return { title, markdown, cleanedTextChars };
}

function walkNode(
  node: CheerioNode | null | undefined,
  $: cheerio.CheerioAPI,
  out: string[],
  depth: number,
): void {
  if (!node) return;
  // Use loose typing inside the walker; the entry-point arg is
  // properly typed.
  const n = node as unknown as {
    type?: string;
    name?: string;
    data?: string;
    children?: CheerioNode[];
  };
  if (n.type === "text") {
    const t = (n.data ?? "").replace(/\s+/g, " ");
    if (t.trim().length > 0) {
      out.push(t.trim());
    }
    return;
  }
  if (n.type !== "tag" && n.type !== "root") {
    return;
  }
  const tag = (n.name ?? "").toLowerCase();
  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Number.parseInt(tag.slice(1), 10);
      const text = collectText(node, $).trim();
      if (text) out.push("", "#".repeat(level) + " " + text, "");
      return;
    }
    case "p": {
      const text = collectText(node, $).trim();
      if (text) out.push("", text, "");
      return;
    }
    case "ul":
    case "ol": {
      out.push("");
      $(node as never)
        .children("li")
        .each((idx, li) => {
          const text = collectText(li as CheerioNode, $).trim();
          if (!text) return;
          const prefix = tag === "ol" ? `${idx + 1}. ` : "- ";
          out.push(prefix + text);
        });
      out.push("");
      return;
    }
    case "blockquote": {
      const text = collectText(node, $).trim();
      if (text) {
        out.push(
          "",
          text
            .split("\n")
            .map((l) => "> " + l)
            .join("\n"),
          "",
        );
      }
      return;
    }
    case "pre":
    case "code": {
      const text = (n.children ?? [])
        .map((c) => collectText(c, $))
        .join("");
      if (text.trim()) {
        out.push("", "```", text.trim(), "```", "");
      }
      return;
    }
    case "hr":
      out.push("", "---", "");
      return;
    case "br":
      out.push("");
      return;
    case "a": {
      const href = $(node as never).attr("href") ?? "";
      const text = collectText(node, $).trim();
      if (href && text) {
        out.push(`[${text}](${href})`);
      } else if (text) {
        out.push(text);
      }
      return;
    }
    case "img": {
      const alt = $(node as never).attr("alt") ?? "";
      const src = $(node as never).attr("src") ?? "";
      if (src) out.push(`![${alt}](${src})`);
      return;
    }
    default: {
      // Recurse into children for unknown / container tags.
      if (depth > 100) return; // pathological-nesting cutoff
      for (const child of n.children ?? []) {
        walkNode(child, $, out, depth + 1);
      }
    }
  }
}

function collectText(node: CheerioNode, $: cheerio.CheerioAPI): string {
  const t = $(node as never).text();
  return t.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Streaming helper for createSemanticArtifact callers.
// ---------------------------------------------------------------------------

export async function* asUtf8Stream(
  s: string,
): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(s);
}

// Test-only exports
export const __test = {
  classifyPrivateIp,
  normalizeHtmlToMarkdown,
  readBodyWithCap,
};
