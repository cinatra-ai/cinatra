/**
 * User avatar helper: the accent ground and the initials of a person's avatar
 * fallback (cinatra#4292).
 *
 * The drawing (specs/app-components.html, Avatar): "User avatars carry the
 * user's initials in Archivo italic 800 on a random categorical accent (never
 * indigo or navy)". The accent comes from the categorical palette in
 * `./extension-accent`, which holds neither indigo nor navy. A valid persisted
 * accent (`user.accent_color`) wins; otherwise the accent is derived from the
 * first present of the user id, the e-mail and the name (else the empty
 * string), so one person draws the same accent on every render of a surface
 * that passes the same fields.
 *
 * The app-side `src/lib/user-avatar.ts` re-exports this module, so the app
 * and the packages share one implementation.
 */

import {
  asExtensionAccent,
  deriveExtensionAccent,
  type ExtensionAccent,
} from "./extension-accent";

export type UserAvatarSource = {
  /** The stable user id. It seeds the accent first when no valid accent is stored. */
  id?: string | null;
  /** The persisted accent (`user.accent_color`); ignored when not a palette name. */
  accentColor?: string | null;
  name?: string | null;
  email?: string | null;
};

/** The accent ground of a user's avatar: the valid persisted accent, else one derived from `id || email || name || ""`. */
export function userAvatarAccent(user: UserAvatarSource): ExtensionAccent {
  return (
    asExtensionAccent(user.accentColor) ??
    deriveExtensionAccent(user.id || user.email || user.name || "")
  );
}

/** A word's first Unicode letter (\p{L}), upper-cased to one character; "" when it has none. */
function firstLetterOf(word: string): string {
  const letter = /\p{L}/u.exec(word)?.[0] ?? "";
  return Array.from(letter.toUpperCase())[0] ?? "";
}

/**
 * The first letter of the first and of the last word that hold a letter (one
 * letter for one such word). Words without a letter ("-", U+200B, digits,
 * punctuation) are skipped, so the result holds only letters or is "".
 */
function initialsOf(words: string[]): string {
  const letters = words.map(firstLetterOf).filter(Boolean);
  if (letters.length === 0) return "";
  return letters.length > 1 ? letters[0] + letters[letters.length - 1] : letters[0];
}

/**
 * A user's initials, taken only from letters: from the name, then from the
 * e-mail's local part (split at ".", "_", "-" and "+"). Returns `fallback`
 * when neither gives a letter, so an avatar never draws a blank or a
 * non-letter initial.
 */
export function userInitials(user: UserAvatarSource, fallback = "?"): string {
  const fromName = initialsOf((user.name ?? "").split(/\s+/));
  if (fromName) return fromName;
  const local = (user.email ?? "").trim().split("@")[0] ?? "";
  const fromEmail = initialsOf(local.split(/[._+-]+/));
  return fromEmail || fallback;
}
