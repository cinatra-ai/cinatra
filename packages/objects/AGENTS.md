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

## Unclassifiable saves — FAIL-CLOSED (owner ruling 2026-07-18; epic cinatra#1785)

**Types exist only by installation.** `objects_save` never mints a type, and — as
of the entry-95 correction — never *falls back* to a catch-all type either. When
the classifier cannot place a payload under a type an installed artifact
extension **defines** — no match (`isNewType`), low confidence (`< 0.4`), a
dynamic/tombstoned id, the retired generic `@cinatra-ai/objects:object` id, a
resolved type that is not in the live registry, or the classifier being
unavailable (thrown / no LLM configured) — the save is **REFUSED at the write
boundary**. This reverses the #1787 "lossless generic fallback": there is no
untyped/catch-all object persistence any more.

- the classifier still runs (it is how a save is matched to an installed type)
  and still never proposes dynamic-type ids (`classifier/{prompt,schema}.ts`);
- a save persists **only** on a confident match to a type that `objectTypeRegistry`
  resolves (an installed extension registered it) — the fail-closed registry
  check refuses even a "confident" classification whose type is unregistered;
- the refused payload is **never** persisted (the handler throws before the
  upsert); the run's structured error is ordinary run history, not an object row;
- **no** warning-store / quarantine / dead-letter / approval / queue path exists.

