import "server-only";

// ---------------------------------------------------------------------------
// Presentation-identity HOST seam (epic #1883 slice A6, design D1).
//
// Binds the PURE presentation-identity resolver
// (`@cinatra-ai/objects/presentation-identity`) to the real host signals:
//   - install/live status  → object-type-registry membership (the same signal
//     `resolveEffectiveIdentity` uses; an uninstalled extension's types are
//     removed on teardown, so a non-live extension never wins a tier);
//   - per-pack thresholds   → the semantic-artifact manifest's
//     `matcherConfidenceThreshold` (default 0.7 — the matcher runtime's value);
//   - the org auto-surface toggle → `isArtifactAutoSurfaceDisabled` (Ruling 2).
//
// It is DISTINCT from `resolveArtifactEffectiveIdentities` by design: that
// resolver stays the shared, type-driven effective identity (context selection
// #1430, replay pinning, Graphiti projection). This one layers the row's
// meaning assertions on top for the three PRESENTATION consumers only (renderer
// dispatch, the library Type facet, row labeling). The presentation base is
// still the shared effective identity — computed here from the row type via the
// pure `resolveEffectiveIdentity`, never a separate identity source.
//
// All reads are SYNC (`runPostgresQueriesSync`) to match the artifact service's
// sync enrichment path. A read error FAILS CLOSED to no assertions ⇒ the
// presentation identity degrades to the base (type-driven) identity.
// ---------------------------------------------------------------------------

import {
  resolvePresentationIdentity,
  type PresentationAssertion,
  type PresentationAssertionBasis,
  type PresentationAssertionSource,
  type PresentationEligibility,
  type PresentationIdentity,
  type PresentationIdentityPolicy,
} from "@cinatra-ai/objects/presentation-identity";
import {
  resolveEffectiveIdentity,
  type EffectiveIdentity,
} from "@cinatra-ai/objects/effective-identity";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { claimedTypeRegisteringPackage } from "@cinatra-ai/objects/claims";

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

import { isArtifactAutoSurfaceDisabled } from "./artifact-autosurface-toggle";

export type { PresentationIdentity } from "@cinatra-ai/objects/presentation-identity";

// Mirror of the matcher runtime's `DEFAULT_MATCHER_CONFIDENCE_THRESHOLD`
// (src/lib/artifacts/matcher-runtime.ts) — the value a pack falls back to when
// its manifest declares no `matcherConfidenceThreshold`. Kept in lock-step: the
// presentation surface must threshold a draft at exactly the value the matcher
// runtime asserted it against.
const DEFAULT_MATCHER_CONFIDENCE_THRESHOLD = 0.7;

type Row = Record<string, unknown>;
const q = (): string => postgresSchema.replaceAll('"', '""');

/** The live-extension predicate source: every extension package that DEFINES a
 * currently-registered object type (its namespace). Built once per resolution
 * so the per-assertion check is a Set lookup. */
function buildLiveExtensionSet(): Set<string> {
  const set = new Set<string>();
  for (const def of objectTypeRegistry.list()) {
    const ns = claimedTypeRegisteringPackage(def.type);
    if (ns) set.add(ns);
  }
  return set;
}

/** The pack's matcher confidence threshold from its artifact manifest, or the
 * default when the pack declares none; null when the extension ships no
 * registered artifact type (⇒ its drafts never auto-surface). Resolves via the
 * `<ext>:artifact` umbrella every artifact pack registers today (the same key
 * the matcher runtime keys drafts on), then falls back to ANY registered
 * artifact type in the extension's namespace so the lookup does not hard-depend
 * on the umbrella id. */
function matcherThresholdFor(extension: string): number | null {
  let manifest = objectTypeRegistry.resolve(`${extension}:artifact`)?.isArtifact;
  if (!manifest) {
    for (const def of objectTypeRegistry.list()) {
      if (def.isArtifact && claimedTypeRegisteringPackage(def.type) === extension) {
        manifest = def.isArtifact;
        break;
      }
    }
  }
  if (!manifest) return null;
  return typeof manifest.matcherConfidenceThreshold === "number"
    ? manifest.matcherConfidenceThreshold
    : DEFAULT_MATCHER_CONFIDENCE_THRESHOLD;
}

function buildPolicy(orgId: string): PresentationIdentityPolicy {
  const liveExtensions = buildLiveExtensionSet();
  const autoSurfaceDisabled = isArtifactAutoSurfaceDisabled(orgId);
  return {
    isExtensionLive: (extension) => liveExtensions.has(extension),
    matcherThreshold: matcherThresholdFor,
    autoSurfaceDisabled,
  };
}

function toPresentationAssertion(row: Row): PresentationAssertion {
  return {
    extension: String(row.extension),
    assertedBy: row.asserted_by as PresentationAssertionSource,
    eligibility: row.eligibility as PresentationEligibility,
    assertionBasis: (row.assertion_basis as PresentationAssertionBasis) ?? "classic",
    confidence: row.confidence == null ? null : Number(row.confidence),
    assertedAt: String(row.asserted_at),
  };
}

/**
 * Resolve the PRESENTATION identity for a page of artifact rows. One batched
 * active-assertion query (eligible + drafts, archived excluded) feeds the pure
 * resolver per row; the tier-3 base is the row's shared type-driven identity.
 * Empty input ⇒ empty map. A read error fails closed to base identity for
 * every row.
 */
export function resolveArtifactPresentationIdentities(input: {
  orgId: string;
  rows: ReadonlyArray<{ id: string; type: string }>;
}): Map<string, PresentationIdentity> {
  const out = new Map<string, PresentationIdentity>();
  if (input.rows.length === 0) return out;
  ensurePostgresSchema();

  const assertionsByArtifact = new Map<string, PresentationAssertion[]>();
  try {
    const r = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `SELECT artifact_id, extension, asserted_by, eligibility, confidence, assertion_basis, asserted_at
FROM "${q()}"."semantic_assertion"
WHERE org_id = $1 AND artifact_id = ANY($2::text[]) AND eligibility <> 'archived'
ORDER BY artifact_id, asserted_at, extension`,
          values: [input.orgId, input.rows.map((row) => row.id)],
        },
      ],
    });
    for (const row of (r?.[0]?.rows ?? []) as Row[]) {
      const artifactId = String(row.artifact_id);
      const rec = toPresentationAssertion(row);
      const list = assertionsByArtifact.get(artifactId);
      if (list) list.push(rec);
      else assertionsByArtifact.set(artifactId, [rec]);
    }
  } catch {
    // fail-closed: no assertions ⇒ every row falls through to base identity.
  }

  const policy = buildPolicy(input.orgId);
  for (const row of input.rows) {
    out.set(
      row.id,
      resolvePresentationIdentity({
        baseIdentity: resolveEffectiveIdentity(row.type),
        assertions: assertionsByArtifact.get(row.id) ?? [],
        policy,
      }),
    );
  }
  return out;
}

/** Singular convenience wrapper over the batched resolver. Never throws — falls
 * closed to the base (type-driven) identity. */
export function resolveArtifactPresentationIdentity(input: {
  orgId: string;
  artifactId: string;
  baseType: string;
}): PresentationIdentity {
  const map = resolveArtifactPresentationIdentities({
    orgId: input.orgId,
    rows: [{ id: input.artifactId, type: input.baseType }],
  });
  return (
    map.get(input.artifactId) ?? {
      identity: resolveEffectiveIdentity(input.baseType),
      tier: "claim-backed",
      suggestions: [],
    }
  );
}

export type { EffectiveIdentity };
