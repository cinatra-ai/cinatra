# packages/objects — AGENTS.md

Agent and developer guidance for the `@cinatra-ai/objects` package.

See also: root `AGENTS.md` → `## Graphiti knowledge graph (objects MCP layer)` for setup and behavioural constraints.

## What this package does

Provides the `objects_*` MCP primitives that let agents store and retrieve typed observations. **Postgres is the authoritative source of truth**. Graphiti (Neo4j via `knowledge-graph-mcp`) is a derived, rebuildable temporal knowledge graph used only for semantic/relationship retrieval.

Write path: every write lands in Postgres via an atomic CTE that also creates a `graphiti_projection_outbox` row. A BullMQ repair job (`GRAPHITI_PROJECTION_REPAIR`, 30s interval) projects pending rows to Graphiti asynchronously.

Read path: `objects_get` and `objects_list` (no query) read from Postgres exclusively. `objects_list` with a `query` calls Graphiti `search_nodes` for ranked IDs, then fetches canonical rows from Postgres (authorization boundary).

```
Write: objects_save → upsertObjectAndEnqueue (PG + outbox CTE) → repair worker → addEpisode
Read:  objects_get / objects_list (no query) → Postgres only
       objects_list (with query) → Graphiti (IDs only) → Postgres (canonical rows)
```

## Key files

| File | Purpose |
|---|---|
| `src/lib/objects-store.ts` | Postgres CRUD: `upsertObjectAndEnqueue`, `softDeleteObject`, `getObjectById`, `listObjectsByFilter` |
| `src/lib/drizzle-store.ts` | Inline DDL migrations: projection columns + `graphiti_projection_outbox` table |
| `src/lib/background-jobs.ts` | `GRAPHITI_PROJECTION_REPAIR` job + 30s self-reschedule |
| `src/graphiti-projector.ts` | Outbox worker: `projectObjectToGraphiti`, `processProjectionOutbox` |
| `src/graphiti-client.ts` | Low-level MCP calls to Graphiti (used only by projector). |
| `src/graphiti-types.ts` | Zod schemas for Graphiti tool inputs/outputs. |
| `src/mcp/handlers.ts` | `objects_save`, `objects_get`, `objects_list`, `objects_update`, `objects_delete`, `objects_classify`, `objects_types_list` |
| `src/classifier.ts` | LLM-based object type classification. |
| `src/identity.ts` | Derives stable identity hash from object data. |
| `src/registry.ts` | Static object type registry. |
| `src/auto-registrar.ts` | Registers dynamic types discovered at runtime. |
| `src/objects-client.ts` | `createSessionObjectsClient(actor: ActorContext)` factory for screen use — carries the FULL actor context. RSC pages pass `await requireActorContext()`; system paths build a role-less org-scoped `System` actor. Translation logic lives in `src/objects-actor-envelope.ts`. The bare `objectsClient` singleton remains for sessionless/ALS callers. |

## Episode identity

Graphiti assigns its own UUIDs — we cannot supply them for new episodes. Our stable object ID is derived via `identityHashToUuid(identityHash, groupId)` and stored as `_cinatra.objectId` in `episode_body`. All lookups scan `_cinatra.objectId`, not `episode.uuid`.

## Update and delete pattern

**`objects_update`** merges and persists to Postgres, then enqueues a Graphiti projection via the outbox. The projector **appends a new episode** rather than deleting the old one — preserving Graphiti's temporal trail. Never delete-then-recreate on update.

**`objects_delete`** soft-deletes (`deleted_at`) in Postgres and enqueues a `'delete'` outbox row. The projector calls `deleteEpisode` asynchronously to remove the current episode pointer. Historical extracted facts remain in the graph.

## Atomic outbox CTE pattern

Every object write uses a single-statement CTE so the outbox INSERT only fires when the upsert/update actually wrote a row:

