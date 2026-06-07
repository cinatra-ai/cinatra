import { slugify } from "@/lib/utils";

/**
 * Derive a slug base for a new team from its name.
 *
 * `public.team.slug` is `NOT NULL` with a CHECK constraint
 * (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` and not LIKE `~%`) and is UNIQUE per
 * organization (`team_slug_uniq_in_org`). This produces a CHECK-conforming
 * base (≤57 chars so an appended `-<n>` disambiguation suffix stays within the
 * 63-char ceiling and still ends in an alphanumeric), falling back to `"team"`
 * when `slugify` yields an empty/invalid value (e.g. a punctuation-only or
 * non-latin name). The per-org uniqueness suffix is appended by
 * `createTeamAction`'s ON CONFLICT retry loop.
 *
 * Kept in its own module (no `server-only` / DB imports) so it stays unit
 * testable without pulling in the server-action import chain.
 */
export function toTeamSlugBase(name: string): string {
  const base = slugify(name).slice(0, 57).replace(/-+$/g, "");
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(base) ? base : "team";
}
