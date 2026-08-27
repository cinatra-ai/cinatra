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

/**
 * Known credential prefixes — flagged regardless of entropy.
 *
 * ORDER IS THE REPORTED ANSWER (cinatra#1378 review item 13): the first match
 * wins and its name is the only thing the author can act on, so the MORE
 * SPECIFIC prefix comes first. `sk-ant-…` is also a valid `sk-…`, and telling
 * an author their Anthropic key is an OpenAI key sends them to the wrong file.
 */
const KNOWN_PREFIX_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "anthropic-key", re: /^sk-ant-[A-Za-z0-9_-]{16,}$/ },
  { name: "openai-sk", re: /^sk-[A-Za-z0-9_-]{16,}$/ },
  { name: "github-pat", re: /^(gho|ghp|gha|ghs|ghr)_[A-Za-z0-9]{20,}$/ },
  { name: "google-oauth", re: /^ya29\.[A-Za-z0-9_-]{20,}$/ },
  { name: "slack-token", re: /^(xoxb|xoxp|xoxa|xoxr|xoxs)-[A-Za-z0-9-]{16,}$/ },
  { name: "aws-access-key", re: /^(AKIA|ASIA)[A-Z0-9]{12,}$/ },
];

/**
 * Documentation shapes that must not be flagged, or the gate trains bypasses.
 *
 * ANCHORED, and applied PER TOKEN (cinatra#1378 review item 1). The earlier
 * shape tested these against the whole trimmed value and returned "no finding"
 * for the ENTIRE string on a match. Two of the patterns were unanchored, and a
 * concept body is scanned as one value — so a single `${VAR}` or `<VAR>`
 * anywhere in a file switched the scan off for the whole file. Tolerance
 * belongs to the TOKEN that is a placeholder, never to its neighbours.
 *
 * There is no whole-value branch any more and none is needed: the token
 * splitter consumes `{}`, `<>` and the URL punctuation, so a value that IS a
 * placeholder arrives here as a single token and matches on its own. A
 * placeholder WRAPPER (`{{ … }}`) therefore no longer launders its contents —
 * the inner token is scanned in its own right.
 */
const PLACEHOLDER_TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  /^\$\{[A-Z0-9_]+\}$/,
  /^\$[A-Z0-9_]+$/,
  /^<[A-Z0-9_]+>$/,
  /^\{\{[A-Z0-9_. -]+\}\}$/,
  /^\*+$/,
  /^REDACTED$/i,
];

/**
 * Placeholder WORDS. Matched as a whole token or as a delimited word inside
 * one (cinatra#1378 review item 6) — never as a bare substring. A
 * credential-shaped token with `example` spliced into its middle is a
 * credential, not documentation, and substring matching turned that into a
 * one-word bypass anyone could find.
 */
const PLACEHOLDER_WORDS: ReadonlySet<string> = new Set([
  "example",
  "redacted",
  "placeholder",
]);

/** Word delimiters inside a single token, for the placeholder-word test. */
const WORD_SPLIT_RE = /[-_.]+/;

/**
 * Opaque-token entropy, ALPHABET-AWARE (cinatra#1378 review item 5).
 *
 * The previous rule was "Shannon entropy >= 4.5 bits per character". Shannon
 * entropy over a 16-symbol alphabet is bounded by log2(16) = 4.0, so that
 * branch was STRUCTURALLY UNREACHABLE for any hex string of any length — a
 * hex-encoded key rode through no matter how long it was.
 *
 * The rule here scores a token against the alphabet it is actually drawn from:
 *
 *   score = H(token) / min(log2(|charset class|), log2(token length))
 *
 * The second term is what makes short tokens comparable: a 24-character string
 * cannot exceed log2(24) bits per character however wide its alphabet is, so
 * dividing by the class size alone would systematically under-score exactly the
 * tokens most worth reading. A score near 1.0 means "as unpredictable as this
 * charset and this length allow", which is what an opaque credential looks like
 * and what an identifier, a path, or prose does not.
 *
 * The threshold and the digit+letter requirement below were calibrated against
 * this repository's own token corpus (every tracked file under packages/memory,
 * packages/objects and docs): at 0.85 the ONLY tokens that flag are hex digests
 * — zero identifiers, zero paths, zero prose — while random keys are caught at
 * 93% (32 hex chars), 100% (64 hex chars) and 96-98% (24-43 base64url chars).
 *
 * DELIBERATELY OUT OF SCOPE, so the comment does not read as broader than the
 * code (cinatra#1378 review item 5):
 *   - A HEX DIGEST IS FLAGGED. A sha256 digest and a hex API key are the same
 *     shape and nothing in the string separates them, so this gate resolves the
 *     ambiguity in the fail-closed direction. The envelope's OWN digest is not
 *     a false positive: `externalId` and `bundleId` are excluded from the scan
 *     BY NAME as identity fields. A digest an author writes into a body IS
 *     flagged, and the refusal names the shape and the location so they can act.
 *   - A token shorter than 24 characters is not entropy-scored at all. Short
 *     credentials are covered by the prefix list, not by this branch.
 *   - Standard base64 (`+` and `/`) is not a charset class here: the token
 *     splitter consumes `/`, so such a token arrives already broken up.
 *   - A credential with no digit or no letter is not entropy-scored (see
 *     `hasDigitAndLetter`): that requirement is what keeps camelCase
 *     identifiers out, and the probability a random 32-character key lacks a
 *     digit is under half a percent.
 */
