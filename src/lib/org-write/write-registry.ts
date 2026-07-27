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

/** R4 exceptions ledger (cinatra#1939 wave 3, Decision 4): a registry row may
 *  stay `importBanned:false` ONLY if it carries an issue-linked exemption. The
 *  wave-6 default-on coverage proof asserts every row is `importBanned:true` OR
 *  carries one of these — "zero unguarded write exports OUTSIDE the approved,
 *  issue-linked exception ledger". */
export interface ImportBanExemption {
  /** The tracking issue that will flip this row (never a bare "TODO"). */
  readonly issue: number;
  readonly reason: string;
}

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
  /** R4 (cinatra#1939 wave 3, Decision 4): when true, the boundary gate
   *  (scripts/audit/org-write-boundary-gate.mjs) bans importing this writer
   *  entry point outside `allowedImporters`. Flipped per-writer as each converts
   *  through the guard (wave-1/2 pattern); a row may only remain false with an
   *  `importBanExemption`. */
  readonly importBanned: boolean;
  /** R4: when `importBanned`, the ONLY files (repo-relative) allowed to import
   *  this writer — the enumerated legitimate callers + any sanctioned re-export
   *  barrel at flip time (mechanically derived from the gate's `--r4-report`,
   *  reviewed once). Empty = total ban (an internal delegate with no import
   *  edges). A NEW importer becomes a deliberate, reviewed registry edit rather
   *  than silent drift. Omitted when `importBanned:false`. */
  readonly allowedImporters?: readonly string[];
  /** R4 exceptions ledger — present ONLY on `importBanned:false` rows that are a
   *  known, tracked hole (Decision 4). */
  readonly importBanExemption?: ImportBanExemption;
}

/** The R4 flip payload for a registry row: banned-with-allowlist, or
 *  unbanned-with-optional-exemption. Keeps the two invariants structural. */
type ImportBanSpec =
  | { readonly importBanned: true; readonly allowedImporters: readonly string[] }
  | { readonly importBanned: false; readonly importBanExemption?: ImportBanExemption };

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

// The `ban` argument is a LITERAL object at every call site — the boundary gate
// statically reads it as `dashboardsWriter`'s 5th argument (Decision 4). Keep it
// literal or the gate fails closed.
function dashboardsWriter(
  exportName: string,
  direct: readonly string[],
  twin: "upsert" | "delete",
  writeSites: number,
  ban: ImportBanSpec,
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
    ...ban,
  };
}

