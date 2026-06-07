/**
 * Extension accent palette — six colours shared by `<ExtensionCard>` and the
 * persisted Avatar accent. Mirrored from the cinatra-app's
 * `src/lib/extension-accent.ts`; this is the sdk-ui-side copy so consumers
 * outside the cinatra-app (e.g. the Cinatra Marketplace public app) can
 * render extensions with the same accent semantics.
 *
 * Hex values match the spec §IV accent palette exactly. Keep this file in
 * sync with the cinatra-app copy and with the DB CHECK constraints on
 * `public."user".accent_color` and `cinatra.extension_accent_color`.
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
  /** CSS background colour (raw hex from spec §IV palette). */
  bg: string;
  /** Foreground colour that hits AA contrast against `bg`. */
  fg: string;
};

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
 * it matches the union, else `null`.
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
 * Derive a stable accent from a seed string (e.g. a package name) for
 * surfaces that have no persisted `accentColor` yet — the marketplace lists
 * not-yet-installed packages, so the §V "random accent at creation" is
 * approximated by a deterministic hash so a given package always draws the
 * same accent across renders/sessions.
 */
export function deriveExtensionAccent(seed: string): ExtensionAccent {
  const total = Array.from(seed).reduce(
    (sum, character) => sum + character.charCodeAt(0),
    0,
  );
  return EXTENSION_ACCENTS[total % EXTENSION_ACCENTS.length];
}
