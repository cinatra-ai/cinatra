# `/configuration/artifacts` console — bidirectional live-render proof (cinatra#1786)

Real-surface verification of the Artifacts console against
**design@923fa0d8 `specs/app-artifacts.html`** (§I two-surfaces + §IV the console:
Type definitions · Stored objects · Restore objects + the nested restore route).

Driven with Playwright against a real `pnpm dev` (Next.js 16 / Turbopack) on the
local verify stack (postgres:5634 / redis:6579), isolated per-lane DB
`verify_1786` (schema cloned from the proof-batch DB, `cinatra` schema at
`core__0056`). Session minted through the real Better-Auth email sign-up/sign-in
flow; first registrant promoted to platform admin + org owner; active org set
through the real `organization/set-active` route. The console reads run through
the real loaders (`loadTypeDefinitionRows`, `loadStoredArtifactObjects`,
`listChangeSets`/`loadChangeSet`, `loadAuthorizedTargetedRestore`).

## Fixture world (disclosed)

Additive fixtures seeded directly into the isolated DB (every path under test
reads them through the real stores); the org `Default` was renamed **Acme Corp**
for a real entity-named scope label, a team **Growth** was created, and the admin
joined it:

| Surface | Fixture |
|---|---|
| Type definitions | Local artifact pack `@cinatra-ai/support-desk-artifact` (kind:"artifact") declaring an OWNED type `@cinatra-ai/support-desk-artifact:case` with an inline schema, registered through the real filesystem object-registry bridge; a dependent install `@cinatra-ai/escalations-agent` + a real `extension_dependency_edge` on the definer → the "Used by" cell. The always-registered semantic `@cinatra-ai/artifact:object` type is the second row. |
| Stored objects | 4 artifact objects (`type = @cinatra-ai/artifact:object`, real `data.artifactType` + `data.title`) across scopes: Team: Growth, Organization: Acme Corp (×2), Private (user-owned). |
| Restore objects | 3 restorable change sets + 60 object-change events (org-owned, admin per-object-authorized): a 12-object soft-delete (agent), an 8-object update (agent), a 40-object update (user). |
| Empty states | A second empty org `Empty Workspace` (no objects, no change sets). |

The `support-desk-artifact` fixture pack lives under the gitignored `extensions/`
tree and is **not** in this PR's diff. The only product change in this commit is
the `loadTypeDefinitionRows` registry-warming fix (Finding 1).

## Findings

### Finding 1 — FIXED on-branch: Type definitions rendered a FALSE empty state on a cold process

