import "server-only";

// ---------------------------------------------------------------------------
// Presentation-identity auto-surface toggle — the Ruling 2 escape hatch READ
// SEAM (epic #1883 slice A6).
//
// Ruling 2 (owner, 2026-07-20): derived meaning AUTO-SURFACES at/above the
// pack's confidence threshold as PRESENTATION only, with an org-level toggle
// left as an escape hatch. This module is that toggle's read boundary: a single
// `isArtifactAutoSurfaceDisabled(orgId)` the presentation-identity resolver
// consults to disable tier 2 (matcher-draft auto-surface) for an org.
//
// This slice (A6) ships the SEAM, not the org-scoped settings persistence — the
// settings UI that writes the per-org preference is A4's. Until that lands the
// seam resolves from two sources, most-specific first:
//   1. a process-local override map (set by the future settings loader / tests),
//   2. an instance-level env default (`CINATRA_ARTIFACT_AUTOSURFACE_DISABLED` —
//      "1"/"true"/"all" disables for every org; a comma-separated list disables
//      the named org ids).
// Absent both ⇒ FALSE (auto-surface ON — Ruling 2's default). Reads never throw.
// ---------------------------------------------------------------------------

/** Process-local overrides, keyed by org id. The org-settings loader (A4) and
 * tests write here; a `null` value is a not-set tombstone that falls through to
 * the env default. */
const overrides = new Map<string, boolean>();

let envParsed: { all: boolean; orgs: Set<string> } | null = null;

function parseEnv(): { all: boolean; orgs: Set<string> } {
  if (envParsed) return envParsed;
  const raw = (process.env.CINATRA_ARTIFACT_AUTOSURFACE_DISABLED ?? "").trim();
  const orgs = new Set<string>();
  let all = false;
  if (raw.length > 0) {
    const lower = raw.toLowerCase();
    if (lower === "1" || lower === "true" || lower === "all") {
      all = true;
    } else {
      for (const part of raw.split(",")) {
        const id = part.trim();
        if (id) orgs.add(id);
      }
    }
  }
  envParsed = { all, orgs };
  return envParsed;
}

/**
 * Is matcher-draft auto-surface DISABLED for this org? True ⇒ the
 * presentation-identity resolver skips tier 2 (no draft ever auto-surfaces;
 * drafts stay suggestion chips). Default false.
 */
export function isArtifactAutoSurfaceDisabled(orgId: string): boolean {
  const override = overrides.get(orgId);
  if (override !== undefined) return override;
  const env = parseEnv();
  return env.all || env.orgs.has(orgId);
}

/**
 * Set (or clear) the process-local override for an org. The A4 settings loader
 * calls this when it reads the persisted per-org preference; passing `null`
 * clears the override so the env default applies again.
 */
export function setArtifactAutoSurfaceDisabled(orgId: string, disabled: boolean | null): void {
  if (disabled === null) overrides.delete(orgId);
  else overrides.set(orgId, disabled);
}

/** @internal test-only reset of the module's cached env + overrides. */
export function _resetArtifactAutoSurfaceToggleForTests(): void {
  overrides.clear();
  envParsed = null;
}
