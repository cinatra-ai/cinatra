/**
 * Local, fail-closed credential scan over a memory concept.
 *
 * A memory bundle is written by coding agents into a repository, so a concept
 * file is exactly the kind of place an API key ends up by accident. Sync
 * refuses to upload a concept that carries a credential-shaped literal.
 *
 * This scan is ADVISORY. It exists so the author gets a diagnostic naming the
 * file BEFORE anything leaves the machine (the issue's "rejected with a local
 * diagnostic, not stored"). The authoritative gate is the server's own scan on
 * the ingest path — a bundle is untrusted input, so the client's checks can
 * never be the thing that decides. Both are fail-closed: a scan that cannot
 * complete refuses the concept rather than passing it through unscanned.
 *
 * The detector shape (known credential prefixes, JWT shape, Shannon entropy
 * over opaque tokens, placeholder tolerance) mirrors the org's existing
 * `detectCredentialPattern`. It is re-implemented here rather than imported:
 * this package is a pure filesystem leaf (node builtins + `yaml` only) and
 * pulling `@cinatra-ai/agents` in for one function would end that.
 */
import {
  type MemoryConcept,
  type MemorySyncDiagnostic,
} from "./types.ts";

/** The scan could not complete. Callers MUST treat this as a refusal. */
export class MemorySecretScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemorySecretScanError";
  }
}

/** Known credential prefixes — flagged regardless of entropy. */
const KNOWN_PREFIX_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "openai-sk", re: /^sk-[A-Za-z0-9_-]{16,}$/ },
  { name: "github-pat", re: /^(gho|ghp|gha|ghs|ghr)_[A-Za-z0-9]{20,}$/ },
  { name: "google-oauth", re: /^ya29\.[A-Za-z0-9_-]{20,}$/ },
  { name: "slack-token", re: /^(xoxb|xoxp|xoxa|xoxr|xoxs)-[A-Za-z0-9-]{16,}$/ },
  { name: "aws-access-key", re: /^(AKIA|ASIA)[A-Z0-9]{12,}$/ },
  { name: "anthropic-key", re: /^sk-ant-[A-Za-z0-9_-]{16,}$/ },
];

/**
 * Placeholder shapes that short-circuit a value to "no finding". A concept
 * file DOCUMENTING how to set a key is the common case; flagging it would
 * make the gate useless and train authors to bypass it.
 */
const PLACEHOLDER_PATTERNS: ReadonlyArray<RegExp> = [
  /^\s*\{\{[\s\S]*\}\}\s*$/,
  /\$\{[A-Z0-9_]+\}/,
  /^\$[A-Z0-9_]+$/,
  /<[A-Z0-9_]+>/,
  /^\s*\*+\s*$/,
  /^\s*REDACTED\s*$/i,
];

const PLACEHOLDER_SUBSTRINGS = ["example", "redacted", "placeholder"];

const ENTROPY_MIN_LENGTH = 24;
const ENTROPY_THRESHOLD = 4.5;
/**
 * Token splitter.
 *
 * URL punctuation (`/ ? = & #`) is in the set alongside whitespace and JSON
 * punctuation, because the common way a credential reaches a concept file is
 * inside a URL — `https://host/hook?token=<the key>`. Without those
 * separators the whole URL is one long token: it matches no anchored prefix
 * pattern, and its entropy is diluted by the readable host and path, so a real
 * key rides through. Splitting finer also makes the ENTROPY branch quieter
 * (shorter tokens), which is the right direction for a gate whose value
 * depends on being believed rather than routed around.
 */
