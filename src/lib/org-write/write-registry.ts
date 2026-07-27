import "server-only";
/**
 * The typed org-write registry — cinatra#1938 (archive epic S2).
 *
 * One row per canonical org-scoped WRITER ENTRY POINT (module + export name —
 * per-function, not per-module, so a new write riding a registered module
 * cannot inherit the wrong classification unseen). Baselined against the
 * LANDED #1894 twin writer (main a77613d0): every dashboards writer's
 * storageReferences include the artifact-substrate tables its twin writes.
 *
 * Fields:
 *   - capability: which kernel capability the writer needs (S3 wires the
 *     guard; this registry is the contract it wires TO);
 *   - orgIdExtractor: where the org axis comes from (human-auditable);
 *   - storageReferences: every table the entry point touches (directly or
 *     via its twin) — the lockstep test pins the dashboards set;
 *   - cascadeOwnership: what happens to this writer's rows on org delete,
 *     mirroring the #1928 taxonomy: "db-cascade" (real FK), "app-furniture"
 *     (deleted by the delete transaction), "block" (counted as a delete
 *     blocker), "inert-history" (retained, harmless).
 */
import type { OrgWriteCapability } from "@cinatra-ai/org-write-kernel";

export type CascadeOwnership =
  | "db-cascade"
  | "app-furniture"
  | "block"
  | "inert-history";

export interface OrgWriteRegistryEntry {
  readonly module: string;
  readonly exportName: string;
  readonly capability: OrgWriteCapability;
  /** Capabilities a writer needs on SOME transitions IN ADDITION to
   *  `capability` — e.g. `transitionRunStatus` is a `run.execute` writer that
   *  additionally needs `run.complete` on its terminal edges (cinatra#1939
   *  wave 2, §3/§5.5). OPTIONAL so existing registry-shape validators and
   *  lockstep readers are unaffected; the capability-completeness audit is the
   *  consumer that reads it. Per-row values land in the writer-conversion
   *  commit. */
  readonly conditionalCapabilities?: readonly OrgWriteCapability[];
  readonly orgIdExtractor: string;
  readonly storageReferences: readonly string[];
  readonly cascadeOwnership: CascadeOwnership;
  /** Drizzle write sites inside THIS function's body (ratcheted by the
   *  lockstep test — a new site inside a registered writer fails until the
   *  row is deliberately updated). Only tracked where the source is scanned. */
  readonly writeSites?: number;
  /** R4 seed: when true, the boundary gate bans importing this entry point
   *  outside its guarded wrapper. ALL FALSE in S2 — the writers are today's
   *  legitimate product path; S3 flips each row as it wires through
   *  guardOrgMutation (banning now would break the app, not protect it). */
  readonly importBanned: boolean;
}

const DASHBOARDS_MODULE = "packages/dashboards/src/mutation-service.ts";

/** Substrate tables every twin "upsert" writes (landed set, #1971): shared
 *  single-CTE objects+outbox builder + resource/representation/audit +
 *  the (no-op for dashboards) binding reconcile. */
const TWIN_UPSERT_TABLES = [
  "resource",
  "objects",
  "graphiti_projection_outbox",
  "representation",
  "artifact_audit",
  "semantic_assertion",
] as const;

/** Twin "delete" set (soft-delete tombstone CTE). */
const TWIN_DELETE_TABLES = [
  "objects",
  "graphiti_projection_outbox",
  "change_set",
  "object_change_event",
  "artifact_audit",
] as const;

function dashboardsWriter(
  exportName: string,
  direct: readonly string[],
  twin: "upsert" | "delete",
  writeSites: number,
): OrgWriteRegistryEntry {
  return {
    module: DASHBOARDS_MODULE,
    exportName,
    capability: "content.write",
    orgIdExtractor: "actor.organizationId (DashboardActor, threaded to every row)",
    storageReferences: [
      ...direct,
      "auditEvents",
      ...(twin === "upsert" ? TWIN_UPSERT_TABLES : TWIN_DELETE_TABLES),
    ],
    cascadeOwnership: "block",
    writeSites,
    importBanned: false,
  };
}

