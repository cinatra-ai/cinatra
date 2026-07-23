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
  // — dashboards mutation service (15 writers; all pair with the artifact twin) —
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
    capability: "run.execute",
    orgIdExtractor: "agent_runs.org_id (row-derived; NOT NULL)",
    storageReferences: ["agent_runs"],
    cascadeOwnership: "inert-history",
    importBanned: false,
  },
  {
    module: "packages/agents/src/store.ts",
    exportName: "updateAgentRunStatus",
    capability: "run.execute",
    orgIdExtractor: "agent_runs.org_id (row-derived)",
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
    capability: "org.lifecycle",
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
    cascadeOwnership: "db-cascade",
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
 *  by the CI-tier integration test against live pg_constraint). */
export const DECLARED_FKLESS_ORG_REFERENCES: readonly string[] = [
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
];

/** The three REAL org FKs (all ON DELETE CASCADE), verbatim from the DDL. */
export const DECLARED_ORG_FK_CASCADES: readonly string[] = [
  "connector_access_policy.org_id",
  "role_grant.org_id",
  "project_access.principal_org_id",
];
