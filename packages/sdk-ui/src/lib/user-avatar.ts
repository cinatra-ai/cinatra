/**
 * User avatar helper: the accent ground and the initials of a person's avatar
 * fallback (cinatra#4292).
 *
 * The drawing (specs/app-components.html, Avatar): "User avatars carry the
 * user's initials in Archivo italic 800 on a random categorical accent (never
 * indigo or navy)". The accent comes from the categorical palette in
 * `./extension-accent`, which holds neither indigo nor navy. A valid persisted
 * accent (`user.accent_color`) wins; otherwise the accent is derived from the
 * stable user id, so one person draws the same accent on every surface and
 * every render.
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
  /** The stable user id. It seeds the accent when no valid accent is stored. */
  id?: string | null;
  /** The persisted accent (`user.accent_color`); ignored when not a palette name. */
  accentColor?: string | null;
  name?: string | null;
  email?: string | null;
};

/** The accent ground of a user's avatar: the valid persisted accent, else one derived from the id. */
export function userAvatarAccent(user: UserAvatarSource): ExtensionAccent {
  return (
    asExtensionAccent(user.accentColor) ??
    deriveExtensionAccent(user.id || user.email || user.name || "")
  );
}

/** The first letter of the first and of the last word, upper-cased (one letter for one word). */
function initialsOf(words: string[]): string {
  const first = Array.from(words[0] ?? "")[0] ?? "";
  const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/**
 * A user's initials: from the name, then from the e-mail's local part
 * (split at ".", "_", "-" and "+"). Returns `fallback` only when neither
 * gives a letter, so an avatar never draws a blank.
 */
export function userInitials(user: UserAvatarSource, fallback = "?"): string {
  const fromName = initialsOf((user.name ?? "").trim().split(/\s+/).filter(Boolean));
  if (fromName) return fromName;
  const local = (user.email ?? "").trim().split("@")[0] ?? "";
  const fromEmail = initialsOf(local.split(/[._+-]+/).filter(Boolean));
  return fromEmail || fallback;
}
