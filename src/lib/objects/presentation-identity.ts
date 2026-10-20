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
import { objectTypeRegistry, matcherManifestRegistry } from "@cinatra-ai/objects/registry";
import { claimedTypeRegisteringPackage } from "@cinatra-ai/objects/claims";

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

import { isArtifactAutoSurfaceDisabled } from "./artifact-autosurface-toggle";

export type { PresentationIdentity } from "@cinatra-ai/objects/presentation-identity";

type Row = Record<string, unknown>;
const q = (): string => postgresSchema.replaceAll('"', '""');

/** The live-extension predicate source for TYPE-registering packs: every
 * extension package that DEFINES a currently-registered object type (its
 * namespace). Built once per resolution so the per-assertion check is a Set
 * lookup. A matcher-ONLY pack (no own-namespace object type) is NOT here — its
 * liveness is resolved separately through the org-scoped active-install gate
 * (cinatra#1891 A3), unioned into the set by `buildPolicy`. */
function buildLiveExtensionSet(): Set<string> {
  const set = new Set<string>();
  for (const def of objectTypeRegistry.list()) {
    const ns = claimedTypeRegisteringPackage(def.type);
    if (ns) set.add(ns);
  }
  return set;
}

/** The pack's matcher confidence threshold — CHANNEL-AUTHORITATIVE (cinatra#1891
 * A3, peer-review R1 #4). Read from the SAME meaning-surface channel entry the matcher
 * runtime built the candidate + asserted the draft from (already resolved to the
 * manifest value or the pack default), so a draft can auto-surface only for a
 * pack that is actually in the channel — and reconcile removing the entry
 * simultaneously removes the threshold, so a dropped-matchers pack stops
 * surfacing. `null` when the pack declares no matcher surface. The old broad
 * object-type fallback ("any registered artifact type → default 0.7") is REMOVED
 * — it was unsafe: a purely structural pack that never declared matchers would
 * otherwise threshold-pass a forced/legacy draft at 0.7. */
function matcherThresholdFor(extension: string): number | null {
  return matcherManifestRegistry.get(extension)?.matcherConfidenceThreshold ?? null;
}

/**
 * Matcher-pack liveness — the org-scoped active-install gate, mirroring the
 * matcher runtime's own `isArtifactExtensionWriteAllowed(pkg, orgId)` decision
 * (cinatra#1891 A3, peer-review R1 #5) EXACTLY, but as a SYNC read (matching the
 * presentation host's other sync reads). A matcher pack is presentation-live iff
 * it is BOTH in the channel AND its canonical install status admits a write for
 * this org — otherwise a draft would keep surfacing in an org that soft-archived
 * the pack (org-admin soft archive does no process-global registry teardown, and
 * uninstall archival archives only `eligible` assertions, not matcher drafts).
 *
 *   - NO `kind:"artifact"` install rows                 → LIVE (ungoverned
 *     bundled/disk artifact; CG-1 parity with the write gate).
 *   - a LIVE (`active|locked`) row governs this org      → LIVE.
 *   - rows exist but none live for this scope            → NOT live (DENY).
 *   - read error                                         → NOT live (fail-closed:
 *     an unreadable gate never auto-surfaces a draft).
 *
 * `packageNames` is the channel-registered subset actually referenced by this
 * batch's assertions — an empty list skips the read entirely (no per-page cost
 * when no assertion targets a matcher pack).
 */
function buildMatcherLiveExtensionSet(
  orgId: string,
  packageNames: readonly string[],
): Set<string> {
  const live = new Set<string>();
  if (packageNames.length === 0) return live;
  const rowsByPkg = new Map<string, { status: string; organizationId: string | null }[]>();
  try {
    const r = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `SELECT package_name, status, organization_id
FROM "${q()}"."installed_extension"
WHERE kind = 'artifact' AND package_name = ANY($1::text[])`,
          values: [[...packageNames]],
        },
      ],
    });
    for (const row of (r?.[0]?.rows ?? []) as Row[]) {
      const pkg = String(row.package_name);
      const list = rowsByPkg.get(pkg) ?? [];
      list.push({
        status: String(row.status),
        organizationId: row.organization_id == null ? null : String(row.organization_id),
      });
      rowsByPkg.set(pkg, list);
    }
  } catch {
    // fail-closed: cannot read install status ⇒ no matcher pack is live (a draft
    // never auto-surfaces on an unreadable gate).
    return live;
  }
  for (const pkg of packageNames) {
    const rows = rowsByPkg.get(pkg);
    if (!rows || rows.length === 0) {
      live.add(pkg); // ungoverned (no install row) — CG-1 parity with the write gate.
      continue;
    }
    const liveRows = rows.filter((row) => row.status === "active" || row.status === "locked");
    if (liveRows.length === 0) continue; // deliberately taken down → not live.
    // Org-owned live row first, then an ambient (platform/workspace) install —
    // identical row pick to `isArtifactExtensionWriteAllowed`'s org-scoped path.
    const governing =
      liveRows.find((row) => row.organizationId === orgId) ||
      liveRows.find((row) => row.organizationId == null) ||
      null;
    if (governing) live.add(pkg);
  }
  return live;
}

