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
  // — new-run creation (#1940 P3, Decision 2): the exemption above is FLIPPED
  //   — both are now guarded inserts (guardedRunWrite, capability run.execute)
  //   into agent_runs (store.ts). Allowlist = the named callers (the full
  //   caller matrix, Decision 2) PLUS the same "opaque store.ts / agents-barrel
  //   accessor" tail already carried on transitionRunStatus/updateAgentRunStatus
  //   above (an opaque `await import(...)` grants the whole module, so those
  //   files sit on every store.ts writer row — intersection, not coincidence).
  {
    module: "packages/agents/src/store.ts",
    exportName: "createAgentRun",
    capability: "run.execute",
    orgIdExtractor: "input.orgId (CreateAgentRunInput; NOT NULL column)",
    storageReferences: ["agent_runs"],
    cascadeOwnership: "inert-history",
    importBanned: true,
    allowedImporters: [
      "packages/agents/src/a2a-actions.ts",
      "packages/agents/src/actions.ts",
      "packages/agents/src/index.ts",
      "packages/agents/src/lifecycle-repair-dispatch-store.ts",
      "packages/agents/src/mcp/agent-tools-registry.ts",
      "packages/agents/src/mcp/handlers.ts",
      "src/lib/a2a-server.ts",
      "src/lib/host-content-editor-dispatch.ts",
      "src/lib/project-dispatch.ts",
      // opaque store.ts / agents-barrel accessors (also on
      // transitionRunStatus/updateAgentRunStatus):
      "src/app/plugins-registry.tsx",
      "src/lib/agent-run-enqueue.ts",
      "src/lib/agent-runtime-dep-projection-backfill.ts",
      "src/lib/extension-edge-bound-agent.ts",
      "src/lib/extension-edge-bound-serving.ts",
    ],
  },
  {
    module: "packages/agents/src/store.ts",
    exportName: "createAgentRunPendingInput",
    capability: "run.execute",
    orgIdExtractor: "input.orgId (NOT NULL column)",
    storageReferences: ["agent_runs"],
    cascadeOwnership: "inert-history",
    importBanned: true,
    allowedImporters: [
      "packages/agents/src/index.ts",
      "packages/agents/src/run-actions.ts",
      "packages/agents/src/trigger-release-job.ts",
      // opaque store.ts / agents-barrel accessors (also on
      // transitionRunStatus/updateAgentRunStatus):
      "src/app/plugins-registry.tsx",
      "src/lib/agent-run-enqueue.ts",
      "src/lib/agent-runtime-dep-projection-backfill.ts",
      "src/lib/extension-edge-bound-agent.ts",
      "src/lib/extension-edge-bound-serving.ts",
    ],
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
    // cinatra#1939 wave 3 Stage D grounding finding: Decision 4 ordered this
    // FIRST in the "blast-radius ascending" conversion sequence, but a live
    // caller sweep found ~30 files importing createSemanticArtifact (blog
    // materializers, lifecycle emit, extension agent-produces-reader,
    // authoring/materialization-ledger, url-import, matcher-enqueue, ...) —
    // by far the LARGEST blast radius of any Stage-D writer, not the
    // smallest. Threading a required authority through every caller in one
    // lane risks correctness regressions across unrelated subsystems.
    // Deferred to its own dedicated wave (recommended: convert per-caller-
    // family, same discipline as the wave-1 dashboards rollout) rather than
    // guessed through in this slice.
    importBanned: false,
    importBanExemption: {
      issue: 1939,
      reason:
        "wave-3 Stage D grounding found ~30 real callers across blog/lifecycle/artifacts/extensions/agents — too large a blast radius for this slice; needs its own per-caller-family conversion wave",
    },
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
  // cinatra#1939 wave 3 Stage D correction: the prior single row named
  // exportName "teamMemberActions" — no such export exists in
  // member-actions.ts. The real writers are the three functions below
  // (addTeamMemberAction / removeTeamMemberAction / updateTeamMemberRoleAction;
  // searchTeamMemberCandidates is read-only). storageReferences corrected to
  // `teamMember` ONLY — the file reads `member`/`user` but never writes them
  // (the prior row's "invitation" reference was also never touched here).
  //
  // NOT converted this stage (registered + exempted, Decision-7 pattern): all
  // three support an authority TIER the org-write kernel's session-authority
  // resolver cannot express — `assertTeamMemberAuthority` admits (a)
  // `platform` (isPlatformAdmin, no org-membership row required) and (b)
  // `team_admin` (team-role admin, whose ORG role may be plain 'member' — the
  // kernel's SESSION_PERMISSION_FOR["membership.write"] maps to
  // organization.manageMembers, which a 'member' role does not hold). Minting
  // via verifySessionAuthority would either throw for a legitimate
  // non-member platform admin or wrongly refuse a legitimate team_admin whose
  // org role is 'member' — a functional regression, not a guard. Needs a
  // design decision (e.g. a new tiered/elevated authority-minting variant)
  // before conversion; flagged here rather than forced.
  {
    module: "src/app/teams/[teamId]/settings/member-actions.ts",
    exportName: "addTeamMemberAction",
    capability: "membership.write",
    orgIdExtractor: "team.organizationId (advisory-locked per team)",
    storageReferences: ["teamMember"],
    cascadeOwnership: "db-cascade",
    importBanned: false,
    importBanExemption: {
      issue: 1939,
      reason:
        "platform-admin/team-admin authority tiers have no sanctioned kernel session-authority mapping — needs a design decision, not a mechanical thread",
    },
  },
  {
    module: "src/app/teams/[teamId]/settings/member-actions.ts",
    exportName: "removeTeamMemberAction",
    capability: "membership.write",
    orgIdExtractor: "team.organizationId (advisory-locked per team)",
    storageReferences: ["teamMember"],
    cascadeOwnership: "db-cascade",
    importBanned: false,
    importBanExemption: {
      issue: 1939,
      reason:
        "platform-admin/team-admin authority tiers have no sanctioned kernel session-authority mapping — needs a design decision, not a mechanical thread",
    },
  },
  {
    module: "src/app/teams/[teamId]/settings/member-actions.ts",
    exportName: "updateTeamMemberRoleAction",
    capability: "membership.write",
    orgIdExtractor: "team.organizationId (advisory-locked per team)",
    storageReferences: ["teamMember"],
    cascadeOwnership: "db-cascade",
    importBanned: false,
    importBanExemption: {
      issue: 1939,
      reason:
        "platform-admin/team-admin authority tiers have no sanctioned kernel session-authority mapping — needs a design decision, not a mechanical thread",
    },
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
    // NOT converted in Stage D — the SAME authority-tier gap as the
    // member-actions rows above, verified concretely: the action's own gate
    // (readTeamCreatableOrganizationsForUser) admits org OWNER + ADMIN roles
    // (and platform admins with any membership), but the kernel's session
    // mapping for membership.write is organization.manageMembers — an
    // org_owner-ONLY permission in authz/policies.ts. Converting would turn a
    // working org-admin team creation into a refusal (a functional
    // regression, not a guard). Same design decision as above.
    importBanned: false,
    importBanExemption: {
      issue: 1939,
      reason:
        "kernel membership.write maps to org_owner-only organization.manageMembers; the action legitimately admits org admins — needs the tiered authority design decision, not a mechanical thread",
    },
  },
  // cinatra#1939 wave 3 Stage D correction: the prior row (exportName
  // "ensureBuiltinAssistantRegistration", capability "membership.write",
  // storageReferences ["member"]) named an export that does not exist, and
  // described a write that does not happen. assistant-agent-registration.ts's
  // real single mint primitive is `registerAssistantAgent` — it writes
  // Better-Auth `public."user"`/`public."oauthClient"` (a GLOBAL platform
  // principal, e.g. the built-in @cinatra/WordPress/Drupal assistants) and a
  // GLOBAL (org_id-less) `agent_templates` row via
  // upsertBuiltInAssistantAgentTemplate — never a `member` row, never scoped
  // to any one organization's lifecycle. It has no org axis for the org-write
  // kernel to guard against, so it is REMOVED from this registry rather than
  // force-fit (a fabricated orgId would be theater, not a real fence). Not an
  // org-write coverage hole: nothing here is an organization-scoped write.

  // — objects canonical history writer (raw-SQL world) —
  // cinatra#1939 wave 3 Stage D correction: the prior single row named
  // exportName "canonicalObjectWriter" — no such export exists in
  // canonical-writer.ts. Per the registry's own "per-function, not
  // per-module" discipline, the real writer surface is the four functions
  // below (historyAwareTombstone delegates entirely to historyAwareSoftDelete
  // with zero DML of its own — a total-ban delegate row, the
  // updateAgentRunStatus precedent). Converted onto the kernel's fixed-batch
  // adapter (buildGuardedOrgWriteBatch + runGuardedOrgWriteBatchSync) — this
  // module runs the postgres-sync raw-SQL world, not a drizzle transaction,
  // so guardOrgMutation's db.transaction() contract does not apply; the S2
  // batch adapter (dark since its own landing) is the sanctioned fit.
  // Allowlist note: src/lib/objects/artifact-row-promotion.ts reaches this
  // module via a NAMESPACE import (`import * as writer`) — an OPAQUE access
  // that grants every binding, so the gate requires it on EVERY row of this
  // module (the transitionRunStatus/updateAgentRunStatus intersection
  // precedent), even though it only calls historyAwareUpsert.
  {
    module: "src/lib/object-history/canonical-writer.ts",
    exportName: "historyAwareUpsert",
    capability: "content.write",
    orgIdExtractor: "actor.orgId (HistoryActor, required — requireGuardOrgId)",
    storageReferences: ["objects", "change_set", "object_change_event", "graphiti_projection_outbox"],
    cascadeOwnership: "inert-history",
    importBanned: true,
    allowedImporters: [
      "src/lib/object-history/restore-engine.ts",
      "src/lib/object-history/merge-proposals.ts",
      "src/lib/objects/artifact-row-promotion.ts",
      "src/lib/object-history/index.ts",
    ],
  },
  {
    module: "src/lib/object-history/canonical-writer.ts",
    exportName: "historyAwareSoftDelete",
    capability: "content.write",
    orgIdExtractor: "actor.orgId (HistoryActor, required — requireGuardOrgId)",
    storageReferences: ["objects", "change_set", "object_change_event", "graphiti_projection_outbox"],
    cascadeOwnership: "inert-history",
    importBanned: true,
    allowedImporters: [
      "src/lib/object-history/restore-engine.ts",
      "src/lib/object-history/index.ts",
      // opaque namespace-import accessor (see module allowlist note above):
      "src/lib/objects/artifact-row-promotion.ts",
    ],
  },
  {
    module: "src/lib/object-history/canonical-writer.ts",
    exportName: "historyAwareUndelete",
    capability: "content.write",
    orgIdExtractor: "actor.orgId (HistoryActor, required — requireGuardOrgId)",
    storageReferences: ["objects", "change_set", "object_change_event", "graphiti_projection_outbox"],
    cascadeOwnership: "inert-history",
    importBanned: true,
    allowedImporters: [
      "src/lib/object-history/restore-engine.ts",
      "src/lib/object-history/index.ts",
      // opaque namespace-import accessor (see module allowlist note above):
      "src/lib/objects/artifact-row-promotion.ts",
    ],
  },
  {
    // Total-delegate: forwards verbatim to historyAwareSoftDelete, zero
    // direct DML sites of its own (the transitionRunStatus/
    // updateAgentRunStatus internal-delegate precedent). No production
    // importer NAMES it in the wave-3 Stage D caller sweep.
    module: "src/lib/object-history/canonical-writer.ts",
    exportName: "historyAwareTombstone",
    capability: "content.write",
    orgIdExtractor: "actor.orgId (HistoryActor, required — requireGuardOrgId)",
    storageReferences: ["objects", "change_set", "object_change_event", "graphiti_projection_outbox"],
    cascadeOwnership: "inert-history",
    writeSites: 0,
    importBanned: true,
    allowedImporters: [
      "src/lib/object-history/index.ts",
      // opaque namespace-import accessor (see module allowlist note above):
      "src/lib/objects/artifact-row-promotion.ts",
    ],
  },
  // — restore engine's OWN batched multi-event write (cinatra#1939 wave 3
  //   Stage D): restoreChangeSet composes its own fixed statement list
  //   (per-event inverse statements) rather than delegating to
  //   historyAwareUpsert et al, so it is its own registered writer. —
  {
    module: "src/lib/object-history/restore-engine.ts",
    exportName: "restoreChangeSet",
    capability: "content.write",
    orgIdExtractor: "input.actor.orgId (required)",
    storageReferences: ["objects", "change_set", "object_change_event", "graphiti_projection_outbox"],
    cascadeOwnership: "inert-history",
    importBanned: true,
    allowedImporters: [
      "src/components/data-safety/restore-change-set-action.ts",
      "src/lib/object-history/index.ts",
      "packages/objects/src/mcp/object-history-handlers.ts",
    ],
  },
  {
    module: "src/lib/object-history/restore-engine.ts",
    exportName: "restoreObjectToVersion",
    capability: "content.write",
    orgIdExtractor: "input.actor.orgId (required)",
    storageReferences: ["objects", "change_set", "object_change_event", "graphiti_projection_outbox"],
    cascadeOwnership: "inert-history",
    importBanned: true,
    allowedImporters: [
      "src/components/data-safety/restore-object-version-action.ts",
      "src/lib/object-history/index.ts",
      "packages/objects/src/mcp/object-history-handlers.ts",
    ],
  },
  // — resource/agent-run project-move cascade (cinatra#1939 wave 3 Stage D,
  //   Decision 9): confirmed a real unregistered content writer during
  //   grounding (2 raw DML sites, resource-project-move.ts) — registered +
  //   converted this stage; the table-sweep baseline shrinks. —
  {
    module: "src/lib/resource-project-move.ts",
    exportName: "runResourceProjectMove",
    capability: "content.write",
    orgIdExtractor: "explicit orgId argument (the moved resource's own org)",
    storageReferences: ["objects", "agent_runs"],
    cascadeOwnership: "inert-history",
    importBanned: true,
    allowedImporters: [
      "packages/agents/src/mcp/handlers.ts",
      "packages/objects/src/mcp/handlers.ts",
    ],
  },
  {
    module: "src/lib/resource-project-move.ts",
    exportName: "runAgentRunMoveWithOutputs",
    capability: "content.write",
    orgIdExtractor: "explicit orgId argument (the run's own org)",
    storageReferences: ["agent_runs", "objects"],
    cascadeOwnership: "inert-history",
    importBanned: true,
    allowedImporters: ["packages/agents/src/mcp/handlers.ts"],
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
    // testing.ts = the kernel's archive-transition harness (#1939 Decision 3):
    // simulateArchiveTransition issues snapshotLeasesQuery verbatim so the
    // harness cannot drift from the real archive tx's lease bookkeeping. The
    // /testing subpath itself is R1-fenced to test files, so this widens the
    // ban to one kernel-internal, test-only consumer — not to production code.
    allowedImporters: [
      "packages/org-write-kernel/src/index.ts",
      "packages/org-write-kernel/src/testing.ts",
    ],
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
