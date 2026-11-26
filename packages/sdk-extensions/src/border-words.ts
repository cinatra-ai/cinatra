// The border words an extension declares (cinatra#4848).
//
// WHAT IT IS. `cinatra.borderWords` in an extension's own manifest names the
// words that are this extension's own: its vendor or product words (`vendor`,
// e.g. the name of the service a connector talks to) and its domain words
// (`domain`, e.g. the kind of work an agent does). Core's two border checks
// (scripts/audit/vendor-token-core-gate.mjs and class 2 of
// scripts/audit/application-border-gate.mjs) read the union of these words
// over the pinned extensions and refuse a core module path or import
// specifier that carries one. The checks name no word: the words live WITH
// the extension, exactly like `vendor` and `displayName`.
//
// SHAPE.
//   "borderWords": { "vendor": ["acme"], "domain": ["ticket"] }
//   "borderWords": { "vendor": [], "domain": [], "reason": "<why this pack owns no word>" }
// Both lists are required. A pack whose two lists are both empty must say why
// in `reason` (a non-empty string); a pack that declares a word carries no
// `reason`. No other key is allowed.
//
// EACH WORD is one lower-case token (BORDER_WORD_PATTERN: letters and digits,
// at least two characters), because the checks split a path into such tokens
// and could never match a word with a hyphen or a capital. A word is not a
// kind word (BORDER_WORD_RESERVED_WORDS: what every extension is, never what
// one extension owns), not a host port name (HOST_PORT_NAMES, lower-cased:
// core owns those roads), not repeated, and not in both lists.
//
// ADOPTION. The key is additive (the `consumes` precedent, cinatra#804: absent
// means "not yet adopted"). Core's checks report a pinned pack without the
// declaration as a warning only while the shrink-only `packages` list of the
// temporary bridge (scripts/audit/border-words-bridge.json) names it, and as a
// failure otherwise: a newly pinned or renamed pack, or one that dropped its
// declaration, must declare. The checks run in bare `node` and read the two
// constants below from this file's TEXT (the conformance-rules idiom), never a
// re-listed copy.

import { HOST_PORT_NAMES } from "./host-context";

/** The manifest key under `cinatra`. */
export const BORDER_WORDS_KEY = "borderWords";

/** One border word: a single lower-case token of letters and digits, at least two characters. */
export const BORDER_WORD_PATTERN = "^[a-z0-9]{2,}$";

/** Words no extension may declare: what every extension is, never what one extension owns. */
export const BORDER_WORD_RESERVED_WORDS = [
  "agent",
  "agents",
  "artifact",
  "artifacts",
  "cinatra",
  "connector",
  "connectors",
  "extension",
  "extensions",
  "skill",
  "skills",
] as const;

/** The declaration under `cinatra.borderWords`. */
export type BorderWordsDeclaration = {
  /** This extension's own vendor or product words. */
  vendor: string[];
  /** This extension's own domain words. */
  domain: string[];
  /** Why a pack whose two lists are empty owns no word; absent otherwise. */
  reason?: string;
};

const LIST_KEYS = ["vendor", "domain"] as const;
const ALLOWED_KEYS = new Set<string>([...LIST_KEYS, "reason"]);

/**
 * Every problem of a `cinatra.borderWords` value, as readable lines; an empty
 * array means the declaration is valid. `undefined` (the key is absent) is
 * reported as one problem: the caller decides whether absence is a warning or
 * a failure.
 */
export function borderWordsIssues(raw: unknown): string[] {
  if (raw === undefined) return ["cinatra.borderWords is absent"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return ["cinatra.borderWords must be an object { vendor: string[], domain: string[], reason?: string }"];
  }
  const decl = raw as Record<string, unknown>;
  const issues: string[] = [];
  for (const key of Object.keys(decl)) {
    if (!ALLOWED_KEYS.has(key)) issues.push(`cinatra.borderWords has an unknown key "${key}"`);
  }
  const pattern = new RegExp(BORDER_WORD_PATTERN);
  const reserved = new Set<string>(BORDER_WORD_RESERVED_WORDS);
  const ports = new Set<string>(HOST_PORT_NAMES.map((p) => p.toLowerCase()));
  const seen = new Map<string, string>();
  let total = 0;
  for (const list of LIST_KEYS) {
    const words = decl[list];
    if (!Array.isArray(words)) {
      issues.push(`cinatra.borderWords.${list} must be an array of words`);
      continue;
    }
    for (const word of words) {
      total += 1;
      if (typeof word !== "string" || !pattern.test(word)) {
        issues.push(`cinatra.borderWords.${list}: ${JSON.stringify(word)} is not one lower-case token (${BORDER_WORD_PATTERN})`);
        continue;
      }
      if (reserved.has(word)) issues.push(`cinatra.borderWords.${list}: "${word}" is a kind word every extension shares`);
      if (ports.has(word)) issues.push(`cinatra.borderWords.${list}: "${word}" is a host port name`);
      const before = seen.get(word);
      if (before === list) issues.push(`cinatra.borderWords.${list}: "${word}" is repeated`);
      else if (before) issues.push(`cinatra.borderWords: "${word}" is in both vendor and domain`);
      seen.set(word, list);
    }
  }
  const reason = decl.reason;
  if (reason !== undefined && (typeof reason !== "string" || reason.trim() === "")) {
    issues.push("cinatra.borderWords.reason must be a non-empty string");
  } else if (total === 0 && reason === undefined && Array.isArray(decl.vendor) && Array.isArray(decl.domain)) {
    issues.push("cinatra.borderWords declares no word: say why in cinatra.borderWords.reason");
  } else if (total > 0 && reason !== undefined) {
    issues.push("cinatra.borderWords.reason is only for a pack that declares no word");
  }
  return issues;
}
