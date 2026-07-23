import "server-only";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";
import { buildOwnershipFilter } from "@/lib/derived-store-ownership";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { ensureArtifactTypesRegistered } from "./ensure-artifact-registry";
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
//   - Project refinement uses the canonical `project_id` COLUMN (cinatra#1428
//     — the composite `visibility = 'project:<id>'` encoding is retired; and
//     NOT `owner_level = 'project'` — project is a refinement, not a 5th tier).
//   - Ownership filter is spliced from `buildOwnershipFilter(actor)` rather
//     than reinvented (parity with objects-store.ts).
//   - Per-ref reauth is SKIPPED: `buildOwnershipFilter` already enforces
//     actor visibility at the SQL layer, so the returned set is
//     guaranteed actor-visible.
//   - `sourceScope` derived from `project_id` + `owner_level` (canonical
//     column vocabulary; visibility is the SHARE axis, not the tier).
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
  /** cinatra#1430: the snapshot pins minted/reused by
   *  `captureSnapshotsForContextSlot` at THIS resolution. A CLAIMED row
   *  (eligible binding) is emitted ONLY through its pinned snapshot
   *  representation — never "latest revision" (an A→B→A content cycle must
   *  resolve to the reused snapshot, and a redaction-blocked row must not be
   *  selectable through an older representation). Claimed rows without a pin
   *  are EXCLUDED (fail-closed). Generic artifacts ignore this and keep the
   *  latest-representation join. */
  snapshotPins?: ReadonlyArray<{
    objectId: string;
    representationRevisionId: string;
    /** The binding assertion the snapshot was captured under: the claimed row
     * is emitted ONLY as this assertion (a binding transition between capture
     * and resolve fails closed — no candidate — instead of pairing an old
     * claimant's snapshot with a new claimant's identity). */
    semanticAssertionId: string;
  }>;
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
// SourceScope derivation from the canonical columns (cinatra#1428)
// ---------------------------------------------------------------------------

