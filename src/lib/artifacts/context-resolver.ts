import "server-only";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";
import { buildOwnershipFilter } from "@/lib/derived-store-ownership";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";

// ---------------------------------------------------------------------------
// Context Slot Resolver.
//
// Postgres-authoritative resolver for an agent's contextSlots. Walks the
// 4-tier ownership chain (User → Team → Organization → Workspace) plus the
// optional `projectId` refinement, joins assertion × artifact × latest
// representation, filters on `eligibility = 'eligible'` only, expands the
// accepted-extensions list via the single-hop satisfies-graph.
//
// Resolver invariants:
//   - Project refinement uses `visibility = 'project:<id>'` (NOT
//     `owner_level = 'project'` — project is a refinement, not a 5th tier).
//   - Visibility-based ownership filter is spliced from
//     `buildOwnershipFilter(actor)` rather than reinvented (parity with
//     objects-store.ts).
//   - Per-ref reauth is SKIPPED: `buildOwnershipFilter` already enforces
//     actor visibility at the SQL layer, so the returned set is
//     guaranteed actor-visible.
//   - `sourceScope` derived from `visibility`, not `owner_level`.
//   - Satisfies-graph expansion is SINGLE-HOP (interface compatibility,
//     not transitive closure). Cycle protection is by construction (no
//     recursion).
//   - Project-not-in-actor.projectIds → return `[]` fail-closed.
// ---------------------------------------------------------------------------

const SEMANTIC_ARTIFACT_OBJECT_TYPE = "@cinatra-ai/artifact:object";

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');

/** One row produced by the resolver. */
export type ResolvedContextRef = {
  artifactId: string;
  representationRevisionId: string;
  semanticAssertionId: string;
  extension: string;
  /** Which ownership tier produced this match. Used by the UI
   *  to group refs by source scope. */
  sourceScope: "user" | "team" | "organization" | "workspace" | "project";
  /** The owner_id of the matching row (for UI display only). */
  ownerId: string;
};

/** An installed artifact extension descriptor as the resolver needs it.
 *  The caller passes the FULL installed-extension list from the registry. */
export type InstalledExtensionDescriptor = {
  /** The extension's package name (e.g. `@cinatra-ai/marketing-icp-artifact`). */
  extension: string;
  /** The `satisfies: string[]` slice of the extension's manifest, or `[]`. */
  satisfies: string[];
};

export type ResolveContextSlotInput = {
  actor: ActorContext;
  slot: AgentContextSlot;
  /** Optional project refinement. If absent, project-visibility rows are
   *  EXCLUDED. If present + actor has it in `actor.projectIds`, project-
   *  visibility rows for that project become the narrowest tier. If
   *  present + NOT in actor.projectIds → `[]` fail-closed. */
  projectId?: string;
  installedExtensions: ReadonlyArray<InstalledExtensionDescriptor>;
};

// ---------------------------------------------------------------------------
// Satisfies-graph expansion (pure, no I/O)
// ---------------------------------------------------------------------------

/** Expand the accepted-extensions list via a single-hop satisfies-graph.
 *  An installed extension X is added to the accepted set IFF X.satisfies
 *  intersects the DIRECTLY-accepted set. NO transitive closure.
 *
 *  Implementation note: snapshot the accepted set BEFORE the loop
 *  so iteration order can't accidentally cascade hop-2/hop-3 matches into
 *  the result. Without the snapshot, an `installed` ordering of
 *  `[B (satisfies A), C (satisfies B)]` would cascade C into the expansion
 *  because B had just joined the set during the same loop pass — that's a
 *  transitive closure, not single-hop. */
export function expandAcceptedViaSatisfies(
  accepted: ReadonlyArray<string>,
  installed: ReadonlyArray<InstalledExtensionDescriptor>,
): string[] {
  const directlyAccepted = new Set(accepted);
  const result = new Set(accepted);
  for (const desc of installed) {
    for (const sat of desc.satisfies) {
      // Check against the SNAPSHOT (directlyAccepted), not the growing
      // result set. This enforces single-hop semantics regardless of
      // iteration order.
      if (directlyAccepted.has(sat)) {
        result.add(desc.extension);
        break;
      }
    }
  }
  return [...result];
}

// ---------------------------------------------------------------------------
// SourceScope derivation from visibility column
// ---------------------------------------------------------------------------