```sql
WITH upserted AS (
  INSERT INTO objects (...) ON CONFLICT DO UPDATE WHERE (org_id guard) RETURNING *
),
outbox_row AS (
  INSERT INTO graphiti_projection_outbox (...) SELECT ... FROM upserted
)
SELECT * FROM upserted
```

**Never split into two separate `runPostgresQueriesSync` calls** — a cross-tenant collision would commit the outbox INSERT even when the upsert was blocked, causing the projector to read another tenant's data.

## Version guard (stale-projection safety)

Two guards prevent stale Graphiti projections from racing:
1. `graphiti-projector.ts` short-circuits before `addEpisode` if `row.version > input.objectVersion`
2. `markProjected` UPDATE includes `WHERE graphiti_projected_version IS NULL OR graphiti_projected_version < $version`

## `_cinatra` metadata block

Every episode carries a `_cinatra` key in its JSON body:

```json
{
  "objectId": "<our stable UUID>",
  "type": "@cinatra-ai/entity-contacts:contact",
  "identityHash": "<sha256-derived>",
  "confidence": 0.95,
  "agentId": "...",
  "runId": "...",
  "source": "ui|worker|agent",
  "userId": "...",
  "deletedAt": null
}
```

## Unclassifiable saves — lossless generic fallback (#1787, epic #1785)

**Types exist only by installation.** `objects_save` never mints a type. When the
classifier cannot place a payload under an installed object type — no match
(`isNewType`), low confidence (`< 0.4`), a dynamic id, or the classifier being
unavailable (thrown / no LLM configured) — the row is still saved **immediately
and losslessly** as a plain `@cinatra-ai/objects:object` object:

- the classifier no longer proposes dynamic-type ids: `classifier/schema.ts`
  rejects any id the caller's catalog does not already know, and
  `classifier/prompt.ts` tells the model to return the generic
  `@cinatra-ai/objects:object` id (with `isNewType: true`) instead of inventing one;
- the persisted `data` is the **original `rawData`**, byte-for-byte — never the
  classifier's `normalizedData` (which may drop fields) and with **no**
  `cinatraAgentRunId` injected;
- identity uses the explicit external id (`external_id` / `externalId`) only, so
  two fallback saves in one run stay two distinct objects while a pair sharing an
  external id still deduplicates — the generic type's run-scoped `identityKey` is
  deliberately bypassed on this path;
- **no** approval / queue / human step gates the write (`ensureDynamicObjectType`
  is not called from `objects_save`).

