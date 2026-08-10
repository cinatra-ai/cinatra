# cinatra#2474 PR4 — evidence

Work item 4 of six: concept B's **installed-catalog read**, its section in the
popup slot PR3 left, and Personal wired into the add-sources provider.

**Design-spec pin:** `specs/app-artifacts.html` **§IX** @
`design@60cf789ec9b6d6455148a086cacc6ae43f447cef` — still the tip of that file,
the same revision PR1, PR2 and PR3 pinned.

---

## What is proven, and at which tier

| Tier | Result |
|---|---|
| `packages/dashboards` vitest | **79 files / 726 tests** pass |
| `packages/extensions` vitest | **118 files / 2290 tests** pass (1 skipped) |
| root vitest over `src/components`, `src/lib/dashboards`, `src/app/__tests__`, `src/app/projects`, `src/app/dashboards` | **140 files / 1333 tests** pass |
| `tsc --noEmit` | **0 errors** in every file this PR touches |
| `eslint` | **0 errors** on every touched file |

New coverage this slice:

- `packages/extensions/src/__tests__/access-scope-vantage.test.ts` — the full
  token × vantage matrix, malformed vantages, ANY-MATCH, and a **conformance
  tier** that runs the same ten tokens through the REAL
  `evaluateExtensionAccess` for a generic member standing exactly where each
  vantage stands and asserts the two agree. Also pins `use` ≡ `read` for
  `kind:"artifact"`, the equivalence the read's op choice rests on.
- `src/lib/dashboards/__tests__/installed-catalog-eligibility.test.ts` — the pure
  core: destination derivation (including every refusal — wrong user, empty
  actor, missing scope id, an organization scope that is not its own tenant), the
  organization ref pinned against `buildOrganizationDetailRef` itself, the
  template-scope allowlist, and the name-collision rule.
- `src/lib/dashboards/__tests__/installed-catalog-read.test.ts` — all eight gates
  driven through injected seams, with the REAL `evaluateExtensionAccess` in play
  (the actor arm is the platform's, never a restatement): the tenant and
  destination fences, the canonical liveness gate, the version-ambiguity fence,
  the one-snapshot/two-arm property, the archived-name collision, ordering,
  bounds, and the never-throws posture.
- `src/components/dashboards/__tests__/scope-catalog-section.test.tsx` — RENDER
  assertions: real rows, and **zero** buttons / links / inputs / disabled
  controls, plus the tense of the copy.
- `add-dashboard-dialog.test.tsx` — a browse-only catalog raises **no** toolbar
  button on its own; a manager still gets the popup with the catalog.
- `scope-dashboards-conformance.test.ts` — PR3's label lock, updated to the
  stronger post-PR4 predicate and asserting the catalog appears in exactly ONE
  predicate.

---

## What is OWED: the rendered pass

**No live browser walk was taken for this slice, and none is claimed.** Stated
plainly rather than implied by omission.

Two blockers, both environmental:

1. **No provisioned instance for this worktree.** The dev server refused to boot
   against this checkout (`database "s6ld" does not exist`); provisioning a
   per-worktree instance is `cinatra instance setup dev`, which did not fit the
   lane window. The other dev server on this host (`:3152`) belongs to a
   different lane's worktree, so driving it would prove nothing about this
   branch's code.
2. **The primary browser slot was contended** for the lane window.

### What the render pass needs, exactly

This matters more than usual, because **the catalog is empty on a stock
instance** and a walk that simply visits the four landings would prove only that
nothing renders. The reconcile is dormant by construction — "the current fleet
ships none in the dev/required lock, so this reconciles zero orgs" — so a
meaningful pass must first make the read return rows:

1. Seed a canonical `installed_extension` row: `kind:"artifact"`,
   `status:"active"`, org-addressable, **exactly one live row for the package**
   (a second live row is refused by the version-ambiguity fence).
2. Seed the materialized template row in `dashboards`: `extension_id` = that
   package, `is_template = true`, `status = 'published'`, `organization_id` = the
   org, and `template_scope` one of `user|team|organization|workspace`
   (**`project` is refused everywhere** — by design).
3. Leave the access policy row absent, or set `runDataVisibility` to a token the
   target scope's generic member is admitted by (`workspace` / `org` /
   `org:<id>`, or `team:<T>` on team T's own landing).
4. Ensure the template's name is **not** already taken in the acting user's
   collection for that entity — including by an **archived** dashboard, which
   still owns the name.

Then walk, as a scope MANAGER and again as a plain MEMBER:

- `/personal` — the toolbar shows **"+ New dashboard"**, never "Add dashboard";
  clicking it opens the popup carrying Create + the catalog. With the fixture
  removed it must open the name prompt **directly**, exactly as before this PR.
- `/teams/<id>`, `/organizations/<id>`, `/projects/<id>` — manager sees
  "Add dashboard" (the §IX.2 annotation + `open-add-picker` action) opening
  Create + Reference + catalog; member sees "+ New dashboard" opening Create +
  catalog and **no** §IX.2 annotation and **no** `open-add-picker` action.
- Every catalog row: name + package, and **no** control of any kind on it.
- A principal with `canCreate === false` and no reference source: **no button at
  all**, even with the catalog present.
- Light + dark, and 390px with no horizontal overflow.

Captures belong in this directory.

---

## A spec note the reviewer should not have to discover

**§IX at the pinned revision draws no installed-catalog section at all.** It
draws the §IX.1 reference picker ("Lists an existing dashboard here as a
reference"), and it says a personal scope "is not an add-to-scope target — they
carry no *Add*", with the personal example drawn with no Add affordance.

This PR does **not** claim §IX conformance for the catalog; concept B is
authorized by the issue, not by the drawn spec. The parts §IX *does* fix are
preserved and locked: personal never receives the §IX.1 reference source, so it
never grows an "Add dashboard", and the catalog can never promote the toolbar
label, the §IX.2 annotation or the `open-add-picker` action on any scope.

The spec is owed an amendment covering concept B before it can be checked
bidirectionally against this surface.