export const ORG_WRITE_REGISTRY: readonly OrgWriteRegistryEntry[] = [
  // — dashboards mutation service (17 writers; all pair with the artifact twin).
  //   R4 (wave 3, Stage A): the 12 writers whose callers are all in-repo are
  //   import-banned to their enumerated callers; the 3 extension-materializer
  //   writers stay unbanned under the #1939 exception ledger because their
  //   callers live in the workflows-extension repo and thread authority when the
  //   extension wave converts (all 15 already demand a DashboardActor). —
  dashboardsWriter("createDashboard", ["dashboards"], "upsert", 1, {
    importBanned: true,
    allowedImporters: ["packages/dashboards/src/mcp/handlers.ts"],
  }),
  dashboardsWriter("updateDashboard", ["dashboards"], "upsert", 1, {
    importBanned: true,
    allowedImporters: [
      "packages/dashboards/src/actions.ts",
      "packages/dashboards/src/mcp/handlers.ts",
      "packages/dashboards/src/screens/organization-detail-actions.ts",
    ],
  }),
  dashboardsWriter("publishDashboard", ["dashboards", "dashboardRevisions"], "upsert", 2, {
    importBanned: true,
    allowedImporters: ["packages/dashboards/src/mcp/handlers.ts"],
  }),
  dashboardsWriter("archiveDashboard", ["dashboards"], "upsert", 1, {
    importBanned: true,
    allowedImporters: ["packages/dashboards/src/mcp/handlers.ts"],
  }),
  dashboardsWriter("upsertDashboardConfig", ["dashboards"], "upsert", 1, {
    importBanned: true,
    allowedImporters: ["packages/dashboards/src/actions.ts"],
  }),
  dashboardsWriter("ensureOverview", ["dashboards"], "upsert", 1, {
    importBanned: true,
    allowedImporters: [
      "packages/dashboards/src/actions.ts",
      "packages/dashboards/src/screens/organization-detail-actions.ts",
    ],
  }),
  dashboardsWriter("createEntityDashboard", ["dashboards"], "upsert", 1, {
    importBanned: true,
    allowedImporters: [
      "packages/dashboards/src/actions.ts",
      "packages/dashboards/src/screens/organization-detail-actions.ts",
    ],
  }),
  dashboardsWriter("renameDashboard", ["dashboards"], "upsert", 1, {
    importBanned: true,
    allowedImporters: [
      "packages/dashboards/src/actions.ts",
      "packages/dashboards/src/screens/organization-detail-actions.ts",
    ],
  }),
  dashboardsWriter("deleteEntityDashboard", ["dashboards"], "delete", 1, {
    importBanned: true,
    allowedImporters: [
      "packages/dashboards/src/actions.ts",
      "packages/dashboards/src/screens/organization-detail-actions.ts",
    ],
  }),
  dashboardsWriter("materializeExtensionTemplate", ["dashboards"], "upsert", 2, {
    importBanned: false,
    importBanExemption: {
      issue: 1939,
      reason: "callers live in the workflows-extension repo; converts with the extension wave",
    },
  }),
  dashboardsWriter("materializeExtensionInstanceForProject", ["dashboards"], "upsert", 1, {
    importBanned: false,
    importBanExemption: {
      issue: 1939,
      reason: "callers live in the workflows-extension repo; converts with the extension wave",
    },
  }),
  dashboardsWriter("archiveExtensionDashboards", ["dashboards"], "upsert", 1, {
    importBanned: true,
    allowedImporters: [
      "packages/dashboards/src/extension-materialization.ts",
      "src/lib/dashboards/extension-dashboard-lifecycle.ts",
    ],
  }),
  dashboardsWriter("restoreExtensionDashboards", ["dashboards"], "upsert", 1, {
    importBanned: true,
    allowedImporters: [
      "packages/dashboards/src/extension-materialization.ts",
      "src/lib/dashboards/extension-dashboard-lifecycle.ts",
    ],
  }),
  dashboardsWriter("adoptExtensionDashboards", ["dashboards"], "upsert", 1, {
    importBanned: true,
    allowedImporters: [
      "packages/dashboards/src/extension-materialization.ts",
      "src/lib/dashboards/reconcile-contribution-adoptions.ts",
    ],
  }),
  dashboardsWriter("upgradeExtensionDashboards", ["dashboards"], "upsert", 3, {
    importBanned: false,
    importBanExemption: {
      issue: 1939,
      reason: "callers live in the workflows-extension repo; converts with the extension wave",
    },
  }),

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
    // Reached ONLY internally via backfillDashboardArtifactTwins' sweep (module-
    // internal use is not an import edge) — no file imports it. Total ban.
    importBanned: true,
    allowedImporters: [],
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
    importBanned: true,
    allowedImporters: [
      "packages/dashboards/src/twin-backfill.ts",
      "src/lib/boot/phases/core-boot.ts",
    ],
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
    // Reached through the pairTwin forward path; core-boot registers the writer
    // (the ONLY sanctioned import). Any other importer is a violation.
    importBanned: true,
    allowedImporters: ["src/lib/boot/phases/core-boot.ts"],
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
    // module = store.ts (the registered path: ./store and @cinatra-ai/agents both
    // re-export from run-transition.ts). Allowlist = the named callers PLUS the
    // files that OPAQUELY reach store.ts / the agents barrel via a
    // non-destructured `await import(...)` — those grant the whole module, so the
    // gate requires them on BOTH run-writer rows (intersection). The last five
    // entries are those opaque accessors; the rest name transitionRunStatus.
    importBanned: true,
    allowedImporters: [
      "packages/agents/src/actions.ts",
      "packages/agents/src/execution.ts",
      "packages/agents/src/index.ts",
      "packages/agents/src/mcp/handlers.ts",
      "packages/agents/src/orchestrator-actions.ts",
      "packages/agents/src/orchestrator-execution.ts",
      "packages/agents/src/run-actions.ts",
      "packages/agents/src/trigger-release-job.ts",
      "packages/agents/src/trigger-service.ts",
      "src/lib/host-content-editor-dispatch.ts",
      // opaque store.ts / agents-barrel accessors (also on updateAgentRunStatus):
      "src/app/plugins-registry.tsx",
      "src/lib/agent-run-enqueue.ts",
      "src/lib/agent-runtime-dep-projection-backfill.ts",
      "src/lib/extension-edge-bound-agent.ts",
      "src/lib/extension-edge-bound-serving.ts",
    ],
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
    // Internal delegate — the only NAMED import edge is the agents barrel
    // re-export (index.ts); no functional caller names it. The remaining entries
    // are the opaque store.ts / agents-barrel accessors: an opaque import grants
    // this delegate too, so the gate requires those files on BOTH run-writer
    // rows (intersection) — they are identical to transitionRunStatus's tail.
    importBanned: true,
    allowedImporters: [
      "packages/agents/src/index.ts",
      "src/app/plugins-registry.tsx",
      "src/lib/agent-run-enqueue.ts",
      "src/lib/agent-runtime-dep-projection-backfill.ts",
      "src/lib/extension-edge-bound-agent.ts",
      "src/lib/extension-edge-bound-serving.ts",
    ],
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
    importBanned: true,
    allowedImporters: ["packages/agents/src/review-task-actions.ts"],
  },
  // — new-run creation (Decision 7): both are plain drizzle inserts into
  //   agent_runs (in store.ts), still OUTSIDE the guard. Comment wording avoids
  //   the literal DML call shape — the OBO-ceiling structural scanner greps for
  //   it and must keep seeing store.ts as the sole inserter. Registered NOW so
  //   the coverage ledger KNOWS the hole;
  //   #1940's dispatch freeze converts new-run creation and flips these rows.
  //   The wave-6 proof reads "zero unguarded write exports OUTSIDE the approved,
  //   issue-linked exception ledger" — these two are that linked remainder. —
  {
    module: "packages/agents/src/store.ts",
    exportName: "createAgentRun",
    capability: "run.execute",
    orgIdExtractor: "input.orgId (CreateAgentRunInput; NOT NULL column)",
    storageReferences: ["agent_runs"],
    cascadeOwnership: "inert-history",
    importBanned: false,
    importBanExemption: {
      issue: 1940,
      reason: "dispatch freeze converts new-run creation",
    },
  },
  {
    module: "packages/agents/src/store.ts",
    exportName: "createAgentRunPendingInput",
    capability: "run.execute",
    orgIdExtractor: "input.orgId (NOT NULL column)",
    storageReferences: ["agent_runs"],
    cascadeOwnership: "inert-history",
    importBanned: false,
    importBanExemption: {
      issue: 1940,
      reason: "dispatch freeze converts new-run creation",
    },
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
    // Kernel entry point; importable only via the package root (R1 bans deep
    // subpaths). The index barrel re-export is its sole current import edge; any
    // consumer would resolve through it and be caught.
    importBanned: true,
    allowedImporters: ["packages/org-write-kernel/src/index.ts"],
  },
  {
    module: "packages/org-write-kernel/src/leases.ts",
    exportName: "snapshotLeasesQuery",
    capability: "org.lifecycle",
    orgIdExtractor: "explicit input.orgId (archive transaction only)",
    storageReferences: ["org_archive_lease", "agent_runs"],
    cascadeOwnership: "app-furniture",
    importBanned: true,
    allowedImporters: ["packages/org-write-kernel/src/index.ts"],
  },
  {
    // cinatra#1940 P1 (Decision 4): the per-run, epoch-agnostic lease SETTLE
    // folded into transitionRunStatus's terminal transaction (status + meta +
    // derivation + LEASE DELETE in one guarded commit). capability is
    // `run.complete` — the terminal-edge capability the fold already runs under.
    // VOCAB-CLEAN by design: `run.lease-expire` (the finalizer's capability) is
    // P2's vocab addition and the `conditionalCapabilities:["run.lease-expire"]`
    // annotation + the finalizer-module import allowlist are added by P4 — this
    // P1 row references ONLY existing vocabulary. importBanned stays `false` in
    // step with every S2 row and its sibling `snapshotLeasesQuery`: the R4
    // boundary gate (wave-3 stage A — not yet on main; adds `allowedImporters`)
    // is what flips it `true` + records the run-transition.ts allowlist, per the
    // "the ban flips per-writer" convention the lockstep test pins.
    module: "packages/org-write-kernel/src/leases.ts",
    exportName: "settleLeaseForRunStatement",
    capability: "run.complete",
    orgIdExtractor: "explicit input.orgId (per-run terminal settle; the caller's guarded org)",
    storageReferences: ["org_archive_lease"],
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