function deriveSourceScope(
  visibility: string,
  ownerLevel: string,
): "user" | "team" | "organization" | "workspace" | "project" {
  if (visibility.startsWith("project:")) return "project";
  if (visibility === "workspace") return "workspace";
  if (visibility === "org") return "organization";
  if (visibility.startsWith("team:")) return "team";
  // visibility = 'owner' (or anything else) → fall back to owner_level
  if (ownerLevel === "user") return "user";
  if (ownerLevel === "team") return "team";
  if (ownerLevel === "organization") return "organization";
  if (ownerLevel === "workspace") return "workspace";
  // Unrecognized → treat as user (defense — should never happen given DDL CHECK).
  return "user";
}

/** Numeric weight for narrow→broad ordering. Lower = narrower. */
function scopeWeight(
  scope: "user" | "team" | "organization" | "workspace" | "project",
): number {
  switch (scope) {
    case "project":
      return 0;
    case "user":
      return 1;
    case "team":
      return 2;
    case "organization":
      return 3;
    case "workspace":
      return 4;
  }
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a single context slot for the given actor. Returns ELIGIBLE
 * refs ordered narrow→broad, then `resolutionMode` filtered, then
 * `maxItems` truncated.
 *
 * Throws if `slot.acceptedArtifactExtensions` is empty (caller bug — the
 * parser already rejects empty arrays, but the resolver double-
 * guards). Throws on `actor.organizationId` absent (fail-closed: we
 * never resolve across orgs).
 *
 * Returns `[]` when:
 *   - `projectId` is provided but NOT in `actor.projectIds` (fail-closed)
 *   - no candidates match the MIME / eligibility / ownership filters
 */
export function resolveContextSlot(
  input: ResolveContextSlotInput,
): ResolvedContextRef[] {
  if (input.slot.acceptedArtifactExtensions.length === 0) {
    throw new Error(
      "[context-resolver] slot.acceptedArtifactExtensions is empty (resolver invariant)",
    );
  }
  if (!input.actor.organizationId) {
    throw new Error(
      "[context-resolver] actor.organizationId is required (fail-closed)",
    );
  }

  // projectId fail-closed gate: if the actor doesn't carry this project,
  // refuse — never expose project-scoped refs to actors that don't have
  // membership. The same gate exists in buildOwnershipFilter (it filters
  // by actor.projectIds at the SQL layer), but we also fail FAST here so
  // a caller mis-using projectId gets a clear `[]` instead of relying on
  // the SQL no-match.
  if (input.projectId !== undefined) {
    const actorProjects = input.actor.projectIds ?? [];
    if (!actorProjects.includes(input.projectId)) {
      return [];
    }
  }

  ensurePostgresSchema();
  const schema = q();
  const accepted = expandAcceptedViaSatisfies(
    input.slot.acceptedArtifactExtensions,
    input.installedExtensions,
  );

  // Splice the canonical ownership filter from derived-store-ownership.
  const ownership = buildOwnershipFilter(input.actor);

  // Build the parameter list:
  //   - ownership.params (positional $1..$N)
  //   - then accepted extensions (one positional)
  //   - then org_id (one positional)
  //   - then (when projectId set) the project visibility literal
  const params: unknown[] = [...ownership.params];
  // The buildOwnershipFilter SQL is already parameterized at the actor's
  // positions; we need to APPEND ours.
  const ph = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const acceptedPh = ph(accepted);
  const orgIdPh = ph(input.actor.organizationId);
  // The semantic-artifact object type literal is a constant — no param needed.
  const artifactTypePh = ph(SEMANTIC_ARTIFACT_OBJECT_TYPE);

  // The project-narrowing clause. When projectId is set, we ADDITIONALLY
  // require the row to be project-visible to THIS project. Combined with
  // the ownership filter (which already includes project-visibility rows
  // the actor has access to), this narrows to the specific project the
  // parent agent's context slot pointed at.
  const projectNarrow =
    input.projectId !== undefined
      ? ` AND o.visibility = ${ph(`project:${input.projectId}`)}`
      : "";

  // Both `objects` and `semantic_assertion` carry `org_id`, and
  // `buildOwnershipFilter` emits an UNQUALIFIED `org_id` predicate
  // designed for single-table reads. Splicing the helper into the joined
  // query would crash on ambiguous column reference. Resolve the
  // visible-object set in a CTE FIRST so the helper's `org_id` resolves
  // against ONLY the `objects` row, then join `semantic_assertion` +
  // `representation` on the de-ambiguated artifact-id list.
  //
  // When `projectId` is ABSENT, exclude project-visibility rows.
  // buildOwnershipFilter naturally admits any project
  // row the actor has via `actor.projectIds`; an UNREFINED slot should
  // NOT receive those rows. The `NOT LIKE 'project:%'` clause inside the
  // CTE applies only when no projectId is set (otherwise the projectNarrow
  // clause already pins to the specific project).
  const projectExcludeWhenUnset =
    input.projectId === undefined
      ? " AND o.visibility NOT LIKE 'project:%'"
      : "";

  const sql = `
    WITH visible_objects AS (
      SELECT id, org_id, owner_level, owner_id, visibility
      FROM "${schema}"."objects" o
      WHERE o.org_id = ${orgIdPh}
        AND o.type = ${artifactTypePh}
        AND o.deleted_at IS NULL
        AND (${ownership.sql})${projectNarrow}${projectExcludeWhenUnset}
    )
    SELECT
      o.id AS artifact_id,
      o.owner_level,
      o.owner_id,
      o.visibility,
      sa.id AS semantic_assertion_id,
      sa.extension,
      r.id AS representation_revision_id,
      r.revision
    FROM visible_objects o
    JOIN "${schema}"."semantic_assertion" sa
      ON sa.org_id = o.org_id AND sa.artifact_id = o.id
    JOIN LATERAL (
      SELECT id, revision
      FROM "${schema}"."representation"
      WHERE org_id = o.org_id AND artifact_id = o.id
      ORDER BY revision DESC
      LIMIT 1
    ) r ON true
    WHERE sa.eligibility = 'eligible'
      AND sa.extension = ANY(${acceptedPh}::text[])
  `;

  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [{ text: sql, values: params }],
  });
  type Row = {
    artifact_id: string;
    owner_level: string;
    owner_id: string;
    visibility: string;
    semantic_assertion_id: string;
    extension: string;
    representation_revision_id: string;
    revision: number;
  };
  const rows = (res?.rows ?? []) as Row[];

  // Map to refs + derive sourceScope from visibility.
  const refs: ResolvedContextRef[] = rows.map((r) => ({
    artifactId: r.artifact_id,
    representationRevisionId: r.representation_revision_id,
    semanticAssertionId: r.semantic_assertion_id,
    extension: r.extension,
    sourceScope: deriveSourceScope(r.visibility, r.owner_level),
    ownerId: r.owner_id,
  }));

  // Sort narrow → broad (project < user < team < org < workspace).
  // Tie-break by artifactId for determinism.
  refs.sort((a, b) => {
    const w = scopeWeight(a.sourceScope) - scopeWeight(b.sourceScope);
    if (w !== 0) return w;
    return a.artifactId.localeCompare(b.artifactId);
  });

  // Apply resolutionMode:
  //  - "override" → keep ONLY the rows from the narrowest tier that
  //    produced any match. This is a CANDIDATE set: the FINAL single-ref
  //    collapse happens in the context agent when selectionMode is
  //    "autonomous". When selectionMode is "interactive", the HITL renderer
  //    picks from these candidates. The resolver returns candidates ordered
  //    narrow→broad with deterministic tie-break (artifactId localeCompare)
  //    so the UI / autonomous picker has a stable surface.
  //  - "accumulate" → keep all rows narrow→broad.
  let filtered: ResolvedContextRef[];
  if (input.slot.resolutionMode === "override") {
    if (refs.length === 0) {
      filtered = [];
    } else {
      const narrowestScope = refs[0].sourceScope;
      filtered = refs.filter((r) => r.sourceScope === narrowestScope);
    }
  } else {
    filtered = refs;
  }

  // maxItems truncation. minItems is a CALLER concern (the runtime decides
  // what to do when too few candidates are present — typically prompt the
  // user via the interactive selector).
  if (typeof input.slot.maxItems === "number" && filtered.length > input.slot.maxItems) {
    filtered = filtered.slice(0, input.slot.maxItems);
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// Reject `ownerLevel: "project"` at the boundary
// ---------------------------------------------------------------------------

/**
 * Validation helper — explicit assertion that project is NOT a 5th
 * ownership tier. Caller should invoke this at any input
 * boundary where a typed `ownerLevel` is accepted, BEFORE invoking
 * `resolveContextSlot`. Throws on `ownerLevel === "project"`.
 *
 * Exported separately so tests can assert the resolver
 * has a project-not-a-tier guard even if no resolver call path passes
 * `ownerLevel`.
 */
export function rejectProjectAsOwnerLevel(ownerLevel: unknown): void {
  if (ownerLevel === "project") {
    throw new Error(
      "[context-resolver] ownerLevel:'project' is forbidden — project is a refinement, not an ownership tier",
    );
  }
}
