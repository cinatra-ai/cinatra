import { slugify } from "@/lib/utils";

/**
 * Derive a slug base for a new organization from its name.
 *
 * Better Auth `organization.slug` is GLOBALLY unique (the create endpoint
 * pre-checks `findOrganizationBySlug` and rejects a taken slug with
 * `ORGANIZATION_ALREADY_EXISTS`), and the platform's other create surface
 * (`CreateOrganizationDialog`) constrains manual slugs to `^[a-z0-9-]+$`.
 * This produces a conforming base capped at 57 chars — so an appended `-<n>`
 * disambiguation suffix stays within a 63-char ceiling and still ends in an
 * alphanumeric (mirrors `toTeamSlugBase`) — falling back to `"organization"`
 * when `slugify` yields an empty/invalid value (e.g. a punctuation-only or
 * non-latin name). The uniqueness suffix is appended by
 * `createOrganizationAction`'s retry loop.
 *
 * Kept in its own module (no `server-only` / DB imports) so it stays unit
 * testable without pulling in the server-action import chain.
 */
export function toOrganizationSlugBase(name: string): string {
  const base = slugify(name).slice(0, 57).replace(/-+$/g, "");
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(base)
    ? base
    : "organization";
}