READ of existing rows is untouched (durable read semantics live in the tombstone
slice #1789); historical retired-type rows are removed by the #1792 purge.

### `objects_save` refusal error

A refused save throws a `PrimitiveInvocationError` (from `@cinatra-ai/mcp-client`);
`normalizePrimitiveError` preserves its `code`/`details` onto the run's tool
result. Shape:

```typescript
{
  code: "OBJECTS_TYPE_NOT_REGISTERED",       // stable machine-readable code
  message: 'no installed artifact extension defines "<type>"'
           + ' [; install <extension>]',     // ratified wording; the install hint
                                              // is appended ONLY when a concrete,
                                              // currently-uninstalled definer is known
  retryable: false,
  details: { attemptedType: string | null,   // the type named / classified, or null
             suggestedExtension?: string },   // present with the install hint only
}
```

## Dynamic object type registry — REMOVED (engine teardown, epic #1785 entry 95, #1793)

The dynamic-types **engine is gone**. `auto-registrar.ts` (the module that
managed the `dynamic_object_types` Postgres table and the ensure/approve/archive
mutators), the table itself (dropped by migration `core__0060`), the
`objects_type_register` MCP primitive (retired #1790), the Types & approvals
admin UI, and the object-type lifecycle server actions were all removed. There is
no runtime-discovered / minted type any longer: **a type exists ONLY as an
explicit definition by an installed `kind:artifact` extension.**

The `objects_save` write path **fail-closes** — an unclassifiable, dynamic,
tombstoned, generic, low-confidence, or unregistered save is REFUSED with the
stable `OBJECTS_TYPE_NOT_REGISTERED` error (see the FAIL-CLOSED section above),
never minted or fallback-persisted. Typed agent output is the fail-closed
`cinatra.produces` manifest contract backed by required artifact-kind claims (see
`@cinatra-ai/agents` AGENTS.md).

The two dynamic namespaces (`@dynamic/types:` and the legacy
`@cinatra-ai/dynamic:`) survive **only** as the READ / tombstone-rejection
predicate `isDynamicObjectTypeId` (`namespace.ts`) — existing rows keep their ids
and both prefixes still classify/read, while every forward WRITE surface rejects
them (see the tombstone section below). The `mintDynamicObjectTypeId` helper was
deleted with the engine — no path can create a new dynamic-type id.

### Sub-path import requirement

> **Critical:** Do NOT import `objectTypeRegistry` from the `@cinatra-ai/objects`
> barrel. The barrel re-exports from `./mcp/handlers` which imports
> `@cinatra-ai/mcp-server` → `@/lib/mcp-logging` (a host-only Next.js alias). This
> breaks any non-host consumer (agent-builder vitest, instrumentation.ts, etc.)

Always use the declared sub-path alias:

```typescript
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
```

This alias is declared in both `tsconfig.json` paths and
`packages/agent-builder/vitest.config.ts` aliases.

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
- **Explicit binding (external callers)** — `objects_save` accepts optional `projectId` for a caller with no ambient frame. See the section below.

## External memory writers — the `objects_save` actor contract (cinatra#1377, epic #1373)

The agent-memory sync path writes from **outside** any agent run: a coding agent's
`memory` CLI holds no `mcpRequestContextStorage.projectContext` frame, because that
frame only exists inside a run/chat execution on this host. Such a caller reaches
`objects_save` over the **authenticated MCP transport** — not the in-process
deterministic client, which is a same-process convenience for host code.

**Identity is transport-derived, never caller-supplied.**

| Axis | Source | Caller-supplied? |
|---|---|---|
| `orgId` | actor / request frame (`getActorExt`) | **never** — no primitive accepts it |
| user / agent identity | the authenticated actor | **never** |
| `runId`, `agentId`, package versions | actor provenance (`actorExt`) | **never** |
| `ownerLevel` / `ownerId` / `visibility` | `deriveSaveDefaults` (user ⇒ `user`/`private`; system ⇒ `organization`/`organization`; an `agent_run` delegation derives from its OBO ceiling) | optional override, re-authorized by the `object.create` probe |
| `projectId` | ambient frame, or the explicit input below | optional, authorized against the caller's own `projectGrants` |

**Ownership defaults are unchanged.** A write defaults to user/private. An explicit
wider tuple is only ever accepted **within the caller's own authorization** — the
`object.create` probe runs against the projected row, so the scope ceiling denies
anything the actor cannot satisfy. Widening beyond that is promotion, not a save.

**`projectId` precedence** (keyed on presence — JSON carries all three states):

| Input | Behavior |
|---|---|
| omitted | ambient inheritance (frame `projectId`, substrate exclusion applied); on a collision with a row bound to another project, refused — see collision semantics |
| `null` | no project (substrate write); the ambient frame is **ignored, not consulted** |
| `"<id>"` | bind the row to that project; the ambient frame is **ignored, not consulted** |

The explicit path never reads the frame, so it works from outside a run **and** a
stray ambient frame cannot bleed into an explicitly-scoped write.

**A supplied id is a request, never a grant.** The handler runs, in order:
`assertProjectReadAccess` (404-hides a project the caller holds no grant on, so the
gate is not an existence oracle), then `assertProjectWritable(…, "write")`
(existence + the archive gate + the write role tier). An unresolved `projectGrants`
axis counts as no grants in both helpers — the gate fails closed. Postgres row
authorization is unchanged and remains the data-access boundary.

The axis itself reaches the actor from the transport: `packages/objects/src/mcp/registry.ts`
resolves it through `resolveActorGrantsForUserInOrg` for the **same** `userId`/`orgId`
pair the request frame carries (the in-process session client carries it on the
`ActorContext` instead — `actorContextToObjectsEnvelope`). A frame with no identity
pair, or a failed resolution, leaves the axis unresolved, which both gates read as no
grants.

**Collision semantics.** Identity resolution can steer a save onto an existing row
(the upsert's `ON CONFLICT` arm). Then:

- the row is additionally probed for `object.update` against its **stored** scope —
  the create probe alone would authorize a write to a row the caller cannot touch;
- ownership/visibility are **preserved** (the `ON CONFLICT` arm does not list
  `owner_level` / `owner_id` / `visibility`), so a default-scoped user/private save
  can never narrow a wider row. A request for a *different* tuple is **refused**
  rather than accepted-and-silently-dropped;
- an explicit `projectId` that differs from the row's current project is
  **refused** with a pointer to `objects_update`'s move path, which carries the
  move authorization and the `resource_project_moves` audit row;
- an *omitted* `projectId` requests nothing, but the writer's preserve arm is
  `COALESCE(EXCLUDED.project_id, objects.project_id)` — a resolved ambient
  project overwrites rather than preserves. So a save inside a frame for project
  P that lands on a row already bound to project **Q** is **refused** with the
  same code and the same remedy: it would take the row out of Q's sealed room
  with no authorization on Q and no audit row. Two ambient cases are **not**
  refused, and both leave the row inside every room it was already in: a frame
  that resolves to no project (no frame, or a substrate type) preserves the
  tag, and an **untagged** row still inherits the active frame — the documented
  write-time inheritance, which is purely additive;
- a collision onto a **soft-deleted** row is **refused**. `upsertObjectAndEnqueue`'s
  `ON CONFLICT` arm never clears `deleted_at` (only the canonical twin writer
  does), so the write would rewrite the row, bump its version and emit the outbox
  and change events while every ordinary read still could not see it — a success
  reported over a write that lands nowhere visible. `objects_save` does not
  undelete.

### Refusal codes

All five are `PrimitiveInvocationError`s, same contract as
`OBJECTS_TYPE_NOT_REGISTERED` above (`retryable: false`; `code`/`details` preserved
onto the run's tool result by `normalizePrimitiveError`).

| Code | Raised when |
|---|---|
| `OBJECTS_SUBSTRATE_TYPE_NOT_PROJECT_SCOPED` | an explicit binding names a pan-project substrate type (CRM / catalog); dropping it silently would misreport where the row landed |
| `OBJECTS_COLLISION_PROJECT_MOVE_REQUIRED` | the save resolves to an existing row whose project differs from the requested `projectId`, or (no `projectId` supplied) from the project the active frame resolves to while the row is bound to another one |
| `OBJECTS_COLLISION_SCOPE_CHANGE_REJECTED` | the save resolves to an existing row and requests a different `ownerLevel` / `ownerId` / `visibility` |
| `OBJECTS_COLLISION_ROW_DELETED` | the save resolves to a soft-deleted row, which this writer would rewrite without undeleting |
| `OBJECTS_WRITE_PRECONDITION_FAILED` | the writer's armed `collisionGuard` blocked the `DO UPDATE` arm and nothing was written |

`OBJECTS_WRITE_PRECONDITION_FAILED` is what makes the collision probe **binding
rather than advisory**. The probe and the write are separate statements, so the
handler arms `upsertObjectAndEnqueue`'s `collisionGuard` with the exact row state it
authorized (`expectedVersion` + `expectedProjectId`; a `null` version means "the
probe saw no row", which blocks the `DO UPDATE` arm outright).

The code and its message are **cause-neutral on purpose**. Two predicates block that
arm — the collision guard and the cross-tenant `org_id` guard — and they produce the
same empty result. Nothing outside the failed statement can tell them apart: a later
re-read answers about a newer snapshot than the one that blocked the write. So neither
the code nor its message names a cause; both state only what is certain, that the
precondition did not hold and nothing was written.

It is **terminal** for the same reason. Neither cause permits replaying the invocation
under the authorization it already carries. A caller that wants to try again re-reads
the row and re-authorizes against what is actually there, which is a fresh save rather
than a retry. Auto-retrying a write whose authorization could not be confirmed is the
thing the guard exists to prevent.

An unauthorized binding is **not** in this table: it throws the canonical
`AuthzError` (404-hidden / 403) from the project gates, so the refusal envelope is
the same one every other project-scoped surface produces.

**Deterministic-client parity.** `createDeterministicObjectsClient().save()` accepts
`ownerLevel` / `ownerId` / `visibility` / `projectId` and passes them through
unchanged. The in-process client is **not** a privileged path: it invokes the same
handler and therefore the same gates.

## Memory sync — the ingest gates and the preflight (cinatra#1378, epic #1373)

`memory sync` is the one-way bridge from a local `.memory` bundle into memory rows.
The client classifies and scans before it uploads, and **none of that decides
anything**: a bundle is untrusted input end-to-end, so every rule below runs on the
server, on the same seam that produces the persisted payload.

**Ingest gates** (`enforceMemoryConceptEnvelope`, `packages/objects/src/mcp/handlers.ts`),
in order, before any commit:

1. the registered envelope schema — including the **server's own recomputation** of
   `externalId` as `sha256(bundleId + NUL + conceptId)`; a mismatch is rejected, so a
   forged field cannot steer which row a save lands on;
2. **size caps on every author-controlled surface** — `bodyMarkdown` 64 KiB (#1376),
   `frontmatter` 32 KiB serialized, `links` 512 entries, one link target 2 KiB,
   `conceptId` and each `resolvedConceptId` 1 KiB, `okfVersion` 64 B, and the
   **serialized envelope 512 KiB in aggregate**. An uncapped surface would make the
   body cap decorative, because the same payload just moves into frontmatter — and
   an uncapped surface added LATER would do it again, which is what the aggregate
   cap is for. The schema is `.strict()` at the top level, so an unknown key is a
   rejection rather than an unscanned, uncapped passenger; the handler splits the
   server-injected keys off before parsing and merges them back afterwards
   (`MEMORY_SERVER_INJECTED_KEYS`), which is what lets strictness fall only on what
   the client sent;
3. a **fail-closed secret scan** over the whole object about to be written, minus
   the identity fields excluded by name (`MEMORY_SCAN_EXCLUDED_KEYS`:
   `externalId`, `bundleId`, `cinatraAgentRunId`) — object **keys included**,
   because `{ "<a real token>": "note" }` hides a credential exactly as well as a
   value does. The polarity matters: enumerating the fields to SCAN left every
   field added later unscanned by default, so the scan enumerates what it SKIPS.
   The detector applies placeholder tolerance **per token** (a `${VAR}` somewhere
   in a body does not un-scan the body), scores opaque tokens with an
   **alphabet-aware** normalized entropy rule (a 4.5-bits-per-character rule is
   structurally unreachable for hex, so hex-encoded keys rode through), and carries
   explicit shapes for a **PEM private-key block**, a **password in a connection
   URL's userinfo**, and a **standard-base64 run** (the token splitter consumes
   `/`, so such a key arrived as fragments too short to score). Measured through
   the whole detector: 100% on 64-hex, 97.6% on a 40-character standard-base64
   key, 96.7% on 43-character base64url, 83.6% on 64-character standard base64
   — measured numbers, not a claim of coverage. A hex DIGEST in a body is
   flagged too: it is the same shape as a hex key and nothing in the string
   separates them, so the gate resolves that ambiguity fail-closed. Both
   directions refuse: a credential-shaped literal (`OBJECTS_MEMORY_SECRET_DETECTED`)
   and a scan that could not **complete** (`OBJECTS_MEMORY_SECRET_SCAN_FAILED`) —
   "could not look" must never produce the same answer as "looked and found
   nothing". Both refusals name the SHAPE and the location, never the matched text.
   The location is echo-safe for the same reason: it is built from keys, so a key
   is rendered verbatim only when it is a short ordinary identifier the detector
   itself does not flag, and positionally (`[key#3]`) otherwise. There is no env
   flag, no org opt-out and no claim probe on this gate.

All of the memory refusal codes above are terminal `PrimitiveInvocationError`s
(`retryable: false`), the same contract as the collision codes.

**`source` is actor-derived.** The row's `source` column comes from the authenticated
actor like every other provenance column, NOT from the client-declared
`provenance.tool`. The envelope's provenance pair answers "which local tool wrote
it" and is authorization-bearing for nothing; a reader looking for who wrote a memory
row reads the columns.

**The client leaves one file behind.** A `memory sync` run that wrote something
writes `sync-ledger.json` at the BUNDLE root — object ids and content digests of what
the last run pushed, used to report a row that drifted since. It is a per-checkout
cache and is **not meant to be committed** (its object ids are minted per
organization by whichever server answered, and nothing reads it as authority: the
preflight decides). `memory init` writes a `.gitignore` excluding it. The
conventions page says the same thing to the author.

**Provenance.** Identity provenance is actor-derived onto the row's own columns
(`orgId`, `createdBy`, `runId`, `agentId`, `packageVersion`), exactly as the table in
the previous section states. The envelope adds only what no server-side value can
answer: the bundle id, the concept path, and an optional client-declared
`provenance: { tool, toolVersion }` — bounded, `.strict()`, and authorization-bearing
for nothing.

**Scope on a resync.** The sync client sends `ownerLevel` / `visibility` **only on a
create**. On an update it omits them, so the `ON CONFLICT` arm preserves the row's
stored tuple and a row that promotion widened stays wide. Requesting a different
tuple is refused (`OBJECTS_COLLISION_SCOPE_CHANGE_REJECTED`), never silently
dropped. Sync never narrows a row and never deletes one.

**Scope on a create — the ownership-authority gate.** Issue #1378 makes the bundle's
`sync:` block and a concept's frontmatter a scope REQUEST "evaluated under the
caller's normal authorization at save time (a request, never a grant)". The
`object.create` probe alone does not deliver that sentence: `enforceResourceAccess`
short-circuits only for a row user-owned by the ACTOR, everything else falls through
to `can()`, and `can()` reads the cross-org guard and role→permission and never reads
`ownerType` / `ownerId` / `visibility` at all. `object.create` is in the plain member
set, so a same-org member's create naming another user, another team, or `public`
passed on the member grant alone. That kernel gap is not this type's to close; what
IS is that a memory bundle is an **untrusted file**, making this the one save path
whose ownership request originates in a file. `enforceMemoryOwnershipRequest` is
therefore memory-scoped and narrow, and changes `objects_save` for no other type:

- `ownerId` is **refused** (`OBJECTS_MEMORY_OWNERSHIP_REFUSED`), exactly as `orgId`
  already is everywhere. A request may choose a LEVEL; it may never name a PRINCIPAL.
- `ownerLevel: "user"` resolves the owner to the authenticated user and
  `"organization"` to the caller's own organization — both actor-derived, so the
  written tuple is always coherent and always one the caller could write anyway.
- `ownerLevel: "team"` / `"workspace"` and `visibility: "public"` are **refused**: no
  team or workspace authority is derivable at this seam, and publishing is a reviewed
  **promotion** (epic #1373), not something a file asks for at create time.

The gate is asserted twice — on the declared `typeHint` (before the probe, so the
probe evaluates the tuple the gate produced) and again on the RESOLVED type, closing
the residual path where a save reaches the memory type without declaring it. Its
coverage is pinned in `handlers-memory-ownership.test.ts`, which drives a kernel
double that GRANTS `object.create` (as a real member grant does), so the refusals are
attributable to the gate and not to an authz accident — the package-wide
allow-by-default alias stub would make those assertions vacuous.

**Identity is immutable on update.** The envelope's `superRefine` checks only that
`externalId` equals `sha256(bundleId + NUL + conceptId)` — INTERNAL consistency — and
never compares the triple against the identity the row already carries. Since
`data->>'externalId'` became a lookup key, accepting a coherent triple from another
bundle would point that bundle's next preflight at this row. `enforceMemoryIdentityImmutable`
refuses any change to `externalId` / `bundleId` / `conceptId` on an existing row
(`OBJECTS_MEMORY_IDENTITY_IMMUTABLE`, terminal). There is no rebind flow: a concept
that moved bundle or path is a new identity and therefore a new row, which is what
"path = identity" means in OKF.

**`objects_list.externalIds`** is the sync preflight: a batch key lookup over
`data->>'externalId'`, capped at 500 entries with each id capped at 256 bytes. The
array cap alone does not bind, because `limit` **defaults to 100** and `LIMIT` is
applied in SQL after the WHERE while the handler always answers `nextCursor: null` —
so an over-limit batch was truncated with nothing to say so. The handler therefore
refuses a call whose batch exceeds its EFFECTIVE `limit`, the same way it refuses a
missing `type`. It is a **filter on the existing primitive**, so the
authorization it gets is exactly `objects_list`'s — org-scoped in SQL,
ownership-filtered in SQL, `object.read`-probed per row. A row the caller may not read
is simply **absent**, indistinguishable from one that does not exist, which is what
keeps the preflight from being an existence oracle. It refuses what it cannot answer
honestly rather than approximating: without an explicit `type` (an external id is
unique only within its type), combined with a semantic `query` (a relevance cut would
report present rows as absent, and a sync run reads absent as "create"), and on an
empty batch (a filter that silently disappeared would widen the read to the whole
type).
