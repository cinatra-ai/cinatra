/**
 * Single source of truth for the seven extension accent colours used by
 * `<ExtensionCard>` and the persisted Avatar accent — the categorical
 * accent set of the pinned design spec (`docs@b35fdf4`
 * design-system.html `:root` L31–37): burgundy / red / green / rust /
 * olive / plum / clay (cinatra#988 item 7 reconciliation; the previous
 * six-colour set wrongly used the primary ACTION indigo and the muted
 * text slate as banner grounds and lacked rust/olive/plum/clay).
 *
 * Avatar and ExtensionCard share this module so their accent palettes
 * cannot drift apart. The accent palette is also the source for the
 * `CHECK` constraint on the DB columns (`public."user".accent_color` and
 * `cinatra.extension_accent_color`).
 *
 * Adding or removing an accent requires updating `ACCENT_PALETTE` and
 * the DB CHECK constraint via a new migration (see
 * `migrations/core/core__0016_accent-palette-spec-categorical.mjs` for
 * the reconciliation migration + persisted-value remap).
 *
 * BrandMark and ExtensionCard consume this lower-level palette.
 */

export const EXTENSION_ACCENTS = [
  "red",
  "burgundy",
  "green",
  "rust",
  "olive",
  "plum",
  "clay",
] as const;

export type ExtensionAccent = (typeof EXTENSION_ACCENTS)[number];

export type AccentTone = {
  /** CSS background colour (raw hex from spec §IV palette + cinatra-design). */
  bg: string;
  /**
   * Foreground colour on the accent ground. The pinned drawing renders
   * light text (`--surface-strong`) on every categorical ground; paper
   * `#f1f1ed` hits AA at the banner-name scale (18px semibold = large
   * text) on all seven.
   */
  fg: string;
};

/**
 * Hex codes mirror the pinned spec's categorical accent tokens exactly
 * (`--burgundy/--red/--green/--rust/--olive/--plum/--clay`). These ARE
 * raw hex literals — they live here precisely so they appear only ONCE
 * in the codebase and `scripts/design/scan-raw-colors.mjs` can allowlist
 * this single file. Do not add new accent rows by hand: extend the
 * `EXTENSION_ACCENTS` tuple AND update the DB CHECK constraint via a
 * new migration.
 */
export const ACCENT_PALETTE: Record<ExtensionAccent, AccentTone> = {
  red: { bg: "#a6384f", fg: "#f1f1ed" },
  burgundy: { bg: "#7a2e3a", fg: "#f1f1ed" },
  green: { bg: "#3f6e6b", fg: "#f1f1ed" },
  rust: { bg: "#b0613a", fg: "#f1f1ed" },
  olive: { bg: "#6c6a3a", fg: "#f1f1ed" },
  plum: { bg: "#574a68", fg: "#f1f1ed" },
  clay: { bg: "#a86b72", fg: "#f1f1ed" },
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