const ENTROPY_MIN_LENGTH = 24;
const ENTROPY_THRESHOLD = 0.85;

/**
 * Charset classes an opaque credential is drawn from, most specific first.
 * The number is the class's symbol count, which is the entropy ceiling per
 * character before the length ceiling is applied.
 */
const ENTROPY_CHARSET_CLASSES: ReadonlyArray<{ re: RegExp; size: number }> = [
  { re: /^[0-9a-f]+$/, size: 16 },
  { re: /^[0-9A-F]+$/, size: 16 },
  { re: /^[A-Z2-7]+$/, size: 32 },
  { re: /^[A-Za-z0-9_-]+$/, size: 64 },
];

/**
 * A PEM private-key block. No entropy rule reaches this: the armour is
 * readable ASCII and the base64 payload is split across newlines.
 */
const PEM_PRIVATE_KEY_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;

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

/**
 * Normalized, alphabet-aware entropy score for one token, or null when the
 * token is not drawn from any recognized credential charset.
 */
function normalizedEntropyScore(token: string): number | null {
  const klass = ENTROPY_CHARSET_CLASSES.find((c) => c.re.test(token));
  if (klass === undefined) return null;
  const ceiling = Math.min(Math.log2(klass.size), Math.log2(token.length));
  if (ceiling <= 0) return null;
  return computeShannonEntropy(token) / ceiling;
}

/** Both a digit and a letter — see the out-of-scope note above. */
function hasDigitAndLetter(token: string): boolean {
  return /[0-9]/.test(token) && /[A-Za-z]/.test(token);
}

/** Is this token an opaque credential by the alphabet-aware entropy rule? */
function isHighEntropyToken(token: string): boolean {
  if (token.length < ENTROPY_MIN_LENGTH) return false;
  if (!hasDigitAndLetter(token)) return false;
  const score = normalizedEntropyScore(token);
  return score !== null && score >= ENTROPY_THRESHOLD;
}

/**
 * A token with its placeholder WORDS removed.
 *
 * `example-<32 opaque chars>` is not documentation with a credential-shaped
 * name; it is a credential with a documentation word glued on. Stripping the
 * word is what lets the caller ask the honest question — "is what REMAINS
 * credential-shaped?" — instead of taking the word's presence as an answer.
 */
/**
 * A contiguous STANDARD-base64 run (`+` and `/` in the alphabet).
 *
 * The token splitter consumes `/`, so a standard-base64 credential arrives at
 * the token loop already broken into fragments too short to score — an AWS
 * secret access key is the everyday example. This runs on the WHOLE value
 * before splitting and scores the run as one token.
 *
 * Narrow on purpose. The run must actually CONTAIN a `+` or a `/`, because a
 * run without either is plain alphanumeric and the token loop already scores it
 * well; it must carry a digit and a letter, which is what keeps a
 * slash-separated PATH out; and it must clear the same normalized threshold.
 * Measured over every tracked file in this repository, that combination selects
 * 20 runs, all of them base64-encoded binary (inline SVG data URIs and test key
 * material) and none of them concept prose.
 *
 * The numbers, measured through the WHOLE detector rather than this rule alone,
 * because the two branches cover each other: a 40-character standard-base64 key
 * is caught 97.6% of the time (70.2% by this rule, 27.4% by the token loop —
 * roughly 28% of such keys happen to contain neither `+` nor `/`, and those are
 * exactly the ones the token loop sees intact). At 44 characters it is 96.8%.
 * Coverage falls to 83.6% at 64 characters, where the length ceiling starts to
 * bite: a longer run needs proportionally more entropy to clear 0.85. Those are
 * the honest measured numbers, not a claim that the shape is fully covered.
 */
const STANDARD_BASE64_RUN_RE = /[A-Za-z0-9+/]{32,}/g;

function STANDARD_BASE64_RUN_REHit(value: string): boolean {
  for (const run of value.match(STANDARD_BASE64_RUN_RE) ?? []) {
    if (!/[+/]/.test(run)) continue;
    if (!/[0-9]/.test(run) || !/[A-Za-z]/.test(run)) continue;
    const ceiling = Math.min(Math.log2(64), Math.log2(run.length));
    if (ceiling > 0 && computeShannonEntropy(run) / ceiling >= ENTROPY_THRESHOLD) return true;
  }
  return false;
}