export const ORG_WRITE_REGISTRY: readonly OrgWriteRegistryEntry[] = [
  // — dashboards mutation service (17 writers; all pair with the artifact twin) —
  dashboardsWriter("createDashboard", ["dashboards"], "upsert", 1),
  dashboardsWriter("updateDashboard", ["dashboards"], "upsert", 1),
  dashboardsWriter("publishDashboard", ["dashboards", "dashboardRevisions"], "upsert", 2),
  dashboardsWriter("archiveDashboard", ["dashboards"], "upsert", 1),
  dashboardsWriter("upsertDashboardConfig", ["dashboards"], "upsert", 1),
  dashboardsWriter("ensureOverview", ["dashboards"], "upsert", 1),
  dashboardsWriter("createEntityDashboard", ["dashboards"], "upsert", 1),
  dashboardsWriter("renameDashboard", ["dashboards"], "upsert", 1),
  dashboardsWriter("deleteEntityDashboard", ["dashboards"], "delete", 1),
  dashboardsWriter("materializeExtensionTemplate", ["dashboards"], "upsert", 2),
  dashboardsWriter("materializeExtensionInstanceForProject", ["dashboards"], "upsert", 1),
  dashboardsWriter("archiveExtensionDashboards", ["dashboards"], "upsert", 1),
  dashboardsWriter("restoreExtensionDashboards", ["dashboards"], "upsert", 1),
  dashboardsWriter("adoptExtensionDashboards", ["dashboards"], "upsert", 1),
  dashboardsWriter("upgradeExtensionDashboards", ["dashboards"], "upsert", 3),

  // — the #2006 B1c twin backfill (landed 8215d7c2): pairs pre-twin dashboards
  //   with their artifact twins. Both writers land rows ONLY through the
  //   registered pairTwin forward path (zero direct drizzle write sites), have
  //   no acting principal (actor=null — no auditEvents row), and take the org
  //   axis from each locked dashboards row rather than a DashboardActor —
  //   hence explicit rows, not the dashboardsWriter helper. —
  {
    module: DASHBOARDS_MODULE,
    exportName: "pairOneUntwinnedDashboardTwin",
    capability: "content.write",
    orgIdExtractor:
      "dashboards row (locked FOR UPDATE; org axis copied into twinCtx, actor=null)",
    storageReferences: [...TWIN_UPSERT_TABLES],
    cascadeOwnership: "inert-history",
    writeSites: 0,
    importBanned: false,
  },
  {
    module: DASHBOARDS_MODULE,
    exportName: "backfillDashboardArtifactTwins",
    capability: "content.write",
    orgIdExtractor:
      "per scanned dashboards row (delegates each id to pairOneUntwinnedDashboardTwin)",
    storageReferences: [...TWIN_UPSERT_TABLES],
    cascadeOwnership: "inert-history",
    writeSites: 0,
    importBanned: false,
  },

  // — the host-side twin itself (reached only through pairTwin; registered so
  //   the sweep can attribute its hand-written SQL builders) —
  {
    module: "src/lib/dashboards/dashboard-artifact-twin-writer.ts",
    exportName: "dashboardArtifactTwinWriter",
    capability: "content.write",
    orgIdExtractor: "ctx.orgId (copied verbatim from the dashboards row)",
    storageReferences: [...TWIN_UPSERT_TABLES, ...TWIN_DELETE_TABLES],
    cascadeOwnership: "inert-history",
    importBanned: false,
  },

  // — agent-run lifecycle (canonical CAS entry point + delegated meta writer) —
  {
    module: "packages/agents/src/store.ts",
    exportName: "transitionRunStatus",
    // The writer's DEFINING capability is dispatch (run.execute); terminal edges
    // land a run's outputs and require run.complete (cinatra#1939 wave 2 §3 —
    // per-transition split). conditionalCapabilities exposes the full surface so
    // the capability-completeness audit sees run.complete, not just run.execute.
    capability: "run.execute",
    conditionalCapabilities: ["run.complete"],
    orgIdExtractor: "agent_runs.org_id (authority.orgId; row CAS is org-scoped, NOT NULL)",
    // The terminal-success derivationOutbox branch writes agent_run_output_derivations
    // under the SAME guarded transaction (§1e).
    storageReferences: ["agent_runs", "agent_run_output_derivations"],
    cascadeOwnership: "inert-history",
    importBanned: false,
  },
  {
    module: "packages/agents/src/store.ts",
    exportName: "updateAgentRunStatus",
    // Delegate: runs inside transitionRunStatus's guard on the passed tx; the
    // capability is inherited per-transition (run.complete on terminal edges).
    capability: "run.execute",
    conditionalCapabilities: ["run.complete"],
    orgIdExtractor: "agent_runs.org_id (row-derived)",
    storageReferences: ["agent_runs"],
    cascadeOwnership: "inert-history",
    importBanned: false,
  },
  {
    // The HITL setup-resume CAS (cinatra#1939 wave 2 §7.1): the setup-{runId}
    // approval's inputParams merge + pending_approval->queued flip, run inside
    // the org-write kernel guard. A dispatch edge (pending_approval->queued is
    // non-terminal), so run.execute only — no conditionalCapabilities. The CAS
    // is org-scoped to the authority's org.
    module: "packages/agents/src/resume-run-from-setup-approval.ts",
    exportName: "resumeRunFromSetupApproval",
    capability: "run.execute",
    orgIdExtractor: "agent_runs.org_id (authority.orgId; row CAS is org-scoped, NOT NULL)",
    storageReferences: ["agent_runs"],
    cascadeOwnership: "inert-history",
    importBanned: false,
  },

  // — artifact substrate (postgres-sync world entry point) —
  {
    module: "src/lib/artifacts/artifact-creation.ts",
    exportName: "createSemanticArtifact",
    capability: "content.write",
    orgIdExtractor: "input.orgId (threaded to every batch query)",
    storageReferences: [
      "resource",
      "artifact_blobs",
      "objects",
      "graphiti_projection_outbox",
    ],
    cascadeOwnership: "inert-history",
    importBanned: false,
  },

  // — organization furniture & lifecycle —
  {
    module: "src/lib/organization-delete.ts",
    exportName: "deleteOrganizationReferenceGuarded",
    capability: "org.delete",
    // Pre-activation transitional demand (Decision 1, cinatra#1939 wave 3):
    // until the org_archive_activation gate flips (S6), the rebuilt delete
    // writer (stage C) demands org.lifecycle so active-org delete keeps working;
    // once archiving activates it demands org.delete (active→deny, archived→
    // allow). The S6 closeout removes this fallback.
    conditionalCapabilities: ["org.lifecycle"],
    orgIdExtractor: "explicit orgId argument (owner re-verified in-tx)",
    storageReferences: [
      "organization",
      "member",
      "invitation",
      "session",
      "dashboards",
    ],
    cascadeOwnership: "app-furniture",
    importBanned: false,
  },

  // — better-auth org furniture (public schema; real FK cascades) —
  {
    module: "src/lib/auth.ts",
    exportName: "registrationBootstrapTransaction",
    capability: "membership.write",
    orgIdExtractor: "created organization id (registration gate lock held)",
    storageReferences: ["organization", "member", "session"],
    cascadeOwnership: "db-cascade",
    importBanned: false,
  },
  {
    module: "src/app/teams/[teamId]/settings/member-actions.ts",
    exportName: "teamMemberActions",
    capability: "membership.write",
    orgIdExtractor: "team.organizationId (advisory-locked per team)",
    storageReferences: ["member", "invitation", "teamMember"],
    cascadeOwnership: "db-cascade",
    importBanned: false,
  },
  {
    module: "src/app/teams/new/actions.ts",
    exportName: "createTeamAction",
    capability: "membership.write",
    orgIdExtractor: "session-resolved organization id",
    storageReferences: ["team", "teamMember"],
    // cinatra#1939 wave 3 correction (Decision 5): was "db-cascade", but
    // `team.organizationId` has NO org FK (team is not in DECLARED_ORG_FK_CASCADES)
    // and the org-delete transaction BLOCKS on teams — its rows do not vanish by
    // cascade. Pinned by the cascadeOwnership↔ORG_DELETE_TIME_RULING consistency
    // test (a writer touching a "block" table can never be db-cascade).
    cascadeOwnership: "block",
    importBanned: false,
  },
  {
    module: "src/lib/assistant-agent-registration.ts",
    exportName: "ensureBuiltinAssistantRegistration",
    capability: "membership.write",
    orgIdExtractor: "target organization id (builtin-assistant seed lock)",
    storageReferences: ["member"],
    cascadeOwnership: "db-cascade",
    importBanned: false,
  },

  // — objects canonical history writer (raw-SQL world) —
  {
    module: "src/lib/object-history/canonical-writer.ts",
    exportName: "canonicalObjectWriter",
    capability: "content.write",
    orgIdExtractor: "change-set org_id (threaded per emit)",
    storageReferences: ["objects", "change_set", "object_change_event", "graphiti_projection_outbox"],
    cascadeOwnership: "inert-history",
    importBanned: false,
  },

  // — kernel-owned tables (S2's own entry points) —
  {
    module: "packages/org-write-kernel/src/tickets.ts",
    exportName: "redeemCompletionTicket",
    capability: "run.complete",
    orgIdExtractor: "explicit request.orgId (authority-bound)",
    storageReferences: ["org_write_completion_ticket"],
    cascadeOwnership: "app-furniture",
    importBanned: false,
  },
  {
    module: "packages/org-write-kernel/src/leases.ts",
    exportName: "snapshotLeasesQuery",
    capability: "org.lifecycle",
    orgIdExtractor: "explicit input.orgId (archive transaction only)",
    storageReferences: ["org_archive_lease", "agent_runs"],
    cascadeOwnership: "app-furniture",
    importBanned: false,
  },
];