`loadTypeDefinitionRows` read `objectTypeRegistry.listArtifacts()` **without first
warming the registry**. The object-type registry is populated lazily by
`registerAllObjectTypes()` (the bridge that ingests every `kind:"artifact"`
extension's declared object types); boot does not call it, and every other
artifact read surface (the library, the matcher, the artifact-template wizard)
warms it before reading. A user who landed on `/configuration/artifacts`
**first** on a freshly-started process therefore saw the "No artifact extension
defines a type yet" empty state even though extensions were installed — a false
empty, contradicting the spec's read of the empty state ("no artifact extension
defines a type yet" must mean genuinely none).

Reproduced live: cold process → empty state; after any surface warmed the
registry → the type rows appeared. Fix: `loadTypeDefinitionRows` now calls the
idempotent `registerAllObjectTypes()` before reading `listArtifacts()`
(`src/lib/artifacts/type-definitions-inventory.ts`). Re-verified: the tab renders
the type rows regardless of visit order. Existing unit test (8/8) still green.

### Finding 2 — REPORTED (not changed here): row action label reads "Restore", spec says "Undo"

Spec §IV: "each row's right edge holds an **Undo** action" (example markup button
text: `Undo`). The Restore objects tab reuses the shared
`data-safety/RestoreModal` **wholesale**, whose trigger button is hard-coded to
**"Restore"** (aria-label "Restore this change-set"). This is a cosmetic spec
deviation, but the label lives on a shared component used by other surfaces, so it
is flagged for a ruling rather than changed unilaterally in this verify lane. A
low-risk fix would be an optional `triggerLabel` prop defaulting to "Restore",
with the console passing "Undo". (The restore-route confirm's primary button
correctly reads "Restore" per spec.)

## Numbered checklist — spec sentence → live render (all PASS)

### §I — Two surfaces / the console header + tablist
1. PASS — `/configuration/artifacts` opens with the page header title **Artifacts**. (h1 "Artifacts")
2. PASS — the one-line description reads exactly "Every type your artifact extensions define, every stored object across them, and the change sets you can undo."
3. PASS — the header is closed by a canonical underline **tablist**, tabs first, etched paired rule to the page edge (no pill tabs). (`role="tablist"` + `TabsListRow`)
4. PASS — tab order is **Type definitions** first, **Stored objects** second, **Restore objects** third.
5. PASS — Type definitions owns the bare `/configuration/artifacts` URL; the others carry `?tab=`; a real tab click pushes `?tab=` and the server re-renders the active tab. (clicked → `?tab=objects`)
6. PASS — an unknown/absent `?tab=` falls through to Type definitions (no blank dead-end). (`resolveTab`)
7. PASS — admin-gated (`requireAdminSession`); reachable as platform admin.

### §IV — Type definitions (global type registry)
8. PASS — lists every type every artifact extension defines, **alphabetical** across all extensions (Case before Object).
9. PASS — each row names the **Type** (display name over its type id): "Case" / `@cinatra-ai/support-desk-artifact:case`.
10. PASS — the one **Defined by** extension: "Support Desk Artifact".
11. PASS — the **Used by** extensions that declared the dependency: "Escalations Agent"; "—" when none (semantic Object row).
12. PASS — read-only inventory — no actions/affordances on rows.
13. PASS — empty state reads "No artifact extension defines a type yet" (observed on the pre-fix cold process + code path). Error state path present.

### §IV — Stored objects (global inventory)
14. PASS — lists stored objects of every artifact extension for the workspace (4 rows).
15. PASS — each row: display name over a mono meta line (**type id · object id · version · updated**): "Q3 re-engagement email" / `@cinatra-ai/email:draft · obj-1786… · v1 · updated 18 minutes ago".
16. PASS — the row's right edge carries the scope as an **entity-named label**: "Team: Growth", "Organization: Acme Corp", "Private".
17. PASS — read-only inventory — no row actions.
18. PASS — empty state reads "No objects are stored yet." (empty-org render). Error state path present.

### §IV — Restore objects (change-set restore)
19. PASS — lists object change sets **time-keyed across every extension**; each entry says the operation, the affected type, how many objects, and when: "Deleted 12 objects · @cinatra-ai/email:draft" / "by an agent run · 14 minutes ago"; "Updated 8 objects · @cinatra-ai/support-desk-artifact:case"; "Updated 40 objects · @cinatra-ai/email:draft · by you".
20. PASS — the row's action opens the restore confirmation **in place (an inline modal)** — heading "Restore change-set", explanation, a per-object diff preview (12 entries), Cancel / Confirm restore. (label deviation: Finding 2)
21. PASS — the list only shows change sets the actor may act on; the modal's authorized confirm path renders (no dead-end) for the per-object-authorized admin — **no administrator bypass**, the same `canActorRestoreChangeSet` gate.
22. PASS — empty state reads "There is nothing to undo." (empty-org render). Error state path present.

### §IV — nested restore route `/configuration/artifacts/restore/[changeSetId]`
23. PASS — NOT admin-gated; reachable by an authorized actor of any role (`getAuthSession`, not `requireAdminSession`).
24. PASS — authorized actor sees the "Restore this change?" confirmation with the addressed change set, modal auto-opened, and the copy "You are authorized to restore every affected object — no administrator role required."
25. PASS — a missing/foreign/non-restorable change set shows the standard **not-authorized state** ("You're not authorized to restore this change" + "Back to Restore objects"); a rendered control never dead-ends here. (same `loadAuthorizedTargetedRestore` gate, fail-closed)

### §IV — entry-point affordances (deep-links)
26. PASS (gate-level) — the in-chat "Undo last action" chip and the "Saved … · Undo" toast deep-link to the restore route and render **only when the acting user is eligible** — driven by `isSessionEligibleForTargetedRestore` → `loadAuthorizedTargetedRestore`, the exact gate proven live in items 24–25 (authorized → surface; unauthorized/missing → suppressed, never a disabled dead-end). Suppression is additionally covered by the PR's `undo-toast`/`console-link-retargets` unit tests. (The chip/toast render on the chat/toast surfaces, outside this console page; the shared eligibility gate is what §IV binds, and it is verified.)

### render → spec (nothing renders the spec does not specify)
27. PASS — the console main content is exactly: the page header (title + description), the underline tablist, and the active tab's table/list — no extra unspecified controls, no second rule, no mode toggle. (App shell — sidebar/breadcrumb/topbar — is the standard chrome, not console content.)

## Screenshots

| File | Surface |
|---|---|
| `screenshots/01-type-definitions.png` | Type definitions tab (Case + Object rows; Defined by / Used by populated) |
| `screenshots/02-stored-objects.png` | Stored objects tab (4 rows, entity-named scope labels) |
| `screenshots/03-restore-objects.png` | Restore objects tab (3 change sets) |
| `screenshots/04-undo-modal.png` | Inline restore confirmation modal (diff preview + Confirm) |
| `screenshots/05-restore-route-authorized.png` | `/restore/[changeSetId]` authorized (modal auto-opened) |
| `screenshots/06-restore-route-denied.png` | `/restore/[changeSetId]` not-authorized state |
| `screenshots/07-stored-objects-empty.png` | Stored objects empty state |
| `screenshots/08-restore-empty.png` | Restore objects empty state |
