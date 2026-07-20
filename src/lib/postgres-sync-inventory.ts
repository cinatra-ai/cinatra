/**
 * Postgres sync-bridge caller inventory — classification + justification (#303).
 *
 * The synchronous Postgres bridge (`runPostgresQueriesSync` — a worker thread
 * driven by `Atomics.wait`, 30s prod timeout) was the historical default for
 * ALL request-time persistence. The architecture track (#303) makes
 * it the *exceptional sync-leaf escape hatch*: request-time stores move to the
 * async pooled-DB layer (`@/lib/db/pooled`), and every remaining direct sync
 * caller must be justified here.
 *
 * This is the HAND-AUTHORED side. The machine-generated scan (call sites + call
 * counts per file) lives in `config/postgres-sync-inventory.json`
 * (built by `scripts/build-postgres-sync-inventory.mjs`). The inventory ratchet test
 * (`src/lib/__tests__/postgres-sync-inventory.test.ts`) asserts the two stay in
 * lockstep AND that the per-file call count never GROWS — i.e. no NEW direct
 * sync call site is added to any path (existing or brand-new) without an
 * explicit, reviewed classification + baseline bump here.
 *
 * Classes
 * -------
 *  - `sync-required`: the call site is reached from a SYNCHRONOUS context (no
 *     `await` available) OR is a security-critical instant-decision path where
 *     converting to async would introduce a TOCTOU window. These stay on the
 *     bridge by design.
 *  - `migratable-request-path`: a request-time store/read that COULD move to the
 *     async pooled layer; the public API is currently synchronous so the
 *     conversion (signature → async, callers → await) is a follow-up, staged,
 *     per-store PR (security-critical stores serialized + extra-reviewed).
 *  - `migratable-background-setup`: boot / settings / dev / cold-path state. Not
 *     a per-request hot path; lowest-urgency migration.
 */

export type SyncCallerClass =
  | "sync-required"
  | "migratable-request-path"
  | "migratable-background-setup";

export type SyncCallerClassification = {
  class: SyncCallerClass;
  justification: string;
};

/**
 * Per-file classification keyed by repo-relative path. Every file emitted into
 * `config/postgres-sync-inventory.json` MUST have an entry here, and
 * vice-versa (the ratchet guard asserts both directions).
 */