/** Declared org-axis columns WITHOUT database FKs (block-if-referenced or
 *  history semantics — reconciled by the lockstep test against the DDL, and
 *  by the CI-tier integration test against live pg_constraint). `as const`
 *  (cinatra#1939 wave 3) so `ORG_DELETE_TIME_RULING` can be COMPILE-total over
 *  the exact reference set — values byte-identical to the prior array. */
export const DECLARED_FKLESS_ORG_REFERENCES = [
  "dashboards.organization_id",
  "installed_extension.organization_id",
  "agent_templates.org_id",
  "projects.organization_id",
  "agent_runs.org_id",
  "objects.org_id",
  "resource.org_id",
  "artifact_blobs.org_id",
  "change_set.org_id",
  "object_change_event.org_id",
  "org_archive_lease.org_id",
  "org_write_completion_ticket.org_id",
] as const;

/** The three REAL org FKs (all ON DELETE CASCADE), verbatim from the DDL. */
export const DECLARED_ORG_FK_CASCADES = [
  "connector_access_policy.org_id",
  "role_grant.org_id",
  "project_access.principal_org_id",
] as const;

// ---------------------------------------------------------------------------
// Delete-time rulings — cinatra#1939 wave 3 (Decision 5).
//
// The org-delete transaction's blocker inventory is REBASELINED from this
// registry instead of a hand-coded list: EVERY declared org-axis reference
// carries an explicit delete-time ruling, so adding a 13th FK-less reference
// without a ruling is a COMPILE error (the total Record below), and
// `organization-delete.ts` DERIVES its blocker COUNT queries + kernel-table
// furniture DELETEs from this single source (plus the explicit BA public-table
// section for organization/member/invitation/session/team, which live outside
// the app-schema declared lists).
// ---------------------------------------------------------------------------