function isPlaceholderTokenResidue(token: string): string {
  return token
    .split(WORD_SPLIT_RE)
    .filter((part) => !PLACEHOLDER_WORDS.has(part.toLowerCase()))
    .join("");
}

/**
 * Is this token documentation rather than a credential?
 *
 * A placeholder WORD skips the token only when what remains after removing it
 * is too short to be a credential. Matching the word alone — as a bare
 * substring, and equally as a delimited word — is a one-word bypass anyone can
 * find: `<12 opaque chars>-example-<17 opaque chars>` is a 38-character
 * high-entropy token that the word switched the detector off for. `sk-EXAMPLE`
 * leaves `sk`, and `token.example.placeholder-value` leaves `tokenvalue`; both
 * stay skipped, which is the tolerance that keeps the gate believed.
 */
function isPlaceholderToken(token: string): boolean {
  if (PLACEHOLDER_TOKEN_PATTERNS.some((re) => re.test(token))) return true;
  const lower = token.toLowerCase();
  if (PLACEHOLDER_WORDS.has(lower)) return true;
  const parts = lower.split(WORD_SPLIT_RE);
  if (!parts.some((word) => PLACEHOLDER_WORDS.has(word))) return false;
  return isPlaceholderTokenResidue(token).length < ENTROPY_MIN_LENGTH;
}

/**
 * A credential carried in a URL's userinfo: a scheme, then `user:password`, then `@host`.
 *
 * Scanned on the WHOLE value before token splitting, because the splitter
 * consumes `:` and `/` and would take the pair apart. Parsed procedurally
 * rather than with a regex: the value is untrusted concept content, and a
 * pattern with two adjacent unbounded runs is a reachable denial of service.
 *
 * A placeholder password (an env-var reference in the password position of a
 * connection URL) is documentation and is tolerated, exactly like every other
 * placeholder token.
 */
function matchUrlUserinfoCredential(value: string): boolean {
  let from = 0;
  for (;;) {
    const marker = value.indexOf("://", from);
    if (marker === -1) return false;
    from = marker + 3;
    // Scheme must be a plain scheme immediately before the marker.
    let schemeStart = marker;
    while (schemeStart > 0 && /[A-Za-z0-9+.-]/.test(value[schemeStart - 1] ?? "")) {
      schemeStart -= 1;
    }
    if (schemeStart === marker) continue;
    // Userinfo runs from the marker to the first `@`, and must not cross a
    // path separator, whitespace, or the start of another authority.
    let i = from;
    let colon = -1;
    while (i < value.length) {
      const ch = value[i] ?? "";
      if (ch === "@") break;
      if (ch === "/" || ch === "?" || ch === "#" || /\s/.test(ch)) break;
      if (ch === ":" && colon === -1) colon = i;
      i += 1;
    }
    if (i >= value.length || value[i] !== "@") continue;
    if (colon === -1) continue; // user@host carries no password
    const password = value.slice(colon + 1, i);
    if (password === "" || isPlaceholderToken(password)) continue;
    return true;
  }
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

  // Shapes that survive token splitting only as a whole: checked first, on the
  // WHOLE value. Neither is reachable by an entropy rule (item 5).
  if (PEM_PRIVATE_KEY_RE.test(value)) return "pem-private-key";
  if (matchUrlUserinfoCredential(value)) return "url-credential";
  if (STANDARD_BASE64_RUN_REHit(value)) return "standard-base64-token";

  const jwt = matchJwtShape(value);
  if (jwt !== null && !isPlaceholderToken(jwt)) return "jwt";

  const bearer = /^\s*Bearer\s+(\S+)\s*$/i.exec(value);
  if (bearer) {
    const inner = bearer[1] ?? "";
    if (isPlaceholderToken(inner)) return null;
    return detectMemoryCredentialPattern(inner);
  }

  // Per-token from here down. There is deliberately NO whole-value placeholder
  // short-circuit (item 1): tolerance applies to the token that IS a
  // placeholder and to nothing else in the value.
  for (const token of value.split(TOKEN_SPLIT_RE)) {
    if (token.length === 0) continue;
    for (const { name, re } of KNOWN_PREFIX_PATTERNS) {
      if (re.test(token)) return name;
    }
    if (isPlaceholderToken(token)) continue;
    if (isHighEntropyToken(token)) return "high-entropy-token";
    // A token that survived the placeholder check because its residue is long
    // is scored on that RESIDUE too: the glued-on documentation word dilutes
    // the whole token's entropy, which is the other half of the same bypass.
    const residue = isPlaceholderTokenResidue(token);
    if (residue !== token && isHighEntropyToken(residue)) return "high-entropy-token";
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