const TOKEN_SPLIT_RE = /[\s,;:|()\[\]<>{}"'`/?=&#]+/;

/** Anchored (linear) base64url segment test — no backtracking on hostile input. */
const JWT_FULL_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const JWT_LEADING_SEGMENT_RE = /^[A-Za-z0-9_-]+/;

/**
 * Bounds that make the scan itself fail-closed rather than unbounded.
 *
 * Frontmatter is arbitrary author-supplied YAML, so it can nest and fan out as
 * far as the parser allows. A scan that quietly stopped walking at some depth
 * would report "clean" over content it never looked at — the exact false
 * negative this gate exists to prevent. Exceeding a bound therefore THROWS,
 * and every caller turns a throw into a refusal.
 */
const MAX_SCAN_DEPTH = 32;
const MAX_SCAN_VALUES = 20_000;

function computeShannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  return PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed));
}

function isPlaceholderToken(token: string): boolean {
  if (PLACEHOLDER_PATTERNS.some((re) => re.test(token))) return true;
  const lower = token.toLowerCase();
  return PLACEHOLDER_SUBSTRINGS.some((sub) => lower.includes(sub));
}

/**
 * Returns the matched JWT-shaped substring, or null.
 *
 * Linear single pass (split on `.`, check consecutive triples) rather than an
 * unanchored regex with unbounded `+` runs: concept bodies are untrusted, and
 * the regex form is polynomial on input like `"eyJ".repeat(n)`.
 */
function matchJwtShape(value: string): string | null {
  if (!value.includes("eyJ")) return null;
  const parts = value.split(".");
  for (let i = 0; i + 2 < parts.length; i++) {
    const head = parts[i] ?? "";
    const headerIdx = head.indexOf("eyJ");
    if (headerIdx === -1) continue;
    const seg0 = head.slice(headerIdx);
    if (seg0.length < 4 || !JWT_FULL_SEGMENT_RE.test(seg0)) continue;
    const seg1 = parts[i + 1] ?? "";
    if (seg1.length < 4 || !seg1.startsWith("eyJ") || !JWT_FULL_SEGMENT_RE.test(seg1)) {
      continue;
    }
    const tail = (parts[i + 2] ?? "").match(JWT_LEADING_SEGMENT_RE);
    if (tail === null) continue;
    return `${seg0}.${seg1}.${tail[0]}`;
  }
  return null;
}

/**
 * Inspect one string and return a credential-pattern LABEL, or null.
 *
 * The label names the SHAPE that matched, never the matched text: a
 * diagnostic that echoed the secret would copy it into terminal scrollback,
 * CI logs and, eventually, another memory concept.
 */
export function detectMemoryCredentialPattern(value: string): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (isPlaceholderValue(value)) return null;

  const jwt = matchJwtShape(value);
  if (jwt !== null && !isPlaceholderToken(jwt)) return "jwt";

  const bearer = /^\s*Bearer\s+(\S+)\s*$/i.exec(value);
  if (bearer) {
    const inner = bearer[1] ?? "";
    if (isPlaceholderToken(inner)) return null;
    return detectMemoryCredentialPattern(inner);
  }

  for (const token of value.split(TOKEN_SPLIT_RE)) {
    if (token.length === 0) continue;
    for (const { name, re } of KNOWN_PREFIX_PATTERNS) {
      if (re.test(token)) return name;
    }
    if (isPlaceholderToken(token)) continue;
    if (token.length >= ENTROPY_MIN_LENGTH) {
      if (computeShannonEntropy(token) >= ENTROPY_THRESHOLD) {
        return "high-entropy-token";
      }
    }
  }
  return null;
}

/**
 * Object keys a location string may echo verbatim: short, ordinary identifier
 * shapes. Anything else is rendered positionally.
 */
const SAFE_KEY_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;

/**
 * Render one object key as a location segment WITHOUT echoing it unless it is
 * obviously safe to.
 *
 * A location ends up inside a diagnostic, and a diagnostic ends up in terminal
 * scrollback and CI logs. An object KEY is author-controlled text exactly like
 * a value, so `{ "<a real token>": "note" }` would otherwise copy the
 * credential into the very message that promises to name only the shape. A key
 * is echoed only when it is a short ordinary identifier that the detector
 * itself does not flag; everything else is positional.
 */
