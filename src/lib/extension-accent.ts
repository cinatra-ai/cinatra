/**
 * Single source of truth for the six extension accent colours used by
 * `<ExtensionCard>` and the persisted Avatar accent.
 *
 * Avatar and ExtensionCard share this module so their accent palettes
 * cannot drift apart. The accent palette is also the source for the
 * `CHECK` constraint on the DB columns (`public."user".accent_color` and
 * `cinatra.extension_accent_color`).
 *
 * Adding or removing an accent requires updating `ACCENT_PALETTE` and
 * the DB CHECK constraint via a new migration.
 *
 * BrandMark and ExtensionCard consume this lower-level palette.
 */

export const EXTENSION_ACCENTS = [
  "red",
  "burgundy",
  "indigo",
  "green",
  "mustard",
  "slate",
] as const;

export type ExtensionAccent = (typeof EXTENSION_ACCENTS)[number];

export type AccentTone = {
  /** CSS background colour (raw hex from spec §IV palette + cinatra-design). */
  bg: string;
  /** Foreground colour that hits AA contrast against `bg`. */
  fg: string;
};

/**
 * Hex codes mirror the spec §IV accent palette exactly. These ARE raw
 * hex literals — they live here precisely so they appear only ONCE in
 * the codebase and `scripts/design/scan-raw-colors.mjs` can allowlist
 * this single file. Do not add new accent rows by hand: extend the
 * `EXTENSION_ACCENTS` tuple AND update the DB CHECK constraint AND
 * update the spec resolutions doc.
 */
export const ACCENT_PALETTE: Record<ExtensionAccent, AccentTone> = {
  red: { bg: "#a6384f", fg: "#f1f1ed" },
  burgundy: { bg: "#7a2e3a", fg: "#f1f1ed" },
  indigo: { bg: "#364e81", fg: "#f1f1ed" },
  green: { bg: "#3f6e6b", fg: "#f1f1ed" },
  mustard: { bg: "#c79545", fg: "#15213a" },
  slate: { bg: "#5a6477", fg: "#f1f1ed" },
};

/**
 * Type-narrowing helper: returns `value` typed as `ExtensionAccent` when
 * it matches the union, else `null`. Use this when reading the raw text
 * value out of the DB (the column is `text` with a CHECK constraint —
 * defence-in-depth in case someone hand-edits the column).
 */
export function asExtensionAccent(
  value: string | null | undefined,
): ExtensionAccent | null {
  if (!value) return null;
  if ((EXTENSION_ACCENTS as readonly string[]).includes(value)) {
    return value as ExtensionAccent;
  }
  return null;
}

/**
 * Derive a STABLE accent from a seed string (e.g. a package name) for
 * surfaces that have no persisted `accentColor` yet — the marketplace
 * lists not-yet-installed packages, so §V's "random accent at creation"
 * is approximated by a deterministic hash so a given package always draws
 * the same accent across renders/sessions.
 */
export function deriveExtensionAccent(seed: string): ExtensionAccent {
  const total = Array.from(seed).reduce(
    (sum, character) => sum + character.charCodeAt(0),
    0,
  );
  return EXTENSION_ACCENTS[total % EXTENSION_ACCENTS.length];
}