function buildPolicy(
  orgId: string,
  matcherPackagesInBatch: readonly string[],
): PresentationIdentityPolicy {
  const liveExtensions = buildLiveExtensionSet();
  // Matcher-pack liveness is decided SOLELY by the org-scoped install gate, so it
  // == the matcher runtime's own two-gate decision (channel membership + org
  // active-install). A channel pack that ALSO registers an own-namespace object
  // type would otherwise stay live through the type-registry base set even after
  // an org-scoped archive — bypassing the gate and surfacing a draft the runtime
  // would refuse to (re)assert. So DROP the batch's channel packs from the
  // type-derived base FIRST, then re-add only the gate-approved ones (codex
  // implementation-round #1). For a matcher-ONLY pack the delete is a no-op (it
  // registers no type), so the gate is the sole authority regardless.
  for (const pkg of matcherPackagesInBatch) liveExtensions.delete(pkg);
  for (const pkg of buildMatcherLiveExtensionSet(orgId, matcherPackagesInBatch)) {
    liveExtensions.add(pkg);
  }
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
  return resolvePresentationBatch(input).identities;
}

/** The batched resolution plus the active assertions it read, so a caller that
 * needs a draft's confidence (the picker's suggestion chips, cinatra#3319) reads
 * the SAME rows the tiers were decided on — never a second, divergent query. */
function resolvePresentationBatch(input: {
  orgId: string;
  rows: ReadonlyArray<{ id: string; type: string }>;
}): {
  identities: Map<string, PresentationIdentity>;
  assertionsByArtifact: Map<string, PresentationAssertion[]>;
} {
  const out = new Map<string, PresentationIdentity>();
  const assertionsByArtifact = new Map<string, PresentationAssertion[]>();
  if (input.rows.length === 0) return { identities: out, assertionsByArtifact };
  ensurePostgresSchema();

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

  // The channel-registered matcher packs ACTUALLY referenced by this batch's
  // assertions — the only ones whose org-scoped install gate we need to read
  // (bounds the extra sync read to pages that carry a matcher-pack assertion).
  const channelPackages = new Set(matcherManifestRegistry.list().map((e) => e.packageName));
  const matcherPackagesInBatch = new Set<string>();
  for (const list of assertionsByArtifact.values()) {
    for (const a of list) {
      if (channelPackages.has(a.extension)) matcherPackagesInBatch.add(a.extension);
    }
  }

  const policy = buildPolicy(input.orgId, [...matcherPackagesInBatch]);
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
  return { identities: out, assertionsByArtifact };
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

/** The type picker's derived meaning for one row (spec
 * `specs/app-artifacts.html` §VI.1 "Derived meaning & suggestion chips",
 * cinatra#3319), decided by the SAME presentation tiers the row is drawn with:
 *   - `preselect` — the extension the picker opens pre-selected on: the tier-2
 *     matcher draft at or above its pack's threshold that auto-surfaced as the
 *     row's presented identity; `null` when no draft auto-surfaced (below
 *     threshold, a tie at the top, the org toggle set, or a higher tier won).
 *   - `suggestions` — every live matcher draft that did NOT auto-surface, each
 *     with its highest draft confidence (`null` when the draft carries none),
 *     in the resolver's deterministic order. The pre-selected extension is never
 *     also a suggestion. */
export type ArtifactMeaningOffer = {
  preselect: string | null;
  suggestions: Array<{ extension: string; confidence: number | null }>;
};

/** ONE reading of one row's presentation for a caller that also needs the
 * picker's derived meaning (the detail read the picker's candidate list makes,
 * cinatra#3319). It runs the batched resolution ONCE — one `semantic_assertion`
 * read — and derives both answers from it, so the meaning offer can never
 * disagree with the presentation the same read returns, and the picker's road
 * never adds a second blocking read of the sync bridge.
 *
 * `presentation` is exactly what {@link resolveArtifactPresentationIdentity}
 * answers for the same input, with the same failure behaviour: a read error
 * fails closed to the base identity (and so to an empty offer). */
export function resolveArtifactPresentationReading(input: {
  orgId: string;
  artifactId: string;
  baseType: string;
}): { presentation: PresentationIdentity; offer: ArtifactMeaningOffer } {
  const { identities, assertionsByArtifact } = resolvePresentationBatch({
    orgId: input.orgId,
    rows: [{ id: input.artifactId, type: input.baseType }],
  });
  // The same fallback as the singular wrapper above.
  const presentation: PresentationIdentity = identities.get(input.artifactId) ?? {
    identity: resolveEffectiveIdentity(input.baseType),
    tier: "claim-backed",
    suggestions: [],
  };
  return {
    presentation,
    offer: meaningOfferOf(presentation, assertionsByArtifact.get(input.artifactId) ?? []),
  };
}

/** The offer, derived from a resolved presentation and the active assertions
 * it was decided on. Pure. */
function meaningOfferOf(
  pi: PresentationIdentity,
  assertions: readonly PresentationAssertion[],
): ArtifactMeaningOffer {
  const preselect =
    pi.tier === "matcher" && pi.identity.kind === "extension" ? pi.identity.extension : null;
  const drafts = assertions.filter(
    (a) => a.assertedBy === "matcher" && a.eligibility === "draft",
  );
  const suggestions = pi.suggestions
    .filter((extension) => extension !== preselect)
    .map((extension) => {
      let confidence: number | null = null;
      for (const d of drafts) {
        if (d.extension !== extension || d.confidence == null) continue;
        if (confidence === null || d.confidence > confidence) confidence = d.confidence;
      }
      return { extension, confidence };
    });
  return { preselect, suggestions };
}

export type { EffectiveIdentity };
