/**
 * `/artifacts` mode model — the §I identity-gated mode control (cinatra#1431,
 * spec design@4c6799db §I/§VII).
 *
 * One page, one URL, several modes selected by the `?mode=` search param:
 *   - `library`   — the default, available to EVERY user;
 *   - `raw`       — the admin-only full objects browser (§IV);
 *   - `types`     — the admin-only Types & approvals registry (§V);
 *   - `undo`      — the admin-only data-safety undo surface (§VI);
 *   - `merge`     — the admin-only enrichment merge-proposals review. NOT in
 *     the pinned spec (§V/§VI are silent on merge-proposals); relocated here
 *     from the deleted `/data-safety/merge-proposals` route so the feature is
 *     not silently dropped while §VII removes `/data-safety`. Recorded on the
 *     PR with a spec-delta follow-up; admin-gated (fail-closed) like the other
 *     admin modes, with the per-object `object.update` authz kept in its
 *     actions as defense-in-depth.
 *
 * The mode control is identity-gated, NOT just view-gated: for a
 * non-administrator the admin segments/sub-views never render, AND a deep link
 * into any admin mode resolves to `denied` so the server renders the standard
 * not-authorized panel — never a 404 that would hide the admin surface's
 * existence, and never the admin data (the admin queries never run). This
 * pure resolver is the single source of truth both the server component
 * (authorization boundary) and the mode control (affordance) consult.
 */

export const ARTIFACTS_MODES = ["library", "raw", "types", "undo", "merge"] as const;
export type ArtifactsMode = (typeof ARTIFACTS_MODES)[number];

/** Modes gated to administrators. Library is intentionally absent. */
export const ADMIN_ARTIFACTS_MODES = ["raw", "types", "undo", "merge"] as const;
export type AdminArtifactsMode = (typeof ADMIN_ARTIFACTS_MODES)[number];

export const DEFAULT_ARTIFACTS_MODE: ArtifactsMode = "library";

export function isArtifactsMode(value: unknown): value is ArtifactsMode {
  return (
    typeof value === "string" &&
    (ARTIFACTS_MODES as readonly string[]).includes(value)
  );
}

export function isAdminArtifactsMode(mode: ArtifactsMode): boolean {
  return (ADMIN_ARTIFACTS_MODES as readonly string[]).includes(mode);
}

/**
 * The outcome of resolving a requested `?mode=` for an actor. `denied` is a
 * non-admin deep link into an admin mode: the server renders the inline
 * not-authorized refusal panel (§IV) for that mode — never a redirect, never a
 * 404, never the admin data.
 */
export type ResolvedArtifactsMode =
  | { kind: "allowed"; mode: ArtifactsMode }
  | { kind: "denied"; mode: AdminArtifactsMode };

/**
 * Resolve the requested mode against the actor's admin status.
 *   - an unknown / missing mode → the default Library (allowed for all);
 *   - Library → always allowed;
 *   - an admin mode + admin actor → allowed;
 *   - an admin mode + non-admin actor → denied (that exact mode, so the
 *     refusal panel can name it).
 */
export function resolveRequestedArtifactsMode(
  requested: string | undefined | null,
  isAdmin: boolean,
): ResolvedArtifactsMode {
  const mode = isArtifactsMode(requested) ? requested : DEFAULT_ARTIFACTS_MODE;
  if (!isAdminArtifactsMode(mode)) {
    return { kind: "allowed", mode };
  }
  if (isAdmin) {
    return { kind: "allowed", mode };
  }
  return { kind: "denied", mode: mode as AdminArtifactsMode };
}

/** Human-facing label per mode (sub-nav + refusal-panel copy). */
export const ARTIFACTS_MODE_LABEL: Record<ArtifactsMode, string> = {
  library: "Library",
  raw: "Raw objects",
  types: "Types & approvals",
  undo: "Undo",
  merge: "Merge proposals",
};
