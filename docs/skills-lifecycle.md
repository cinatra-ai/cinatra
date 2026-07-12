# Skill lifecycle (custom/personal skills)

Foundation layer for treating custom/personal skills as managed, living objects
(cinatra#1361, part of the skills-lifecycle epic #1358 A1). It adds lifecycle
STATE, an immutable REVISION history, and a transition AUDIT log to the core
store, and defines who may drive a transition.

The machine-readable authority is the pure policy — co-located in the
already-reachable skill-source leaf
[`packages/skills/src/skill-source.ts`](../packages/skills/src/skill-source.ts)
(the "Skill lifecycle policy" section), with the DB-writing transition mechanism
in [`packages/skills/src/lifecycle-store.ts`](../packages/skills/src/lifecycle-store.ts)
— the tables below document it; the code is the source of truth. The DDL lives in
`buildCreateStoreSchemaQueries` (the `skills` columns) +
[`src/lib/skill-lifecycle-schema.ts`](../src/lib/skill-lifecycle-schema.ts) (the
new tables + immutability trigger), with the migration artifact
`migrations/core/core__0029_skill-lifecycle.mjs`.

## Scope & precedence — where a skill's state comes from

A skill's lifecycle authority is determined by ORIGIN. There is exactly one
authority per skill; the two never overlap.

| Skill class | Authority for state | `skills.lifecycle_state` | Notes |
| --- | --- | --- | --- |
| **Custom / personal** (`packageId` begins `custom:`, or `isCustomSkill`/`isPersonal`) | This lifecycle layer | non-null (`draft`/`active`/`deprecated`/`archived`) | Owner-authored content; carries revisions + audit. |
| **Extension** (bundled / GitHub / vendored package skills) | DERIVED from `installed_extension` (read-time precedence) | **NULL** | An installed extension's state (active/locked/archived install) is the single source; this layer never stores a second copy. |
| **Legacy / bare local** (no recorded source) | DERIVED (treated as active-head) | NULL | No lifecycle authority until it becomes custom via a write. |

A **NULL** `lifecycle_state` means "derived — not a lifecycle authority here". The
`skills_lifecycle_state_check` constraint enforces `NULL OR IN (draft, active,
deprecated, archived)`, so an extension skill row is always valid while carrying
no lifecycle opinion.

## Lifecycle states

| State | Meaning |
| --- | --- |
| `draft` | Create-time only; a skill being authored before publish. Nothing TRANSITIONS into `draft`. |
| `active` | Usable. A new custom/personal skill created through `upsertSkill` starts here. |
| `deprecated` | Discouraged but still resolvable; typically paired with a `superseded_by` successor. |
| `archived` | Retired. TERMINAL — nothing transitions out; a revival is a NEW skill. |

## Legal transitions

Rows are FROM states, columns are TO states. `✔` = legal; blank = rejected
(fail-closed). A same-state "transition" is a no-op and is rejected.

| from \ to | draft | active | deprecated | archived |
| --- | :---: | :---: | :---: | :---: |
| **draft** | | ✔ (publish) | | ✔ (discard) |
| **active** | | | ✔ (wind down) | ✔ (retire) |
| **deprecated** | | ✔ (restore) | | ✔ (retire) |
| **archived** | | | | (terminal) |

`superseded_by` is a self-edge (`skills.superseded_by → skills.id`, `ON DELETE
SET NULL`). Setting it must not create a cycle. PostgreSQL cannot express
acyclicity as a constraint, so it is enforced two ways: a fast application-layer
pre-check (`wouldCreateSupersedeCycle` walks the successor chain and fails closed
on a self-edge, a loop back, or a pre-existing cycle), and — authoritatively and
race-free — the transition write itself, which takes a transaction-scoped
advisory lock over the supersede graph and re-walks the chain (a `WITH RECURSIVE`
guard) inside that transaction, so two concurrent supersede writes can never
commit a cycle between them.

## Transition authorization

Fail-closed: a transition is authorized only when it is both LEGAL and the actor
is entitled.

| Actor | May transition? |
| --- | --- |
| **Owner** (acting user owns the skill) | ✔ any legal transition on their skill |
| **org_admin / platform_admin** | ✔ any legal transition (governance) |
| **system** (migration / automation) | ✔ any legal transition (e.g. the backfill's initial activation) |
| **Non-owner user** | ✗ denied |
| **unknown actor type / illegal transition** | ✗ denied |

Every applied state→state transition writes one `skill_lifecycle_audit` row
(`from_state → to_state`, actor, reason, timestamp). The DB write is a
compare-and-swap on the current state and records the audit atomically iff the
swap matched, so a concurrent transition is a fail-closed no-op, never a
mis-audited history. A skill's INITIAL activation (`NULL → active`, at creation
or backfill) is provenance carried by its FIRST `skill_revisions` row, not an
audit row — so an audited transition's `from_state` is always a real prior state.

## Revisions (`skill_revisions`) — immutable history

Every custom/personal content write (`upsertSkill`, and the autosave / HITL /
chat-capture paths in later slices) records ONE revision, ATOMICALLY with the
content write:

- **id** — a distinct event id (NOT the content digest). Repeated identical
  content still yields a distinct revision, so provenance is per event.
- **content_digest** — the sha256 of the content at generation time (NULL when
  unknown, e.g. a legacy row seeded by the backfill).
- **source** — `manual` | `autosave` | `hitl` | `chat-capture` | `migration`.
- **based_on_skill_ids** + **base_digests** — the skills (and their digests at
  generation time) this revision was generated FROM, for agent/chat deltas.

`skill_revisions` is **append-only**: a `BEFORE UPDATE OR DELETE` trigger raises,
so a revision can never be mutated or deleted. The only mutable element of a
skill's revision state is the pointer `skills.active_revision_id`, which is a
composite FK `(active_revision_id, id) → skill_revisions(id, skill_id)` — the
active revision must exist AND belong to that skill.

`skill_revisions.skill_id` carries NO foreign key deliberately: revisions are
durable/tombstoned history that survives a hard skill delete, and an
`ON DELETE CASCADE` would fire the append-only trigger during a parent-skill
delete and abort the catalog-replace transaction.

## Backfill (core__0029)

On upgrade, existing custom/personal skills are activated (`lifecycle_state =
active`), seeded one `migration`-source revision (deterministic id
`migration:<skill-id>`, idempotent on re-run), and pointed at it via
`active_revision_id`. Extension/legacy rows are left NULL (derived). The three
backfill statements are ordered and idempotent; `down()` fully reverses the
schema.

# Content authority + rollback (custom/personal skills)

Content authority + rollback semantics (cinatra#1362, epic #1358 A2). Builds on
the A1 foundation above: the append-only `skill_revisions` history and the
single mutable `skills.active_revision_id` pointer. A1 recorded a revision's
content **digest** but not the content itself; A2 adds the durable
**authoritative content** and a first-class **rollback** revision. The code is
the source of truth — the pure builders in
[`packages/skills/src/skill-source.ts`](../packages/skills/src/skill-source.ts),
the DB write primitives in
[`src/lib/skill-lifecycle-store.ts`](../src/lib/skill-lifecycle-store.ts) +
`applySkillRollbackInDatabase` in
[`src/lib/database.ts`](../src/lib/database.ts), and the orchestrator
`rollbackCustomSkill` in
[`packages/skills/src/skills-store.ts`](../packages/skills/src/skills-store.ts).

## The authority contract

- **The DB is authoritative.** A custom/personal skill's authoritative content
  is the immutable blob named by the `content_digest` of the revision
  `skills.active_revision_id` points at, resolved through the new
  content-addressable `skill_revision_contents` table (`content_digest` →
  `content`). `readSkillActiveRevisionFromDatabase` is the DB-authoritative
  accessor (active pointer → revision → content blob).
- **`skills.payload.content` and the on-disk `SKILL.md` are PROJECTIONS** — a
  cache of the authoritative content, rebuildable from it. Enforcement is on the
  **write path** (every write establishes the authoritative revision + blob
  atomically); the read-side cutover of the projection readers (`readSkillContent`
  today reads disk) onto the authority resolver is a later lifecycle slice.
- **Blob integrity is DB-enforced, so a wrong blob is IMPOSSIBLE.** Two CHECKs on
  `skill_revision_contents` require `content_digest = sha256(content)` and
  `byte_length = octet_length(content)`. Content-addressing is therefore
  *provable*, and blob inserts use `ON CONFLICT (content_digest) DO NOTHING`
  safely (identical content dedups to one row; a mismatched pair aborts the
  write). The table is append-only (a `BEFORE UPDATE OR DELETE` trigger raises).

## Atomic failure recovery

A content write commits the DB payload + revision + content-blob + active-pointer
in **one transaction** (`replaceSkillCatalogInDatabase` for an edit;
`applySkillRollbackInDatabase` for a rollback) — all-or-nothing, no torn state.
The disk `SKILL.md` re-projection happens **after** the commit and is
best-effort: a failed projection never corrupts the already-committed authority
and is reprojectable on the next read/write.

## Retention

Revisions and content blobs are **append-only and retained indefinitely**. The
only mutable element of a skill's revision state is `active_revision_id`. There
is no automated pruning in this slice (a future admin-gated GC may bound history;
it must never mutate or delete a revision, only the pointer).

## Rollback = a new revision restoring prior content (never a mutation)

Rollback (`rollbackCustomSkill`) is a **forward-only** write. It records a NEW
`rollback` revision whose `content_digest` equals a prior revision's digest
(`restores_revision_id` names that prior revision — biconditional with
`source='rollback'`, self-FK'd to the same skill), restores that revision's exact
content into the payload projection, and re-points the active head. History is
never mutated or deleted. Fail-closed at every step:

- **Authorization** is the trusted `requireResourceAccess(..., "manage")`
  chokepoint, derived from the PERSISTED skill (`level`/`scope`) + the caller's
  session `ActorContext` — never a caller-supplied owner/role flag.
- The target revision must **belong to the skill** and resolve to **durable
  content**; a revision with no stored blob (a legacy / untruthful head) is
  rejected — authority never restores content whose digest it cannot verify.
- The write is an **active-pointer compare-and-swap**: the payload + pointer move
  only while `active_revision_id` still equals the head the caller observed. A
  concurrent edit or rollback that advanced the head makes the swap a no-op and
  the rollback throws — it never silently reverts the concurrent write. Because
  the blob + rollback-revision inserts are gated on the CAS (`SELECT … FROM upd`),
  a miss writes nothing (no orphan revision).

On success it fires the standard re-match hook (`enqueueInlineForSkill`) —
matching re-evaluates against the now-authoritative rolled-back content — plus
`/skills` revalidation. Rollback is the AUTHORITATIVE (DB) write; the on-disk
`SKILL.md` projection reconciles on the read-side cutover or the skill's next
content write (a later lifecycle slice), so rollback does not itself touch disk.
Rollback restores **content**, not the whole historical row: name/description and
other metadata stay current.

## Concurrency scope + a known legacy limitation

The active-pointer CAS guarantees a rollback and any concurrent write to the SAME
skill serialize-or-fail-loudly and never tear the pointer from its content
(every writer sets payload + pointer together atomically). One pre-existing
hazard is out of A2's scope: the legacy full-catalog write
`replaceSkillCatalogInDatabase` rewrites every skill row from a pre-transaction
snapshot, so a concurrent edit of a DIFFERENT skill can stale-clobber an
unrelated skill's payload PROJECTION (never its authority — the active revision +
blob stay correct). This lost-update predates A2 and is owned by the catalog
read/rebuild decoupling + legacy-store retirement slices.

## Backfill (core__0031)

On upgrade, a content blob is seeded from every custom/personal skill's **current**
content (keyed by `sha256(content)`), so every *truthful* active head (one whose
recorded digest matches its content) resolves to durable authoritative content.
A fail-closed postcondition proves the seed populated every truthful head. A head
whose recorded digest does NOT match its content is a pre-existing history/content
inconsistency A2 does not silently rewrite — it resolves on the skill's next write
and fails closed at rollback until then. `down()` is guarded: it fails loudly if
any `rollback` revision exists (immutable history is invalid under the narrowed
A1 CHECK), otherwise fully reverses the A2 additions.

## Catalog read/rebuild split (A4, cinatra#1364)

`readSkillsCatalog()` historically delegated every read to the rebuild engine
(`syncInstalledSkillsToDatabase`): GitHub auto-sync (first call), disk scan,
merge, conditional full-catalog DB rewrite, and prefill-job enqueue — from 40+
production call sites. A4 introduces the parallel split surface (both in
`packages/skills/src/skill-packages.ts`, barrel-exported):

- **`readSkillsCatalogSnapshot()`** — PURE read of the persisted catalog,
  normalized through the same canonical normalizers as stored rows. No side
  effects of any kind.
- **`rebuildSkillsCatalog({ reason })`** — the EXPLICIT lifecycle operation:
  the exact legacy engine under (a) an in-process single-flight that also
  queues exactly ONE follow-up run for triggers arriving mid-rebuild (a running
  rebuild's scan may predate the new trigger's change), and (b) a cross-process
  metadata lease (CAS + TTL expiry, `skills_catalog_rebuild_lease`). On success
  it records the completeness fence (`skills_catalog_rebuild_state`, exposed as
  `readSkillsCatalogRebuildState()`).

**Fencing / no partial observation.** The engine's catalog write is one DB
transaction that ALSO bumps the cross-process generation token
(`skills_catalog_generation`); `readSkillCatalogFromDatabase` keys its
in-process cache on that token (read BEFORE the rows, so an interleaved write
can only mislabel a cache entry as older — never serve mixed state). A reader
therefore sees the catalog fully-old or fully-new, and a write from ANY process
(web, BullMQ worker) invalidates every process's cache on its next read. This
replaces the old process-local cache counter, which could serve stale data
cross-process indefinitely.

**Rebuild wiring (this slice):** boot after extension activation +
materialization (`skills-catalog-rebuild` phase, `degraded` policy), the dev
extensions watcher settle, the dev boot skill-package scan, skill-extension
install/update/uninstall, the MCP package install/uninstall handlers, and the
GitHub-install server action. Never call `rebuildSkillsCatalog()` from code the
engine itself reaches (github auto-sync, scanner, prefill enqueue) — the
single-flight would deadlock on its own promise.

**Incremental migration.** Call sites move to the snapshot read one by one,
tracked per site in `docs/architecture/skills-catalog-read-inventory.json`
(update it in the same PR as any migration). Read-merge-REPLACE write flows and
the hot bridge/matching paths stay on the legacy read until their own slices;
deleting the legacy path is S8's parity-gated last step. The A2 stale-clobber
note above is narrowed by this slice (cross-process invalidation + serialized
rebuilds) but only S8 retires the read-side trigger entirely.
