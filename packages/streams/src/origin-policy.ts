// ---------------------------------------------------------------------------
// The ONE origin resolver: "is this string a CONCRETE site origin — a real
// place that may be stored, compared byte-for-byte, and written into a browser
// policy?"
//
// WHY IT EXISTS. `new URL()` is a PARSER, not a validator. It accepts a host
// that is a SHAPE rather than a place: an asterisk is a legal URL host
// character, and a percent-escape inside the host is DECODED during parsing, so
// a percent-encoded asterisk arrives as a literal one. `url.origin` then hands
// back a serialized origin that still carries the asterisk. Any code that read
// "the URL parser accepted it" as "this is a real site" inherited that gap —
// and a value of that shape is a WILDCARD the moment it reaches a
// `frame-ancestors` directive, plus a silent equality trap everywhere origins
// are compared.
//
// WHAT "CONCRETE" MEANS HERE, exactly:
//   - the scheme is `http:` or `https:` — nothing else has a framing meaning;
//   - the HOST carries no asterisk, in any spelling: literal, percent-encoded,
//     or one of the Unicode forms the parser folds to `*`. Checked against the
//     authority as WRITTEN and again against the host as PARSED, because the
//     parser both decodes escapes and folds look-alikes. An asterisk in a path
//     or a query is NOT a refusal — those components are discarded with the
//     rest of the URL and say nothing about which site this is;
//   - there is no username and no password (userinfo is not part of an origin
//     and is a spoofing surface in anything that displays it);
//   - the serialized origin is not the opaque `"null"`;
//   - the HOST is a place: either an IPv6 literal (the URL parser has already
//     canonicalized it, brackets included) or a DNS-shaped name whose every
//     label is a real label — 1..63 characters, alphanumeric at both ends, no
//     empty label, and the whole name at most 253 characters. Unicode never
//     reaches this check: the parser has already punycoded it, so an
//     internationalized domain arrives as its `xn--` ASCII form and passes on
//     its merits.
//
// The resolver is PURE and dependency-free ON PURPOSE, and it lives in the
// neutral package so the generic token broker, the host's widget broker, the
// site-registration validator and the embed framing wall can all reach the SAME
// verdict from the SAME code. A second copy of "what is an origin" is precisely
// how two walls came to disagree; there is one copy, and this is it.
// ---------------------------------------------------------------------------

/** Why a candidate is not a concrete origin. Stable, machine-readable. */
export type OriginRefusal =
  | "empty"
  | "wildcard"
  | "unparsable"
  | "unsupported-scheme"
  | "credentials"
  | "opaque"
  | "non-registrable-host";

/** The verdict: the canonical origin, or the refusal plus a caller-showable reason. */
export type OriginResolution =
  | { ok: true; origin: string }
  | { ok: false; refusal: OriginRefusal; message: string };

/**
 * A caller-showable sentence per refusal. Deliberately says what is WANTED, not
 * what was sent — a validation message that echoes the rejected value back into
 * a UI or a log is its own small hazard.
 */
const REFUSAL_MESSAGES: Record<OriginRefusal, string> = {
  empty: "Enter the website address.",
  wildcard:
    "Enter one exact website address. An address with an asterisk stands for many sites and is never accepted.",
  unparsable: "Enter a full website address, for example https://example.com.",
  "unsupported-scheme": "Use an http:// or https:// address.",
  credentials: "Remove the user name and password from the address.",
  opaque: "Enter a full website address, for example https://example.com.",
  "non-registrable-host": "Enter a real host name, for example https://example.com.",
};

/**
 * An asterisk in ANY form: literal, or percent-encoded (which the parser
 * decodes), or a Unicode look-alike (which the parser FOLDS to a literal one —
 * `＊` U+FF0A and `﹡` U+FE61 both arrive as `*`). Matching the decoded host is
 * therefore the check that actually catches them; matching the authority as
 * written catches an escape before any decoding step.
 */
const WILDCARD_SHAPE = /\*|%2a/i;

/** An IPv6 literal as the URL parser serializes it into `hostname` — brackets kept. */
const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/;