function locationSegment(key: string, index: number): string {
  if (!SAFE_KEY_RE.test(key)) return `[key#${index}]`;
  try {
    return detectMemoryCredentialPattern(key) === null ? key : `[key#${index}]`;
  } catch {
    return `[key#${index}]`;
  }
}

/**
 * Collect every scannable string out of an arbitrary parsed value — object
 * VALUES and object KEYS alike, each with an echo-safe location.
 *
 * THROWS {@link MemorySecretScanError} when the value exceeds the walk bounds.
 * Every caller converts that throw into a refusal — a scan that could not see
 * the whole payload has not cleared it.
 */
export function collectMemoryScannableStrings(
  value: unknown,
  label: string,
): Array<{ location: string; value: string }> {
  const out: Array<{ location: string; value: string }> = [];
  const seen = new Set<object>();
  const walk = (node: unknown, location: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) {
      throw new MemorySecretScanError(
        `secret scan aborted at ${location}: nesting deeper than ${MAX_SCAN_DEPTH} levels`,
      );
    }
    if (out.length > MAX_SCAN_VALUES) {
      throw new MemorySecretScanError(
        `secret scan aborted at ${location}: more than ${MAX_SCAN_VALUES} scannable values`,
      );
    }
    if (typeof node === "string") {
      out.push({ location, value: node });
      return;
    }
    if (node === null || typeof node !== "object") return;
    // A cycle would otherwise spin until the value cap trips; naming it is a
    // clearer refusal than "too many values".
    if (seen.has(node as object)) {
      throw new MemorySecretScanError(
        `secret scan aborted at ${location}: the value is cyclic`,
      );
    }
    seen.add(node as object);
    if (Array.isArray(node)) {
      node.forEach((entry, i) => walk(entry, `${location}[${i}]`, depth + 1));
      return;
    }
    Object.entries(node as Record<string, unknown>).forEach(([key, entry], i) => {
      const segment = locationSegment(key, i);
      // The KEY is author-controlled text too. `{ "<a real token>": "note" }`
      // hides a credential exactly as well as a value does, so every key is
      // collected as a value in its own right at its own (echo-safe) location.
      out.push({ location: `${location}.${segment}`, value: key });
      walk(entry, `${location}.${segment}`, depth + 1);
    });
  };
  walk(value, label, 0);
  return out;
}

/**
 * Scan one concept. Returns a diagnostic per credential-shaped hit; an empty
 * array means the concept is clear.
 *
 * A scan that cannot complete produces a `secret-scan-failed` diagnostic
 * instead of an empty array, so "could not scan" and "found nothing" never
 * look alike to a caller.
 */
export function scanMemoryConceptForSecrets(
  concept: Pick<MemoryConcept, "path" | "frontmatter" | "body">,
): MemorySyncDiagnostic[] {
  let values: Array<{ location: string; value: string }>;
  try {
    values = [
      ...collectMemoryScannableStrings(concept.frontmatter, "frontmatter"),
      { location: "body", value: concept.body },
    ];
  } catch (error) {
    return [
      {
        severity: "error",
        code: "secret-scan-failed",
        path: concept.path,
        message:
          error instanceof MemorySecretScanError
            ? error.message
            : `secret scan failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
  const diagnostics: MemorySyncDiagnostic[] = [];
  for (const { location, value } of values) {
    let label: string | null;
    try {
      label = detectMemoryCredentialPattern(value);
    } catch (error) {
      return [
        {
          severity: "error",
          code: "secret-scan-failed",
          path: concept.path,
          message: `secret scan failed at ${location}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ];
    }
    if (label !== null) {
      diagnostics.push({
        severity: "error",
        code: "secret-detected",
        path: concept.path,
        // Shape and location only — never the matched text.
        message: `credential-shaped literal (${label}) at ${location}; the concept was not uploaded`,
      });
    }
  }
  return diagnostics;
}