export const SYNC_CALLER_CLASSIFICATIONS: Record<string, SyncCallerClassification> = {
  // --- sync-required: security-critical instant-decision / synchronous-context ---
  "packages/extensions/src/permissions-store.ts": {
    class: "sync-required",
    justification:
      "Extension co-owner / access-policy reads gate authorization decisions. A permission denial must be instant and free of a TOCTOU window; the security-critical conversion is deferred and serialized per the #303 track design.",
  },
  "packages/notifications/src/service.ts": {
    class: "sync-required",
    justification:
      "Notification fan-out/dedup is driven through host-injected synchronous adapters; recipients are resolved at write time against authz scope tables. Kept sync-required until the notifications subsystem migrates as a unit.",
  },
  "packages/notifications/src/recipient-policy.ts": {
    class: "sync-required",
    justification:
      "Recipient resolution reads better-auth user rows + scope tables to decide who is notified — an authorization-adjacent fan-out. Migrated together with notifications/service.ts, not piecemeal.",
  },
  "src/lib/connector-access-resolver.ts": {
    class: "sync-required",
    justification:
      "enforceConnectorPolicy is invoked from synchronous contexts (e.g. the connectors-list Array.filter). There is no async seam to await here; the resolver must read the installed-extension row + access policy + co-owners synchronously.",
  },
  "src/lib/connector-policy-store.ts": {
    class: "sync-required",
    justification:
      "Thin storage layer behind the synchronous connector-access-resolver; its reads/writes participate in the same synchronous enforcement path.",
  },
  "src/lib/widget-user-auth.ts": {
    class: "sync-required",
    justification:
      "Widget user-auth validates connect-site credentials + origin on the embed auth path; a synchronous, instant decision with no TOCTOU window. Security-critical — deferred and serialized.",
  },
  "src/lib/widget-token-broker.ts": {
    class: "sync-required",
    justification:
      "Mints/validates short-lived widget stream tokens (timing-safe compares). Security-critical token broker; kept synchronous to avoid a validation TOCTOU window.",
  },

  // --- migratable-background-setup: boot / settings / dev / cold paths ---
  "src/lib/database.ts": {
    class: "migratable-background-setup",
    justification:
      "Higher-level core-store surface (startup dataset, skill/agent catalog, chat threads, connector/agent config). Boot + settings state read on cold paths, not a per-request hot store. The low-level metadata primitives were extracted to database-metadata.ts; the remaining surface migrates as the core-store async conversion lands.",
  },
  "src/lib/database-metadata.ts": {
    class: "migratable-background-setup",
    justification:
      "Low-level key/value metadata primitives (extracted from database.ts). Backs boot/settings reads (startup dataset, connector/agent config, LLM provider pins) — cold-path, not per-request hot. cinatra#1364 adds the skills-catalog split primitives: the fenced catalog batch read (cache-miss only — the generation-token-keyed cache absorbs steady-state reads), the lease INSERT-IF-ABSENT bootstrap, and the guarded completeness-fence upsert (both rebuild-lifecycle-only).",
  },
  "src/lib/drizzle-store.ts": {
    class: "migratable-background-setup",
    justification:
      "Query builders + the schema/DDL bootstrap path. The single remaining call site is build/ensure-schema serialization, not a request-time read.",
  },
  "src/lib/execution/environment-layer-store.pg.ts": {
    class: "migratable-background-setup",
    justification:
      "Durable Postgres store behind the EnvironmentLayerCache (exec-plane S3 A2/A3, cinatra#1708). Its reads/writes run on the build / retention-GC / lifecycle-reference cold paths (a later process reusing an earlier layer build; the GC reap), never a per-request hot store. Migrates with the exec-plane store async conversion.",
  },
  "src/lib/postgres-schema-init.ts": {
    class: "migratable-background-setup",
    justification:
      "Inline DDL + advisory-lock build serialization run once at boot to ensure the schema exists. Boot-time, not request-time.",
  },
  "src/lib/boot/phases/schema-version-precondition.ts": {
    class: "migratable-background-setup",
    justification:
      "Reads the core migration ledger ONCE at boot (cinatra#789 item 4) to assert the DB schema is not behind the image before required-extension activation. Boot-time precondition, never a per-request path.",
  },
  "src/lib/boot/phases/artifact-data-root-guard.ts": {
    class: "migratable-background-setup",
    justification:
      "Probes artifact_blobs existence ONCE at boot (cinatra#926 stranded-bytes guard) to warn on a mis-pointed artifact data root. Boot-time, read-only, never a per-request path.",
  },
  "src/lib/artifacts/artifact-blob-verifier.ts": {
    class: "migratable-background-setup",
    justification:
      "Admin/script-invoked DB↔blob verifier (cinatra#926): one artifact_blobs row scan per report run. Operator cold path, never boot-blocking, never a per-request path.",
  },
  "src/lib/instance-identity-store.ts": {
    class: "migratable-background-setup",
    justification:
      "Reads the single `instance_identity` metadata row (instance namespace + encrypted Verdaccio credentials). Boot/provisioning state, not a per-request hot path.",
  },
  "src/lib/demo-seed-runner.ts": {
    class: "migratable-background-setup",
    justification:
      "Demo-mode one-shot seed gate (#1238): reads admin-existence + claims the monolithic demo seed via an ON-CONFLICT metadata write (the exactly-once guarantee is the ON-CONFLICT SQL, not sync execution). Runs only on the boot phase in the demo install profile (isDemoProfile), never on a per-request path; kept on the sync bridge because it executes in the synchronous boot phase.",
  },
  "src/lib/dev-auto-setup.ts": {
    class: "migratable-background-setup",
    justification:
      "Dev-only auto-setup; gated on CINATRA_RUNTIME_MODE===development, fire-and-forget on boot. Never on a production request path.",
  },
  "src/lib/dev-fixture-seeder.ts": {
    class: "migratable-background-setup",
    justification:
      "Dev-only extension fixture seeder; dev-boot, fire-and-forget, soft-fail. Never on a production request path.",
  },
  "src/lib/email-system-persistence.ts": {
    class: "migratable-background-setup",
    justification:
      "Persists email-system configuration (settings state). Configured on cold/admin paths, not per-request.",
  },
  "src/lib/external-mcp-registry.ts": {
    class: "migratable-background-setup",
    justification:
      "Reads/writes the external-MCP server registry — configuration state mutated on admin/setup paths, read on registry warm-up rather than per request. The TOCTOU-safe helpers (cinatra#658) add a cache-bypassing fresh-read and atomic compare-and-write/strict-insert call sites used by the admin/setup write actions; these are deliberately direct (not cached) so the authorization read and the guarded mutation observe the same row.",
  },

  // --- migratable-request-path: request-time stores/reads, signature is sync ---
  "src/lib/chat-thread-store.ts": {
    class: "migratable-request-path",
    justification:
      "Tenant-scoped by-id reads of the legacy chat_threads JSON sync table (thread payload + team-org membership) that gate the authenticated chat read/write routes. Follows the same synchronous sync-table access pattern as the other chat_threads readers in database.ts; migrates to async typed reads when the legacy JSON sync tables are converted.",
  },
  "src/lib/assistant-thread-mirror-backfill.ts": {
    class: "migratable-request-path",
    justification:
      "One-shot boot backfill (cinatra#1218, #1216 S2): mirrors DORMANT legacy chat_threads rows into the structured assistant_threads/assistant_turns shadow via the P2b pure builders. Runs from a retryable boot phase (never request-time); uses the sync leaf primitives because it composes the same per-thread transactional mirror queries the legacy write path spreads into its transaction. Deleted with the legacy tables at the S2 delete stage.",
  },
  "src/lib/assistant-thread-store.ts": {
    class: "migratable-request-path",
    justification:
      "Structured assistant_threads / assistant_turns store (cinatra#1037 P2a). Built as a sync leaf mirroring chat-thread-store.ts's synchronous sync-table access pattern (runPostgresQueriesSync via the postgres-sync leaf primitives) so it composes into the synchronous store graph. It is the forward replacement for chat-thread-store and, like it, migrates to async typed reads when the sync-table access pattern is converted; the request-path wiring (the /api/chat persistence subroutes + chat_thread_send) lands in P2b. P5.5 adds one call site: the per-actor visibility-predicate list read (listAssistantThreadsForOrgVisibleTo) backing the assistant_thread_list MCP tool — same class, same table, same migration path.",
  },
  "src/lib/chat-capture/ledger.ts": {
    class: "migratable-request-path",
    justification:
      "Chat-capture turn-ledger DB primitives (cinatra#1367): the durable idempotency + provenance + quota record (one row per thread_id/turn_id) that keeps the background chat-capture detection job idempotent across retries and worker crashes. Built as a sync leaf mirroring skill-lifecycle-store.ts's synchronous sync-table access pattern (runPostgresQueriesSync via the postgres-sync leaf) so it composes into the synchronous store graph; job-triggered (never the request cycle), migratable to async pooled access with the chat-capture subsystem.",
  },
  "packages/objects/src/graphiti-projector.ts": {
    class: "migratable-request-path",
    justification:
      "Projects object-graph state at request time. Migratable to the async pooled layer once the objects subsystem's sync signatures are converted (staged).",
  },
  "packages/objects/src/graphiti-projection-policy.ts": {
    class: "migratable-request-path",
    justification:
      "Per-group projection-policy epoch reads/bumps (cinatra#1427 AC-4), a sync leaf composing with graphiti-projector's synchronous store graph. Migrates with the objects subsystem.",
  },
  "packages/objects/src/graphiti-rebuild.ts": {
    class: "migratable-request-path",
    justification:
      "Epoch-fenced group-rebuild driver (cinatra#1427 ACs 4-5): journal phase machine + checkpointed replay batches, same sync-leaf pattern as graphiti-projector. Migrates with the objects subsystem.",
  },
  "packages/objects/src/mcp/handlers.ts": {
    class: "migratable-request-path",
    justification:
      "Objects MCP primitive handler reads object state per tool call. Migrates with the objects subsystem.",
  },
  "packages/skills/src/skills-store.ts": {
    class: "migratable-request-path",
    justification:
      "Skills catalog store read on request paths. Migratable; converted with the skills subsystem.",
  },
  "src/lib/objects/effective-identity.ts": {
    class: "migratable-request-path",
    justification:
      "Effective-identity resolver host half (cinatra#1426): batched semantic_assertion + installed_extension reads feeding the pure truth-table leaf, consumed by the artifact service's sync list/get enrichment. Built as a sync leaf mirroring artifact-claim-store.ts's pattern so it composes into the synchronous store graph; migrates to async typed reads with the objects subsystem.",
  },
  "src/lib/objects/presentation-identity.ts": {
    class: "migratable-request-path",
    justification:
      "Presentation-identity resolver host half (cinatra#1888, epic #1883 A6): one batched semantic_assertion read (active eligible + drafts, archived excluded) feeding the pure tier machine, consumed by the artifact service's SAME sync list/get/detail enrichment as effective-identity.ts (listArtifacts/getArtifact/readArtifactForDetail are synchronous). Built as a sync leaf mirroring effective-identity.ts's synchronous sync-table access pattern so it composes into the synchronous store graph, and fails closed to base identity on read error; migrates to async typed reads together with its effective-identity twin when the objects subsystem is converted.",
  },
  "src/lib/objects/artifact-claim-store.ts": {
    class: "migratable-request-path",
    justification:
      "Artifact-claim registry DB primitives (cinatra#1425): reserve/activate/retire claim transitions (advisory-locked, CTE-atomic with their claim events + reconcile-queue rows) plus the org scope-chain reads the effective-type-catalog resolver consumes. Built as a sync leaf mirroring skill-lifecycle-store.ts's pattern so it composes into the synchronous store graph; migrates to async typed writes with the objects subsystem.",
  },
  "src/lib/objects/artifact-promotion-request-store.ts": {
    class: "migratable-request-path",
    justification:
      "Artifact row-scope promotion-request store (cinatra#1437, epic #1424): the pending requests to WIDEN one artifact row's visibility through the shared approvals surface — create (partial-unique one-pending guard), the Inbox list/count reads, and the CAS-guarded decide/supersede/compensate transitions (business decisions returned as VALUES via rowCount, never a throw). Request-time store mirroring the agent_creation_request store idiom and artifact-claim-store.ts's synchronous sync-table access pattern (runPostgresQueriesSync via the postgres-sync leaf) so it composes into the synchronous store graph; migrates to async typed writes with the objects subsystem.",
  },
  "src/lib/objects/artifact-uninstall-operations.ts": {
    class: "migratable-background-setup",
    justification:
      "Artifact-extension uninstall-operation store (cinatra#1432): the checkpointed, per-artifact advisory-locked archival of an uninstalled extension's eligible assertions under an operation record, plus the reinstall replay that INSERTs replacement classic assertions for the archived classic subset. A COLD administrative batch path driven by extension uninstall/reinstall lifecycle transitions (not a request-time store); built as a sync leaf mirroring artifact-claim-store.ts so it composes into the synchronous store graph. Migrates to async typed writes with the objects subsystem.",
  },
  "src/lib/objects/binding-write-path.ts": {
    class: "migratable-request-path",
    justification:
      "Binding-assertion write path (cinatra#1429): the per-artifact advisory-locked reconcile that resolves the live dedicated claim winner in SQL and archives/inserts the artifact's binding assertion. Composed into the object write tx (upsert → reconcile, one held-lock tx) and driven standalone by the reconcile-queue consumer + backfill. Built as a sync leaf mirroring artifact-claim-store.ts so it composes into the synchronous store graph; migrates to async typed writes with the objects subsystem.",
  },
  "src/lib/objects/binding-reconcile-sweep.ts": {
    class: "migratable-background-setup",
    justification:
      "Binding reconcile sweep + queue consumer + enrollment backfill (cinatra#1429): a COLD administrative batch path (checkpointed, resumable) that pages a claimed type's object rows and reconciles each binding, plus the drain of the claim registry's winner-change reconcile queue. cinatra#1433 adds the guarded per-row default-coverage floor reconcile (one guard SELECT + a conditional advisory-locked rebalance tx) to the same cold sweep/drain. Driven by claim lifecycle transitions + enrollment, not a request-time store; sync leaf composing into the synchronous store graph. Migrates with the objects subsystem.",
  },
  "src/lib/objects/claim-activation-gate.ts": {
    class: "migratable-background-setup",
    justification:
      "Per-claim activation gate (cinatra#1429): the pre-activation legacy-row audit that quarantines rows failing registered-Zod validation, plus the quarantine read/write helpers and the active-dedicated-claim probe the write path enforces against. A COLD administrative path driven by claim activation (audit sweep) with a request-time probe on the enforced write path; sync leaf composing into the synchronous store graph. Migrates with the objects subsystem.",
  },
  "src/lib/skill-lifecycle-store.ts": {
    class: "migratable-request-path",
    justification:
      "Skill-lifecycle DB write primitives (cinatra#1361): records an immutable skill_revisions row on the custom/personal upsertSkill write path and applies the audited lifecycle-state compare-and-swap transition. Built as a sync leaf mirroring skills-store.ts's synchronous sync-table access pattern (runPostgresQueriesSync via the postgres-sync leaf) so it composes into the synchronous store graph; migrates to async typed writes with the skills subsystem.",
  },
  "packages/skills/src/llm-matching/skill-matches-store.ts": {
    class: "migratable-request-path",
    justification:
      "LLM skill-match results store touched on matching request paths. Migratable to async pooled access.",
  },
  "packages/skills/src/llm-matching/batch-runs-store.ts": {
    class: "migratable-request-path",
    justification:
      "LLM matching batch-run ledger. Request/job-triggered; migratable to async pooled access.",
  },
  "packages/skills/src/llm-matching/schedule-store.ts": {
    class: "migratable-request-path",
    justification:
      "LLM matching schedule store. Migratable to async pooled access.",
  },
  "src/lib/agent-creation-requests-store.ts": {
    class: "migratable-request-path",
    justification:
      "Agent-creation request ledger read/written on request paths. Migratable; sync signatures converted in a staged store PR.",
  },
  "src/lib/agent-run-skills-used.ts": {
    class: "migratable-request-path",
    justification:
      "Records skills used during an agent run — snapshot, exposure telemetry, and per-invocation counting (cinatra#1368). Request/run-time write; migratable to async pooled access.",
  },
  "src/lib/skill-efficacy.ts": {
    class: "migratable-request-path",
    justification:
      "Skill efficacy read model (cinatra#1368): the per-skill exposure/invocation rollup join for the skills-admin view plus the admin deprecation-candidate dismiss/reinstate writes. Admin request-time reads/writes; migratable to async pooled access.",
  },
  "src/lib/artifacts/artifact-creation.ts": {
    class: "migratable-request-path",
    justification:
      "Artifact creation write on request paths. Migratable with the artifacts subsystem.",
  },
  "src/lib/artifacts/local-disk-blob-store.ts": {
    class: "migratable-request-path",
    justification:
      "cinatra#926 fail-soft guards on blob request paths: the reachability probe before a content-addressed file delete (fail-safe keeps the file on error) and the optional org-quota usage read at put() (skipped unless the env knob is set). Migratable with the artifacts subsystem.",
  },
  "src/lib/artifacts/artifact-read.ts": {
    class: "migratable-request-path",
    justification:
      "Artifact read on request paths. Migratable with the artifacts subsystem.",
  },
  "src/lib/artifacts/artifact-refs-store.ts": {
    class: "migratable-request-path",
    justification:
      "Artifact-reference store touched on chat/save request paths. Migratable to async pooled access.",
  },
  "src/lib/artifacts/artifact-retention.ts": {
    class: "migratable-request-path",
    justification:
      "Artifact retention bookkeeping on request paths. Migratable with the artifacts subsystem.",
  },
  "src/lib/artifacts/authoring-recursion-ledger.ts": {
    class: "migratable-request-path",
    justification:
      "Authoring-recursion guard ledger on request paths. Migratable to async pooled access.",
  },
  "src/lib/artifacts/context-mcp.ts": {
    class: "migratable-request-path",
    justification:
      "Artifact context MCP read per tool call. Migratable with the artifacts subsystem.",
  },
  "src/lib/artifacts/context-resolver.ts": {
    class: "migratable-request-path",
    justification:
      "Resolves artifact context at request time. Migratable to async pooled access.",
  },
  "src/lib/artifacts/matcher-runtime.ts": {
    class: "migratable-request-path",
    justification:
      "Artifact matcher runtime reads on request paths. Migratable with the artifacts subsystem.",
  },
  "src/lib/artifacts/producer-assertions.ts": {
    class: "migratable-request-path",
    justification:
      "Producer-assertion reads on request paths. Migratable to async pooled access.",
  },
  "src/lib/artifacts/provider-file-cache.ts": {
    class: "migratable-request-path",
    justification:
      "Provider file cache touched on request paths. Migratable to async pooled access.",
  },
  "src/lib/artifacts/representation-store.ts": {
    class: "migratable-request-path",
    justification:
      "Artifact representation revisions store on request paths. Migratable to async pooled access.",
  },
  "src/lib/artifacts/resource-store.ts": {
    class: "migratable-request-path",
    justification:
      "Artifact resource store on request paths. Migratable to async pooled access.",
  },
  "src/lib/artifacts/run-context-selections-store.ts": {
    class: "migratable-request-path",
    justification:
      "Append-only run-context selection audit written by the context-agent at request time. Migratable to async pooled access; pre-flight coherence reads convert together with the writer.",
  },
  "src/lib/artifacts/object-content-snapshot.ts": {
    class: "migratable-request-path",
    justification:
      "Policy-aware content snapshots for claimed typed object rows (cinatra#1430): captures an immutable JSON snapshot of a typed row's normalized data at resolution time as a representation revision over a blob resource, keyed for reuse in object_content_snapshots. Composed at context-resolution request time; the write branch runs under a per-artifact advisory-locked transaction (re-read under the lock). Sync leaf mirroring representation-store/resource-store so it composes into the synchronous store graph; migratable to async pooled access with the artifacts subsystem.",
  },
  "src/lib/artifacts/context-selection-finalize.ts": {
    class: "migratable-request-path",
    justification:
      "Context-selection finalization (cinatra#1430): one transaction that re-validates the selection triple's coherence in SQL, appends the run_context_selections audit row, and writes a real artifact_refs retention pin — all under the SAME resource-level advisory lock the resource GC takes, closing the pin-vs-GC race. Request-time (context-agent) finalization; sync leaf composing into the synchronous store graph; migratable to async pooled access with the artifacts subsystem.",
  },
  "src/lib/artifacts/semantic-assertion-store.ts": {
    class: "migratable-request-path",
    justification:
      "Semantic-assertion (artifact classification) store on request paths. Migratable to async pooled access.",
  },
  "src/lib/assistant-profiles.ts": {
    class: "migratable-request-path",
    justification:
      "Assistant-profile store read on request paths. Migratable to async pooled access.",
  },
  "src/lib/connect-sites-store.ts": {
    class: "migratable-request-path",
    justification:
      "Connect-site registry read on embed/request paths. Migratable to async pooled access (the security-critical widget validators that consume it stay sync-required for now).",
  },
  "src/lib/object-history/canonical-writer.ts": {
    class: "migratable-request-path",
    justification:
      "Writes canonical object-history rows on request paths. Migratable with the object-history subsystem.",
  },
  "src/lib/object-history/change-set.ts": {
    class: "migratable-request-path",
    justification:
      "Object-history change-set reads/writes on request paths. Migratable with the object-history subsystem.",
  },
  "src/lib/object-history/cms-state-machine.ts": {
    class: "migratable-request-path",
    justification:
      "CMS state-machine transitions on request paths. Migratable with the object-history subsystem.",
  },
  "src/lib/object-history/eligibility.ts": {
    class: "migratable-request-path",
    justification:
      "Object-history eligibility reads on request paths. Migratable with the object-history subsystem.",
  },
  "src/lib/object-history/merge-proposals.ts": {
    class: "migratable-request-path",
    justification:
      "Merge-proposal reads/writes on request paths. Migratable with the object-history subsystem.",
  },
  "src/lib/object-history/restore-engine.ts": {
    class: "migratable-request-path",
    justification:
      "Object-history restore engine reads on request paths. Migratable with the object-history subsystem.",
  },
  "src/lib/object-history/server-views.ts": {
    class: "migratable-request-path",
    justification:
      "Server-side object-history view reads on request paths. Migratable with the object-history subsystem.",
  },
  "src/lib/objects-store.ts": {
    class: "migratable-request-path",
    justification:
      "Core objects store read/written heavily on request paths. Highest-volume migration target for the staged async conversion.",
  },
  "src/lib/project-writable.ts": {
    class: "migratable-request-path",
    justification:
      "Resolves project-writable state on request paths. Migratable to async pooled access.",
  },
  "src/lib/resource-project-move.ts": {
    class: "migratable-request-path",
    justification:
      "Moves resources between projects on request paths. Migratable to async pooled access.",
  },
  "src/lib/trigger-email-send-use-cases.ts": {
    class: "migratable-request-path",
    justification:
      "Trigger email-send use-case reads on request paths. Migratable to async pooled access.",
  },
  "src/lib/webhook-outbound-deadletter.server.ts": {
    class: "migratable-request-path",
    justification:
      "Outbound-webhook dead-letter store touched on the outbound engine request/job path. Migratable to async pooled access.",
  },
};