/** The union of every declared org-axis reference (FK-less + real-FK). */
export type DeclaredOrgReference =
  | (typeof DECLARED_FKLESS_ORG_REFERENCES)[number]
  | (typeof DECLARED_ORG_FK_CASCADES)[number];

/** The `OrganizationDeleteBlockers` field a "block" ruling feeds. `teams` is a
 *  Better-Auth public table (not a declared app-schema reference; ruled in the
 *  BA section) so it is deliberately NOT a value here. Kept in lockstep with
 *  `OrganizationDeleteBlockers` by organization-delete.ts's own tests. */
export type OrgDeleteBlockerKey =
  | "activeProjects"
  | "installedExtensions"
  | "dashboards"
  | "agents"
  | "liveAgentRuns";

export type DeleteRulingKind = "block" | "furniture" | "inert-history" | "db-cascade";

/** What happens to a declared reference's rows when its organization is deleted. */
export type DeleteRuling =
  | {
      readonly kind: "block";
      /** app-schema table (unquoted; the delete module quotes it). */
      readonly table: string;
      /** primary org-axis column on `table`. */
      readonly orgColumn: string;
      /** static predicate narrowing WHICH rows block (e.g. `is_default = false`,
       *  `archived_at IS NULL`); omitted = every org row blocks. */
      readonly blockWhere?: string;
      /** also match rows scoped via `origin->>'scope' = 'org:'||<orgId>` — the
       *  one compound org axis (agent_templates). */
      readonly alsoOriginScope?: boolean;
      /** block only NON-TERMINAL agent runs; the delete module builds the
       *  `status NOT IN (...)` set from the agents run-status single source
       *  (TERMINAL_RUN_STATUSES), pinned by a lockstep test. */
      readonly nonTerminalRunsOnly?: boolean;
      readonly blockerKey: OrgDeleteBlockerKey;
      readonly note: string;
    }
  | {
      readonly kind: "furniture";
      readonly table: string;
      readonly orgColumn: string;
      readonly note: string;
    }
  | { readonly kind: "inert-history"; readonly note: string }
  | { readonly kind: "db-cascade"; readonly note: string };