READ of existing dynamic-typed rows is untouched (durable read semantics live in
the tombstone slice #1789).

### `objects_save` result warning

A fallback save adds a versioned, structured `warning` to the tool result
(absent on a normal matched save). Shape (`ObjectsSaveWarning`, exported from
`mcp/handlers.ts`):

```typescript
{
  version: 1,                              // bump on any breaking shape change
  code: "unclassified_generic_fallback",
  reason: "unmatched" | "low_confidence" | "classifier_unavailable",
  persistedType: "@cinatra-ai/objects:object",
  inferredCategory: string | null,         // classifier's category; null when unavailable
  inferredTypeName: string | null,         // classifier's inferred name; null when unavailable
  message: string,                         // human-readable + remediation pointer
                                           // ("declare it as a kind:\"artifact\" extension type")
}
```

## Dynamic object type registry

`auto-registrar.ts` manages the `dynamic_object_types` Postgres table. The
classifier / `objects_save` write path **no longer mints** here (retired in
#1787 — see the lossless generic fallback above), and the explicit
`objects_type_register` MCP primitive was **removed** (retired in #1790, epic
#1785 slice E — a deliberate external-contract removal); the sole remaining live
writer is agent install. The table itself is torn down later in epic #1785.

### Write model

| Source | Status on insert | Trigger |
|---|---|---|
| ~~`classifier`~~ | ~~`proposed`~~ | **Retired (#1787)** — unclassifiable saves fall back to the generic type instead of minting |
| ~~`mcp`~~ | ~~`active`~~ | **Retired (#1790)** — the `objects_type_register` primitive was removed (deliberate external-contract removal, epic #1785 slice E) |
| `install` | `active` | Agent package imported with `output_object_types` in `agent.json` |

### `ensureDynamicObjectType` — INSERT-ONLY semantics

`ensureDynamicObjectType` always uses `onConflictDoNothing`. It **never upgrades status** on repeated calls. A `proposed` row stays `proposed` even if the same type arrives again via the `install` path. Status transitions are admin-only (approve / archive actions).

```typescript
await ensureDynamicObjectType({
  type: "@cinatra-ai/email-outreach-agent:campaign",
  inferredName: "Campaign",
  inferredCategory: "project",
  canonicalKeys: ["campaignId"],
  source: "install",          // "classifier" | "mcp" | "install" | "admin"
  status: "active",           // "proposed" | "active" | "archived"
  confidence: null,           // "high" | "low" | null  (text, not numeric)
  createdBy: null,            // userId or null for install/system paths
  originContext: {            // arbitrary JSON blob
    agentId: "@cinatra-ai/email-outreach-agent",
  },
});
```

### `approveDynamicObjectType` / `archiveDynamicObjectType`

Admin-only status transitions called from server actions in `screens/object-type-actions.ts`:

```typescript
await approveDynamicObjectType(type);  // proposed → active
await archiveDynamicObjectType(type);  // proposed|active → archived
```

Archive is **display-only** — the DB row is retained for audit history. The classifier may re-propose an archived type; the admin must re-archive if that is undesired.

### `originContext` shape

`originContext` is a free-form `jsonb` column. Callers fill it with whatever provenance is available at the insertion site:

```json
// classifier path
{ "runId": "<uuid>", "objectId": "<uuid>", "source": "classifier" }

// install path (import-agent-core.ts / install-from-package.ts)
{ "agentId": "@cinatra/<slug>" }

// MCP caller path
{ "source": "mcp" }
```

### Sub-path import requirement

> **Critical:** Do NOT import `ensureDynamicObjectType` or `objectTypeRegistry` from the `@cinatra-ai/objects` barrel. The barrel re-exports from `./mcp/handlers` which imports `@cinatra-ai/mcp-server` → `@/lib/mcp-logging` (a host-only Next.js alias). This breaks any non-host consumer (agent-builder vitest, instrumentation.ts, etc.)

Always use the declared sub-path aliases:

```typescript
import { ensureDynamicObjectType } from "@cinatra-ai/objects/auto-registrar";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
```

These aliases are declared in both `tsconfig.json` paths and `packages/agent-builder/vitest.config.ts` aliases.

## Permanent namespace tombstones (cinatra#1789, epic #1785)

The two dynamic-type id prefixes are **permanent tombstones** — a forward WRITE
under either can never happen again:

- `@dynamic/types:` — the reserved dynamic mint scope
- `@cinatra-ai/dynamic:` — the legacy first-party dynamic prefix

**Invariant (PERMANENT):** no artifact-claim manifest, no extension object-type
registration (including a derived `<pkg>:artifact` umbrella id), and no direct
claim-store write may mint, claim, or register a NEW type id under either
prefix. Existing rows keep their ids and both prefixes still classify/read
(`isDynamicObjectTypeId`) — only the forward write surfaces reject. This makes
the "inert legacy label" durable: the namespaces can never come back. Minting
*deletion* is other slices' work (#1787, #1790) and the retirement migration
(#1792) runs on this substrate; this tombstone is the **permanence** guarantee
that keeps those retirements from being undone. The permanent
`@cinatra-ai/...:object` floor claim is a normal namespaced id and is never
matched.

**Single source of truth:** `isTombstonedObjectTypeId` /
`TOMBSTONED_OBJECT_TYPE_ID_PREFIXES` in `src/namespace.ts`. Matching is
**prefix-exact** — a look-alike scope such as `@dynamics/types:x` is NOT
tombstoned (no false positives), while a malformed/empty slug or the derived
`@dynamic/types:artifact` umbrella IS. Two rejection sites cannot import the
namespace module and inline a mirror **pinned byte-equal by test**:

| Write surface | Predicate | Pin test |
|---|---|---|
| Manifest claim validation — `src/claims.ts` `artifactObjectTypeClaimManifestSchema.type` refine (also `parseArtifactObjectTypeClaims`, and via the byte-mirror the semantic-manifest + artifact-handler parse) | `isTombstonedClaimedTypeId` (leaf mirror — claims keeps zero non-zod imports) | `namespace-tombstones.test.ts`, `artifact-objecttypes-claim-schema.test.ts` |
| Extension registration bridge — `src/integration/register-artifact-extensions.ts` `registerParsedArtifactManifest` (umbrella id) + `registerClaimValidators` (per claim) | `isTombstonedObjectTypeId` (namespace) | `artifact-bridge.test.ts` |
| Registry primitive backstop — `src/registry.ts` `objectTypeRegistry.register` (skip + warn) — the UNIVERSAL choke point under every registration path, incl. the SDK `ctx.objects.registerType` provider (`src/lib/register-objects-provider.ts`) | `isTombstonedObjectTypeId` (namespace) | `registry-package-provenance.test.ts` |
| Claim-store write — `src/lib/objects/artifact-claim-store.ts` `reserveArtifactTypeClaim` | `isTombstonedClaimedTypeId` (fail-closed, before the DB) | `artifact-claim-store.test.ts` |
| Edge-bound serving exclusion — `src/lib/extension-edge-bound-serving.ts` `owningPackageOfObjectType` (a dynamic id has NO owning package → never edge-bound) | inlined `DYNAMIC_OBJECT_TYPE_ID_PREFIXES` (host lib cannot import objects — route-graph is shrink-only) | `extension-edge-bound-serving.test.ts` |

## Static object type registry (`register-types.ts`)

`packages/objects/src/integration/register-types.ts` defines and registers all statically-known object types via `registerAllObjectTypes()`. Called once at app startup from `src/lib/mcp-server.ts`.

### `@cinatra-ai/campaigns:context` type

A companion to `:campaign` — the identity key is `cinatra_agent_run_id`, not `campaignId`. Use this type when saving the orchestrator's context object (keyed to the agent run, not to a campaign record).

```typescript
registerObjectType({
  type: "@cinatra-ai/campaigns:context",
  displayName: "Email Outreach Context",
  category: "project",
  identityKey: (d) => d.cinatra_agent_run_id,  // run_id-based identity
});
// contrast with :campaign which uses identityKey: (d) => d.campaignId
```

**Decision:** `:campaign` is retained for backward compat with in-flight runs. New agent runs write a `:context` object and look it up by `run_id`. Do not add `:campaign` writes to new code.

### Registry API

| Method | Purpose |
|--------|---------|
| `objectTypeRegistry.resolve(type)` | Look up a registered type — returns `ObjectTypeDefinition \| undefined`. **NOT `.get()`** |
| `objectTypeRegistry._clearForTests()` | Test cleanup hook — resets all registered types. **NOT `.clear()`** |

### Testing static types

Test files that exercise `register-types.ts` only need to mock `server-only`
(node test runner can't resolve the Next.js shim):

```typescript
vi.mock("server-only", () => ({}));
```

`register-types.ts` no longer imports the CRM entity packages — account /
contact / list object-type registration moved to the `@cinatra-ai/crm-connector`
extension in the Twenty migration, so no sibling-package mocks are required.
Pattern established in `packages/objects/src/integration/__tests__/register-types.test.ts`.

## Artifact-type claim dispositions (`src/claims.ts`)

`src/claims.ts` is the **pure policy leaf** (`@cinatra-ai/objects/claims`, zero React/DB/server imports) for the artifact-type claim system (epic #1424): the status/kind/scope vocabularies, the `claimDispositionsSchema` union, kind-over-scope arbitration, and the dormancy rule. A `kind:"artifact"` extension's `cinatra.artifact.objectTypes[]` entries carry a `dispositions` payload validated by this one schema (imported by both `semantic-manifest.ts` and the extensions handler — only the mirror field line is duplicated, pinned byte-identical by `artifact-objecttypes-claims-mirror.test.ts`). Dispositions persist as `jsonb`, so the payload evolves without a migration.

A disposition carries two orthogonal axes:

- **`projection`** (`raw` | `artifact-safe` | `none`) — the discriminant; governs what a claimed row projects to Graphiti. `projection:"none"` forces `pinnable:false` (nothing to snapshot).
- **`mutability`** (`draftable` | `record` | `external`, cinatra#1449) — OPTIONAL; names how the claimed rows may change. Absent ⇒ the registering type's own `lifecycle.mutableBy` governs unchanged.

### Mutability class semantics (`ARTIFACT_MUTABILITY_CLASSES`)

| Class | Meaning | Effective `mutableBy` ceiling |
|---|---|---|
| `draftable` | cinatra-authored; content edits allowed only while a row is a *draft*, then locked; publishing rides the publication-operation ledger (never rewrites the type into the external entity; no direct draft→published edge) | the type baseline (draft-state-gated) |
| `record` | create-only, self-contained, immutable — any post-create update rejected | `[]` |
| `external` | connector-owned pointer to third-party-canonical content; rows written by connector sync only; never pinnable (pin the snapshot record instead) | `[]` (agent/user) |

This leaf owns the **vocabulary + two pure rules only**:

- The `external ⇒ pinnable:false` invariant, enforced on `claimDispositionsSchema` itself.
- The **baseline-narrowing rule** — a claim's mutability may only NARROW the registering type's `lifecycle.mutableBy`, never widen it. `effectiveMutableBy(mutability, baseline)` returns the narrowed ceiling (always a subset of the baseline); `validateMutabilityNarrowsBaseline(mutability, baseline)` rejects the one widening case (`draftable` over a `mutableBy:[]` immutable type).

The disposition-**enforcing write policy** — trusted transition commands, the `draftable` `draft→scheduled→published` state machine + publish receipts, and the `external` `linked→stale→dangling` reference lifecycle — lives at the object write path and its owners (the publication-operation ledger and the connectorRef external-pointer lifecycle), which CONSUME this vocabulary and these rules. It is intentionally NOT in this leaf.

## Validation

```bash
pnpm typecheck          # fast (tsgo)
pnpm typecheck:slow     # fallback (tsc)
```

Live smoke test (requires `pnpm services` running):

```bash
node /tmp/test-graphiti-crud.mjs
```

## Project Scoping integration

`objects` is the canonical write surface for both raw objects AND artifacts: artifacts are `objects` rows of `SEMANTIC_ARTIFACT_OBJECT_TYPE`; there is NO physical `artifacts` table. The schema includes `objects.project_id text NULL` + composite/partial indexes.

- **Write-time inheritance** — `upsertObject` + `upsertObjectAndEnqueue` read `mcpRequestContextStorage.projectContext.projectId`, propagate to the INSERT unless the type is in `SUBSTRATE_OBJECT_TYPES_NEVER_PROJECT_SCOPED` (CRM + catalog types). Fail-closed for unknown types. Helper: `src/lib/project-inheritance.ts`.
- **Sealed-room re-filter** — `listObjectsByFilter` accepts `projectId?: string|null` and adds `AND project_id = $projectId` at the data layer. Non-bypassable from any handler — including the `ids = ANY(...)` semantic-search candidate path (Graphiti returns from P+Q+ambient → re-filtered to P only).
- **Write-block** — both writers call `assertProjectWritableSync(projectIdForRow)` when the resolved inheritance projectId is non-NULL → archived targets reject at the writer layer.
- **Move** — `objects_update` accepts optional `project_id` change with source+target authz + transactional cascade via `runResourceProjectMove`.
