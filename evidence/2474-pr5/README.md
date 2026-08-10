# cinatra#2474 PR5 — evidence

Work item 5 of six: concept B's **instantiate action** — the issue's one
sanctioned inner-workings addition, and the three constraints PR4 deferred here.

**Design-spec pin:** `specs/app-artifacts.html` **§IX** @
`design@60cf789ec9b6d6455148a086cacc6ae43f447cef` — the same revision PR1–PR4
pinned. As PR4 recorded, §IX draws **no installed-catalog section at all**;
concept B is authorized by the issue, not by the drawn spec. What §IX *does* fix
is preserved and locked, and the live walk below re-checks it.

---

## The three constraints PR4 handed forward

| Constraint | Where it lives | Proven by |
|---|---|---|
| **Currentness** — refuse a template the pack no longer declares | gate 9, `installed-catalog-currentness.ts` (asks the reconciler's own single-package resolver) + the identity pin in `installed-catalog-write.ts` | unit: `installed-catalog-{currentness,write}.test.ts`; **live: capture 11** |
| **Destination** — derived from the authenticated actor only (`ownerLevel:"user"`), through the same hardened seams | `resolveCatalogDestination` (PR4's own, re-taken at write time; extended with the scope-reach arm) | unit: `installed-catalog-write.test.ts` (the real fence, never faked); **live: the two owner rows below** |
| **Name collision** — the writer's own rule, status-blind | gate 8, `isAddableWithoutNameCollision` + `readDestinationNames` (every status) | unit: archived-name case; **live: capture 04** |

---

## What is proven, and at which tier

Every heavy leg ran on **host2** (`ordnas@192.168.0.36`, x86_64) against
`lane/2474-dashboards-s5`; no credential or secret was placed on that host.

| Tier | Result |
|---|---|
| `pnpm typecheck` (whole repo, tsgo) | **0 errors** |
| root vitest over `src/lib/dashboards`, `src/components/dashboards`, `src/app/__tests__`, `src/app/projects`, `src/app/dashboards` | **53 files / 548 tests** pass |
| `packages/dashboards` vitest | **79 files / 726 tests** pass (incl. the single-writer invariant test, which the new writer subpath must not break) |
| `packages/extensions` vitest | **118 files / 2275 tests** pass (1 skipped) |
| `eslint` on every touched file | **0 errors** |

New coverage this slice:

- `installed-catalog-write.test.ts` — every gate through injected seams with the
  **real** destination fence in play: the destination derivation for each
  surface, the descriptor naming another user, the wrong tenant, a non-human
  principal, the org-scope invariant, the scope-reach arms, a handle no longer
  admitted, a malformed handle, an uncreatable name, the currentness refusal, the
  **replaced-declaration** refusal, the re-taken template-scope rule, the
  distinguishable `name-taken`, the fail-closed unreadable destination, and the
  never-throws posture.
- `installed-catalog-currentness.test.ts` — the gate asks the reconciler's own
  resolver and decides nothing itself; the row name comes from the
  **materializer's** rule; fail-closed on a throw and on a non-validating body.
- `installed-catalog-write-seam.test.ts` — structural locks a behavioural test
  cannot see: the `"use server"` module exports **only** async functions and
  exactly one action; the surface is bound by the one node builder and no landing
  binds its own or hands the write a ref; the section never constructs a
  destination; the write reaches the platform writer and never a table; and it
  cannot express any vocabulary the issue's constraint forbids.
- `installed-catalog-eligibility.test.ts` — the scope-reach matrix, including the
  stated narrowing.
- `scope-catalog-section.test.tsx` — the Add, the busy/double-add guard, every
  refusal rendered as in-product copy, the rejected-action recovery, and
  suppression (never a disabled control) without create authority.
- `scope-dashboards-conformance.test.ts` — PR3's label lock updated to the named
  `offersCatalogAdd` predicate, still asserting the catalog appears in exactly ONE
  predicate and that the section's Add is gated on the same `canCreate`.

---

## The live walk

Run on **host2** against the real dev server (`pnpm dev`, Next 16 + Turbopack),
driven with Playwright using `domcontentloaded` + selector waits — never
`networkidle`.

### The fixture

PR4's evidence README specified the DB half. PR5's currentness gate needs one
thing more, and that is the point of the gate: **the pack must actually declare
the template on disk.** The fleet ships none, so the fixture supplies it.

1. `@cinatra-ai/dashboard-artifact` (a `kind:"artifact"` pack the **static**
   manifest claims, with exactly ONE live `installed_extension` row — org-null,
   so org-addressable) gains a `cinatra.artifact.templates[]` entry
   `{form:"dashboard", path:"cinatra/dashboard.json", default:true}` plus that
   sidecar: an `apiVersion v1.2`, `scopeLevel:"organization"` envelope with one
   `object-list` portlet.
2. The materialized template row, exactly as `materializeExtensionTemplate` would
   write it: `extension_id` = that package, `is_template=true`,
   `status='published'`, `organization_id` = the org, `template_scope` =
   `organization`, name `Dashboard dashboard`.
   *(Hand-seeded rather than reconciled: `collectCandidateOrgIdsFromSources`
   skips org-null install rows — "system-locked fan-out is a follow-up" — so the
   boot reconcile produces zero candidate orgs on this fleet. The row reproduces
   the reconcile's own output, and gate 9 then validates it against the real
   manifest on disk.)*
3. No access-policy row → the platform's own `DEFAULT_EXTENSION_ACCESS_POLICY`.
4. Two real users created through the auth API: `pr5mgr` (org **owner**, team
   **admin** of `PR5 Walk Team`) and `pr5member` (org **member**, plain team
   member). `CINATRA_E2E_SETUP_BYPASS=true` — the repo's own, explicit
   browser-e2e affordance — stands in for the LLM-provider setup step, because
   **no provider credential may exist on host2**.

### The results

| # | Capture | What it shows |
|---|---|---|
| 01 | `01-personal-manager-popup.png` | `/personal`: the toolbar says **"+ New dashboard"**, never "Add dashboard"; the popup carries Create + the catalog; the row shows name + package with **one** control (Add) and **no link**. |
| 02–03 | `02-personal-after-add.png`, `03-personal-dropdown.png` | The add lands: the new dashboard is selected and on screen, and the dropdown is `Overview` + `Dashboard dashboard` — adopted into the shell's own list, no page reload. |
| 04 | `04-personal-name-taken.png` | **Name-collision refusal, from the read side.** With the copy in place the name is taken, the template leaves the eligible set, the catalog collapses to `null` — so the trigger opens the **name prompt directly**, exactly as before this PR (`sections=0, namePrompt=1`). |
| 05–06 | `05-team-manager-popup.png`, `06-team-manager-after-add.png` | Team as **manager**: "Add dashboard" with the §IX.2 annotation and the `open-add-picker` action, Create + Reference + catalog; the add lands. |
| 07–08 | `07-team-member-popup.png`, `08-team-member-after-add.png` | Same team as **member**: "+ New dashboard", **no** §IX.2 annotation (`0`), **no** `open-add-picker` (`0`), **no** reference section (`0`) — and the catalog with a working Add. The add lands. |
| 09 | `09-org-dark-390.png` | Dark theme at 390px on the organization landing: **no horizontal overflow**. |
| 10–11 | `10-org-catalog-before-retire.png`, `11-org-no-longer-declared.png` | **The currentness refusal.** The row stays `published` and its package stays live; only the pack's **declaration** is removed from disk. The list still offers it (the read is deliberately not currentness-gated — see below), and pressing Add refuses: *"The extension no longer provides that dashboard."* **Zero rows written.** |

### The destination, proven by the data

After the manager and the member each added on the SAME team page:

```
owner_id                             | name                | entity_type | entity_id | owner_level
1b8d8a67-bf68-4d9a-a855-bbda82e73e75 | Dashboard dashboard | team        | team-pr5  | user
896b73df-f758-45d1-8330-93ddcdf6b51d | Dashboard dashboard | team        | team-pr5  | user
```

Two rows, same entity, same name, **different owners** — the destination is the
acting user's own collection, and the name uniqueness is per `(entity, owner)`.
Neither user can see the other's.

And the copy is an **ordinary** dashboard, exactly as the issue requires:

```
name                | extension_id | contribution_id | is_template | is_default | owner_level | status
Dashboard dashboard | <null>       | <null>          | f           | f          | user        | draft
```

`dashboard_entity_links` rows: **0**. No provenance, no link row, no ownership
change, no canonical-home change.

---

## Honest gaps

- **The LIST is not currentness-gated.** A retired template keeps appearing in
  the popup for as long as its row survives, and pressing Add refuses. That is
  deliberate — the probe touches the filesystem and, for a marketplace pack, the
  runtime package store, which is the wrong cost on four landings' server render,
  and a stale row that is merely *listed* is cosmetic while one that is *copied*
  is durable. Capture 11 shows exactly this seam rather than hiding it.
- **A stated narrowing of PR4's read.** `actorMayReachSurface` admits a team only
  on **membership**, so an org owner/admin or platform admin who may *view* a
  team they do not belong to no longer sees the catalog there. Chosen: membership
  is what proves the team still exists without a query, and the affordance
  withheld is a private dashboard of theirs on a team they are not in.
- **No lifecycle-lock coordination** between the currentness probe's runtime-store
  arm and package archive/teardown. Pre-existing for `rescanArtifactBridgeFromStore`
  and shared with boot and the activate hook; PR5 narrows the exposure with
  `onlyPackage` rather than closing the race.
- **The walk's fixture is hand-seeded** for the template row (see above) and the
  active-organization stamp on a freshly-minted session is set directly. Both are
  plumbing around what is being proven, not part of it.
- **No project-surface live cell.** The matrix walked personal / team / org; the
  project arm is covered by unit tests (grant present, grant revoked, wrong
  project) but not by a browser cell.