function deriveSourceScope(
  ownerLevel: string,
  projectId: string | null,
): "user" | "team" | "organization" | "workspace" | "project" {
  // Project refinement is the narrowest tier: a project-tagged row resolved
  // through a project-refined slot groups under 'project'. Truthiness check
  // (not `!== null`) so an absent column (undefined) or '' is NOT a project.
  if (projectId) return "project";
  if (ownerLevel === "user") return "user";
  if (ownerLevel === "team") return "team";
  if (ownerLevel === "organization") return "organization";
  if (ownerLevel === "workspace") return "workspace";
  // Unrecognized → treat as user (defense — should never happen given the
  // canonical owner_level domain).
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
  // The generic semantic-artifact object type literal (the default-artifact
  // floor's base type). cinatra#1430: this is no longer the ONLY admissible
  // type — a CLAIMED typed row carrying an eligible BINDING assertion is also a
  // context candidate (its snapshot representation + binding assertion complete
  // the triple). The type predicate below admits the generic type OR any row
  // bearing an eligible binding; the assertion join + accepted-extension filter
  // remain the real gate on WHICH extensions resolve.
  const artifactTypePh = ph(SEMANTIC_ARTIFACT_OBJECT_TYPE);

  // epic #1785 wave A4: the registered isArtifact PACK types (read at query-
  // build time — never a frozen module-load snapshot). A pack-typed row created
  // by the A3 writer carries its exact declared type in objects.type (not the
  // retired generic base). A RUN-PRODUCED pack row also carries a producer
  // CLASSIC assertion (extension = the producing ext), so the assertion JOIN +
  // accepted-extension filter + the (assertionId, extension) triple below stay
  // the real gate on WHICH extensions resolve — this predicate only admits the
  // row into the visible set. An UPLOADED (assertion-less) pack row is admitted
  // here but produces no candidate (no eligible assertion an accepted extension
  // matches) — identical to an assertion-less generic row, not a regression.
  // Warm the registry first: the context read paths do not transitively trigger
  // boot registration, so a cold process would see an empty artifact-type set.
  ensureArtifactTypesRegistered();
  const artifactTypeIdsPh = ph(
    objectTypeRegistry.listArtifacts().map((d) => d.type),
  );

  // The project-narrowing clause. When projectId is set, we ADDITIONALLY
  // require the row to be tagged for THIS project (canonical `project_id`
  // column — cinatra#1428). Combined with the ownership filter (which already
  // includes project-tagged rows the actor has access to), this narrows to
  // the specific project the parent agent's context slot pointed at.
  const projectNarrow =
    input.projectId !== undefined
      ? ` AND o.project_id = ${ph(input.projectId)}`
      : "";

  // Both `objects` and `semantic_assertion` carry `org_id`, and
  // `buildOwnershipFilter` emits an UNQUALIFIED `org_id` predicate
  // designed for single-table reads. Splicing the helper into the joined
  // query would crash on ambiguous column reference. Resolve the
  // visible-object set in a CTE FIRST so the helper's `org_id` resolves
  // against ONLY the `objects` row, then join `semantic_assertion` +
  // `representation` on the de-ambiguated artifact-id list.
  //
  // When `projectId` is ABSENT, exclude project-tagged rows.
  // buildOwnershipFilter naturally admits any project
  // row the actor has via `actor.projectIds`; an UNREFINED slot should
  // NOT receive those rows. The `project_id IS NULL` clause inside the
  // CTE applies only when no projectId is set (otherwise the projectNarrow
  // clause already pins to the specific project).
  const projectExcludeWhenUnset =
    input.projectId === undefined ? " AND o.project_id IS NULL" : "";

  // cinatra#1430: snapshot pins for claimed rows (empty arrays when the
  // caller passed none — every claimed row is then excluded, fail-closed).
  const pins = input.snapshotPins ?? [];
  const pinObjectIdsPh = ph(pins.map((p) => p.objectId));
  const pinRepIdsPh = ph(pins.map((p) => p.representationRevisionId));
  const pinAssertionIdsPh = ph(pins.map((p) => p.semanticAssertionId));

  // cinatra#1896 / epic #1883 §D8 (v1): DASHBOARD-FORM rows are excluded from
  // attachment-hydrated context candidates. A dashboards-artifact twin (§D7)
  // carries the base object type `@cinatra-ai/dashboard-artifact:dashboard`
  // (which IS in listArtifacts(), so the type predicate above admits it) and its
  // substrate substance is the published dashboard envelope — a `representation.form =
  // 'dashboard'` row, NOT ingestible file bytes. Such a row can never be
  // hydrated as an LLM attachment (there is no file body to upload to a
  // provider), so were it ever to carry an eligible assertion an accepted
  // extension matches (a user meaning-assertion on a dashboard-typed row, or a
  // future pack meaning assertion) it would resolve as a doomed candidate. Fail
  // closed at the CANDIDATE query: exclude any object holding a dashboard-form
  // representation. Form 'dashboard' is written ONLY by the dashboards twin
  // writer, so this never touches a file-form artifact. This is v1 defense in
  // depth — independent of whether a dashboard row currently acquires an
  // eligible accepted assertion.
  const dashboardFormExclude = `
        AND NOT EXISTS (
          SELECT 1 FROM "${schema}"."representation" rdash
          WHERE rdash.org_id = o.org_id AND rdash.artifact_id = o.id
            AND rdash.form = 'dashboard'
        )`;

  const sql = `
    WITH visible_objects AS (
      SELECT id, org_id, owner_level, owner_id, visibility, project_id,
        EXISTS (
          SELECT 1 FROM "${schema}"."semantic_assertion" b
          WHERE b.org_id = o.org_id AND b.artifact_id = o.id
            AND b.assertion_basis = 'binding' AND b.eligibility = 'eligible'
        ) AS is_claimed
      FROM "${schema}"."objects" o
      WHERE o.org_id = ${orgIdPh}
        AND (
          o.type = ${artifactTypePh}
          OR o.type = ANY(${artifactTypeIdsPh}::text[])
          OR EXISTS (
            SELECT 1 FROM "${schema}"."semantic_assertion" b
            WHERE b.org_id = o.org_id AND b.artifact_id = o.id
              AND b.assertion_basis = 'binding' AND b.eligibility = 'eligible'
          )
        )
        AND o.deleted_at IS NULL${dashboardFormExclude}
        AND (${ownership.sql})${projectNarrow}${projectExcludeWhenUnset}
    ),
    pins AS (
      SELECT * FROM unnest(${pinObjectIdsPh}::text[], ${pinRepIdsPh}::text[], ${pinAssertionIdsPh}::text[])
        AS p(object_id, rep_id, assertion_id)
    )
    SELECT
      o.id AS artifact_id,
      o.owner_level,
      o.owner_id,
      o.visibility,
      o.project_id,
      sa.id AS semantic_assertion_id,
      sa.extension,
      r.id AS representation_revision_id,
      r.revision
    FROM visible_objects o
    JOIN "${schema}"."semantic_assertion" sa
      ON sa.org_id = o.org_id AND sa.artifact_id = o.id
    JOIN LATERAL (
      -- Generic artifacts: the latest representation revision (unchanged).
      -- CLAIMED rows: ONLY the snapshot representation pinned at THIS
      -- resolution (cinatra#1430) — no pin, no candidate.
      SELECT rep.id, rep.revision
      FROM "${schema}"."representation" rep
      WHERE rep.org_id = o.org_id AND rep.artifact_id = o.id
        AND (
          (NOT o.is_claimed AND rep.revision = (
            SELECT MAX(r2.revision) FROM "${schema}"."representation" r2
            WHERE r2.org_id = o.org_id AND r2.artifact_id = o.id
          ))
          OR (o.is_claimed AND rep.id = (
            SELECT p.rep_id FROM pins p WHERE p.object_id = o.id LIMIT 1
          ))
        )
      LIMIT 1
    ) r ON true
    WHERE sa.eligibility = 'eligible'
      AND sa.extension = ANY(${acceptedPh}::text[])
      -- A claimed row's context identity is its BINDING assertion — classic
      -- assertions on a claimed row never resolve as candidates
      -- (claimant-isolation; codex round-2 finding) — and specifically the
      -- EXACT binding the snapshot pin was captured under (codex round-3:
      -- a binding transition between capture and resolve yields NO candidate,
      -- never a mixed old-snapshot/new-identity triple).
      AND (NOT o.is_claimed OR (
        sa.assertion_basis = 'binding'
        AND sa.id = (SELECT p.assertion_id FROM pins p WHERE p.object_id = o.id LIMIT 1)
      ))
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
    project_id: string | null;
    semantic_assertion_id: string;
    extension: string;
    representation_revision_id: string;
    revision: number;
  };
  const rows = (res?.rows ?? []) as Row[];

  // Map to refs + derive sourceScope from the canonical columns.
  const refs: ResolvedContextRef[] = rows.map((r) => ({
    artifactId: r.artifact_id,
    representationRevisionId: r.representation_revision_id,
    semanticAssertionId: r.semantic_assertion_id,
    extension: r.extension,
    sourceScope: deriveSourceScope(r.owner_level, r.project_id),
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
