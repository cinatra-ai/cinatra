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