/**
 * One DNS label: alphanumeric or underscore at both ends, hyphen allowed only
 * INSIDE. A leading or trailing hyphen is the punycode/IDN hazard and is
 * refused; an underscore is neither ambiguous nor a policy metacharacter, and
 * internal host names do use it, so it is accepted anywhere in the label.
 */
const DNS_LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/;

const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/**
 * The authority (`host[:port]`, plus any userinfo) exactly as the caller WROTE
 * it — before the parser decodes percent-escapes. Everything from the first
 * `/`, `?` or `#` onwards is a path/query/fragment and is not part of the
 * origin, so it is cut away here rather than judged.
 */
function rawAuthority(candidate: string): string {
  const afterScheme = candidate.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  // A backslash separates the path too, for the schemes this resolver accepts.
  const end = afterScheme.search(/[/?#\\]/);
  return end === -1 ? afterScheme : afterScheme.slice(0, end);
}

/** Is the parsed host a concrete place (IPv6 literal, IPv4 literal, or DNS name)? */
function isConcreteHost(hostname: string): boolean {
  if (!hostname || hostname.length > MAX_HOST_LENGTH) return false;
  if (WILDCARD_SHAPE.test(hostname)) return false;
  // An IPv6 literal. The WHATWG serializer keeps the brackets in `hostname`,
  // but the unbracketed form is accepted too so the check does not hinge on
  // that serialization detail.
  if (hostname.includes(":") || hostname.startsWith("[") || hostname.endsWith("]")) {
    return IPV6_LITERAL.test(hostname) || IPV6_LITERAL.test(`[${hostname}]`);
  }
  // A single trailing dot (the DNS root, "example.com.") is a real spelling of
  // a real host and is ACCEPTED — kept exactly as written, never folded away.
  // A page actually served from the dotted address sends the dotted origin, so
  // rewriting it here would break the byte-equality every comparison relies on,
  // and refusing it would disable a registration that works today. It is a
  // DIFFERENT origin from the dotless spelling, and every check downstream
  // treats it as one.
  const withoutRootDot = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (!withoutRootDot) return false;
  const labels = withoutRootDot.split(".");
  return labels.every(
    (label) => label.length > 0 && label.length <= MAX_LABEL_LENGTH && DNS_LABEL.test(label),
  );
}

/**
 * Resolve a candidate to its canonical `scheme://host[:port]` origin, or refuse
 * it with a reason. The ONE place that answers the question; every other origin
 * check in the codebase is expected to route through this.
 */
export function resolveConcreteOrigin(value: unknown): OriginResolution {
  const refuse = (refusal: OriginRefusal): OriginResolution => ({
    ok: false,
    refusal,
    message: REFUSAL_MESSAGES[refusal],
  });

  const trimmed = String(value ?? "").trim();
  if (!trimmed) return refuse("empty");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // A bare `*` is not parsable as a URL at all. Name it for what it is rather
    // than as generic garbage — the person who typed it needs to hear that a
    // pattern is the wrong KIND of answer, not that they made a typo.
    return refuse(WILDCARD_SHAPE.test(trimmed) ? "wildcard" : "unparsable");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return refuse("unsupported-scheme");
  if (url.username || url.password) return refuse("credentials");
  if (!url.origin || url.origin === "null") return refuse("opaque");
  // The HOST, twice: as written (an escape before any decoding) and as parsed
  // (an escape the parser decoded, or a Unicode look-alike it folded).
  if (WILDCARD_SHAPE.test(rawAuthority(trimmed)) || WILDCARD_SHAPE.test(url.hostname)) {
    return refuse("wildcard");
  }
  if (!isConcreteHost(url.hostname)) return refuse("non-registrable-host");

  return { ok: true, origin: url.origin };
}

/**
 * The canonical origin, or `""` when the candidate is not a concrete origin.
 * The string-returning shape callers that only ever branch on "did I get an
 * origin?" want.
 */
export function normalizeConcreteOrigin(value: unknown): string {
  const resolved = resolveConcreteOrigin(value);
  return resolved.ok ? resolved.origin : "";
}

/** True only for a value that IS already a canonical, concrete origin. */
export function isConcreteOrigin(value: unknown): boolean {
  const resolved = resolveConcreteOrigin(value);
  return resolved.ok && resolved.origin === String(value ?? "").trim();
}