/** The compile-total delete-time ruling for EVERY declared reference. */
export const ORG_DELETE_TIME_RULING: Record<DeclaredOrgReference, DeleteRuling> = {
  "dashboards.organization_id": {
    kind: "block",
    table: "dashboards",
    orgColumn: "organization_id",
    blockWhere: "is_default = false",
    blockerKey: "dashboards",
    note: "non-default dashboards block; the entity-anchored default Overview rows are furniture (deleted in-tx)",
  },
  "installed_extension.organization_id": {
    kind: "block",
    table: "installed_extension",
    orgColumn: "organization_id",
    blockerKey: "installedExtensions",
    note: "ALL installed extension kinds block (#1939 tightening — was connectors-only; every kind has its own uninstall surface)",
  },
  "agent_templates.org_id": {
    kind: "block",
    table: "agent_templates",
    orgColumn: "org_id",
    alsoOriginScope: true,
    blockerKey: "agents",
    note: "org-owned (org_id) or org-scoped (origin.scope) agent templates block",
  },
  "projects.organization_id": {
    kind: "block",
    table: "projects",
    orgColumn: "organization_id",
    blockWhere: "archived_at IS NULL",
    blockerKey: "activeProjects",
    note: "active projects block; archived project rows are inert history (retained)",
  },
  "agent_runs.org_id": {
    kind: "block",
    table: "agent_runs",
    orgColumn: "org_id",
    nonTerminalRunsOnly: true,
    blockerKey: "liveAgentRuns",
    note: "NON-TERMINAL runs block (#1939 new blocker — status NOT IN the canonical terminal set); terminal runs are inert history",
  },
  "objects.org_id": {
    kind: "inert-history",
    note: "#1928 canonical object history — retained, unreachable once the org is gone",
  },
  "resource.org_id": {
    kind: "inert-history",
    note: "artifact substrate history — retained",
  },
  "artifact_blobs.org_id": {
    kind: "inert-history",
    note: "artifact blob history — retained",
  },
  "change_set.org_id": {
    kind: "inert-history",
    note: "object change-set history — retained",
  },
  "object_change_event.org_id": {
    kind: "inert-history",
    note: "object change-event history — retained",
  },
  "org_archive_lease.org_id": {
    kind: "furniture",
    table: "org_archive_lease",
    orgColumn: "org_id",
    note: "kernel lease rows die with the org (new furniture #1939)",
  },
  "org_write_completion_ticket.org_id": {
    kind: "furniture",
    table: "org_write_completion_ticket",
    orgColumn: "org_id",
    note: "kernel completion tickets die with the org (new furniture #1939)",
  },
  "connector_access_policy.org_id": {
    kind: "db-cascade",
    note: "real FK ON DELETE CASCADE — the row dies with the org automatically",
  },
  "role_grant.org_id": {
    kind: "db-cascade",
    note: "real FK ON DELETE CASCADE — the row dies with the org automatically",
  },
  "project_access.principal_org_id": {
    kind: "db-cascade",
    note: "real FK ON DELETE CASCADE — the row dies with the org automatically",
  },
};

/** Delete-time ruling of the Better-Auth public-schema tables the delete
 *  transaction handles DIRECTLY (outside the app-schema declared references).
 *  `team` BLOCKS (each team has its own delete surface — unchanged #1510
 *  doctrine); membership rows are furniture (deleted / NULL-repointed in-tx);
 *  `teamMember` rides its team's FK. Feeds the cascadeOwnership consistency
 *  pin (a writer touching a "block" table can never be `db-cascade`). */
export const BA_PUBLIC_TABLE_DELETE_RULING: Record<string, DeleteRulingKind> = {
  organization: "furniture",
  member: "furniture",
  invitation: "furniture",
  session: "furniture",
  team: "block",
  teamMember: "db-cascade",
};

/** Every table (app-schema declared + BA public) whose org-delete ruling is
 *  "block": its rows do NOT vanish by FK on org delete — they block. A writer
 *  touching one of these can therefore never be classified `db-cascade` (the
 *  createTeamAction misclassification this pins against). */
export function orgDeleteBlockTables(): ReadonlySet<string> {
  const tables = new Set<string>();
  for (const ruling of Object.values(ORG_DELETE_TIME_RULING)) {
    if (ruling.kind === "block") tables.add(ruling.table);
  }
  for (const [table, kind] of Object.entries(BA_PUBLIC_TABLE_DELETE_RULING)) {
    if (kind === "block") tables.add(table);
  }
  return tables;
}
