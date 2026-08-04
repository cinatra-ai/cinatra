// -----------------------------------------------------------------------------
// Instance namespace auto-derivation.
//
// Client-safe, pure normalizer that turns a free-form display name into a
// namespace CANDIDATE for the /setup/name wizard step's live auto-fill. This
// is a SUGGESTION only — the format regex in ./validator.ts remains the single
// target and the single validation authority; a derived candidate that is
// still empty, too short, or otherwise invalid falls through to the normal
// inline validation UI exactly like a value the operator typed by hand.
//
// Consumed by the setup wizard client island
// (src/app/setup/name/instance-namespace-input.tsx), which links the
// namespace field to the display name field on every keystroke until the
// operator's first manual edit of the namespace field itself, then detaches
// the link permanently for the rest of that page's session.
// -----------------------------------------------------------------------------

import { RESERVED_SUBSTRINGS } from "./reserved-patterns";

// Mirrors the validator's format bounds (NAMESPACE_FORMAT_REGEX_SOURCE =
// "^[a-z0-9][a-z0-9-]{1,38}$"). Not re-exported/re-tested against the regex
// here — validator.ts stays the single owner of the format rule itself; this
// module only aims its OUTPUT at that target.
const MAX_LEN = 39;
const MIN_LEN = 2;

// Unicode combining marks. After NFKD decomposition an accented character
// like "é" becomes "e" plus a trailing combining acute accent (U+0301, in the
// common Combining Diacritical Marks block, U+0300-U+036F); stripCombiningMarks
// drops ANY combining mark — not just that one block — so the fold below sees
// a plain "e", not a leftover mark that would otherwise fall through to the
// punctuation-collapse step as a stray hyphen. `\p{M}` is the Unicode
// General_Category "Mark" (Mn + Mc + Me), which also covers marks outside the
// common block (e.g. Combining Diacritical Marks Extended, U+1AB0-U+1AFF) that
// a fixed U+0300-U+036F range would miss. Requires the `u` flag; supported by
// every deployment target this module ships to (Node.js and evergreen
// browsers have supported Unicode property escapes since ES2018).
function stripCombiningMarks(input: string): string {
  return input.replace(/\p{M}/gu, "");
}

function trimHyphens(value: string): string {
  return value.replace(/^-+|-+$/g, "");
}

/**
 * Derive a namespace candidate from a free-form display name.
 *
 * Steps: Unicode-fold (strip diacritics) -> lowercase -> collapse every run
 * of non [a-z0-9] characters into a single hyphen -> trim edge hyphens ->
 * strip any reserved substring (see reserved-patterns.ts) so the common case
 * doesn't auto-fill a value the validator would immediately reject -> clamp
 * to the format's max length -> backfill a single surviving character up to
 * the format's min length.
 *
 * Returns "" when the display name has no derivable content (no alphanumeric
 * characters after folding, or the entire input collapses to a reserved
 * substring with nothing left around it) — an honest empty result the
 * downstream "required" validation state already handles, rather than
 * inventing an arbitrary namespace out of nothing.
 */
export function deriveInstanceNamespace(displayName: string): string {
  // 1. Unicode fold — NFKD decomposes accented/composed characters into a
  //    base character plus combining marks, which we then strip, so "Café"
  //    derives "cafe" rather than "caf-".
  const folded = stripCombiningMarks(displayName.normalize("NFKD"));

  // 2. Lowercase, then collapse every run of non [a-z0-9] characters (spaces,
  //    punctuation, hyphens, and any non-Latin glyph the fold above could not
  //    decompose) into a single hyphen.
  let slug = folded.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // 3. Trim leading/trailing hyphens produced by leading/trailing punctuation.
  slug = trimHyphens(slug);

  // 4. Reserved-value avoidance. Split out any reserved substring so the
  //    live-derived candidate never lands on a value validateInstanceNamespace
  //    would reject as reserved — the validator remains the actual
  //    enforcement point; this only keeps the common case from auto-filling a
  //    value the operator would immediately have to edit by hand.
  for (const reserved of RESERVED_SUBSTRINGS) {
    if (slug.includes(reserved)) {
      slug = trimHyphens(slug.split(reserved).join("-").replace(/-+/g, "-"));
    }
  }

  // 5. Max-length clamp, re-trimming a hyphen the cut may have exposed.
  if (slug.length > MAX_LEN) {
    slug = trimHyphens(slug.slice(0, MAX_LEN));
  }

  // 6. Min-length backfill. A single surviving alphanumeric character (e.g.
  //    display name "A") is syntactically valid except for length, so pad
  //    with trailing "0"s rather than leave a one-character candidate the
  //    operator has to fix by hand before Continue enables. An empty slug is
  //    left empty on purpose (see doc comment above) — there is nothing safe
  //    to derive from.
  while (slug.length > 0 && slug.length < MIN_LEN) {
    slug = slug + "0";
  }

  return slug;
}
