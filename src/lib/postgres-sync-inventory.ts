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
 * counts per file) lives in `docs/architecture/postgres-sync-inventory.json`
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
 * `docs/architecture/postgres-sync-inventory.json` MUST have an entry here, and
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
      "Low-level key/value metadata primitives (extracted from database.ts). Backs boot/settings reads (startup dataset, connector/agent config, LLM provider pins) — cold-path, not per-request hot.",
  },
  "src/lib/drizzle-store.ts": {
    class: "migratable-background-setup",
    justification:
      "Query builders + the schema/DDL bootstrap path. The single remaining call site is build/ensure-schema serialization, not a request-time read.",
  },
  "src/lib/postgres-schema-init.ts": {
    class: "migratable-background-setup",
    justification:
      "Inline DDL + advisory-lock build serialization run once at boot to ensure the schema exists. Boot-time, not request-time.",
  },
  "src/lib/instance-identity-store.ts": {
    class: "migratable-background-setup",
    justification:
      "Reads the single `instance_identity` metadata row (instance namespace + encrypted Verdaccio credentials). Boot/provisioning state, not a per-request hot path.",
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
      "Reads/writes the external-MCP server registry — configuration state mutated on admin/setup paths, read on registry warm-up rather than per request.",
  },

  // --- migratable-request-path: request-time stores/reads, signature is sync ---
  "packages/objects/src/graphiti-projector.ts": {
    class: "migratable-request-path",
    justification:
      "Projects object-graph state at request time. Migratable to the async pooled layer once the objects subsystem's sync signatures are converted (staged).",
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
      "Records skills used during an agent run. Request/run-time write; migratable to async pooled access.",
  },
  "src/lib/artifacts/artifact-creation.ts": {
    class: "migratable-request-path",
    justification:
      "Artifact creation write on request paths. Migratable with the artifacts subsystem.",
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
