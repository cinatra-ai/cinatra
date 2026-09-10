# The design conformance pin-drift check (`design-pin-drift`)

The design-system source of truth decides how the app must look. This repo
proves it conforms by testing against **pinned** copies of the published
conformance manifests — `tests/e2e/design/conformance-pins.json` and the
verbatim artifacts beside it under
`tests/e2e/design/conformance/manifests/`. The suite that consumes them is
documented in
[`tests/e2e/design/conformance/README.md`](../../../tests/e2e/design/conformance/README.md);
this page documents the gate that watches the pins themselves.

Until cinatra#3057 nothing told anyone when a published manifest no longer
matched its pin. The functional-acceptance suite carried an `UPSTREAM DRIFT`
assertion, but it is skipped while a pin says `source: "repo"` (all five do),
and its workflow runs only on a path-filtered `pull_request` and never on
`main`. So the assertion had never run once, and all five published manifests
had moved away from their pins with no check saying a word.

This job does not move a pin and does not decide whether one should move. **It
refuses silence.**

- checker: [`scripts/ci/design-pin-drift.mjs`](../../../scripts/ci/design-pin-drift.mjs)
- path map: [`scripts/ci/design-pin-drift.paths.json`](../../../scripts/ci/design-pin-drift.paths.json)
- job step: `design-pin-drift` in [`.github/workflows/gates.yml`](../../../.github/workflows/gates.yml)
- unit suite: `scripts/ci/__tests__/design-pin-drift.test.mjs` (root Vitest suite)

## What the job checks

For every entry in `conformance-pins.json` the checker fetches
`publishedBaseUrl + file` and classifies the result as **exactly one** of:

| Outcome | Meaning |
| --- | --- |
| `http-failure` | a network error, or a non-2xx status |
| `invalid-json` | the body does not parse as JSON (an HTML error page, for instance) |
| `schema-failure` | it parses but is not a conformance manifest: `schemaVersion` is not `"1.0.0"`, or `contentHash` is missing or not `sha256:<64 hex>` |
| `drift` | the published bytes do not hash to `manifestSha256`, **or** the published `contentHash` differs from `specContentHash` — both compared unconditionally, so neither hash can hide behind the other |
| `match` | both hashes agree |

It prints a per-pin table (id, file, pinned and published hashes, outcome) and,
for every non-`match` pin, a block naming the pin id, the manifest file, the
published URL, both hash pairs, the outcome and the rule below.

**That is all it prints.** A hash mismatch proves *different*, not *behind*, and
that is the only thing a public gate can honestly say — which is also why the
pin file carries no provenance field for it to read one from. The checker
therefore also runs a **structural check** on the pin file and refuses:

- a pin entry with any key other than `id`, `file`, `source`, `manifestSha256`,
  `specContentHash` — so a `$specCommit`-style note (or a structured
  replacement for one) cannot come back;
- a `manifestSha256` that is not lowercase 64-hex, or a `specContentHash` that
  is not lowercase `sha256:<64 hex>`;
- a duplicate id, an unknown `source`, or a map that does not cover every pin.

Those refusals exit `2` (the gate could not run honestly), distinct from the
`1` a drift produces.

## The trigger rule

`scripts/ci/design-pin-drift.paths.json` maps each pin id to the repository
paths that **consume** that manifest: its committed copy, the drivers that
answer what it declares (`tests/e2e/design/conformance/contract.ts`, one shared
file), and the harness mounts that render its surfaces. The gate's unit suite
refuses a mapped path that no longer exists, so the map cannot rot quietly.

- **`pull_request`, `merge_group`, a push to any other branch** — red only for
  the non-`match` pins whose mapped paths this diff touched. Every other
  non-`match` outcome is a warning annotation and the job exits `0`. So an
  unrelated PR is never blocked by a manifest change it does not adopt.
- **A diff that touches `conformance-pins.json`** touches the ids whose **entry**
  changed, not all five — otherwise a PR that fixes one pin would be red for
  the four drifts it did not touch. When the changed entries cannot be
  determined (no diff base to compare against), every id counts: fail-closed.
- **A diff that touches the checker, the map or the workflow** touches every id.
  Those change what the gate itself decides, so after such a change no pin's
  silence is trustworthy.
- **A push to `main` or a `workflow_dispatch`** is red on **any** non-`match`
  outcome, touched or not. This is the run that makes a drift impossible to
  ignore.
- **The diff base** is the pull request's base branch, and for a merge group the
  event's own `base_sha` — `origin/main` can move under a queued group, which
  would make the touched set over- or under-report.
- **A diff base that does not resolve** (a fetch-depth misconfiguration) counts
  every pin as touched. The sibling ratchet steps in `gates.yml` fall back to
  `HEAD` there, which self-compares to an empty diff; for this check that is the
  fail-OPEN direction — an empty diff adopts no pin and every drift would
  degrade to a warning — so it over-reports instead.

## Who moves a pin

> A pin moves only in an implementation or explicit reconciliation issue/PR
> that validates the new published contract and updates the required drivers,
> harness mounts and proofs together with it.

The gate prints that rule with every red. Moving a pin stays the job of the
issue that **adopts** the change; this job only makes the difference visible.

## Why a hash-only re-pin is refused

Editing two hashes makes this check green and proves nothing. Two different
things can hide behind a moved hash, and they cost different amounts:

- **The manifest declares something new.** It added a surface, retired one, or
  redrew an existing one into different actions and states. A driver has to
  answer each of those, and the functional-acceptance suite is red for a
  declared surface with no driver and no allowlist entry while `allowlist.json`
  is a **shrink-only** ratchet that may not gain entries. A blind re-pin does
  not quietly pass here; it turns that suite red instead, one layer further in.
- **The manifest declares exactly what it declared before**, and only the
  embedded spec-content hash moved — the spec source changed under an unchanged
  drawing. Three of the five drifts the reconciliation below adopted were this
  case, and the functional-acceptance suite would have stayed green through a
  blind re-pin of them.
  Nothing downstream catches it, which is precisely why the hashes are compared
  here and why a re-pin is still an adoption: the claim "this repo verified
  against THAT artifact" stops being true the moment the hash is edited without
  someone checking what moved.

Replacing the committed artifact and both hashes is the *first* step of an
adoption, never the whole of it.

## Rollout state

**Required.** cinatra#3057 landed in two parts:

- **(a) the job.** The job runs on every pull request, on `merge_group`, on
  every push to `main` and on dispatch — its own job, not a step in `gates`,
  because `gates` is a required context and a red here had to be visible
  without blocking anything until (b) landed. The first `main` run came back
  red with five drifts, all five of which the reconciliation record below
  has since adopted.
- **(b) the requirement.** `design-pin-drift` is now listed in
  `.github/branch-protections.json`'s required contexts, and mirrored in
  `scripts/ci/merge-group-coverage-guard.mjs`. That file is a declaration: the
  live protection changes when it is re-applied with the `gh api -X PUT`
  command at the top of it, which happens once this merges. From then on: a
  pull request touching
  none of the mapped paths in `scripts/ci/design-pin-drift.paths.json` stays
  green (a warning annotation, exit `0`); a pull request touching a drifted
  pin's mapped paths goes red until that pin is adopted. cinatra#3057 closes
  with this PR.

## Known drifts

**`app` and `app-components`.** The 2026-08-30 reconciliation below left all
five pins reading `match`; three of them have moved again since. Measured on
`main` at 0a818cb5977c (cinatra#3372): `app` and `app-components` report
`drift` in both hashes and are adopted under the issue that owns their surfaces
(cinatra#3189); their mapped paths are touched by cinatra-ai/cinatra#3329,
which is why that pull request is red on them. `app-connectors` reported
`drift` in the same reading and is adopted by the 2026-09-10 record below;
`app-extensions` and `app-notifications` read `match`.

The bodies a pin named before an adoption are kept as the checker's own drift
input (see `superseded-pins-2026-08-28/` beside the frozen published ones, and
every row a later frozen fetch superseded), because a gate whose drift path has
no input is a gate whose drift path is untested.

## Reconciliation record

Measured 2026-08-28 and adopted on 2026-08-30, after re-fetching each published
manifest and confirming it was byte-identical to the frozen 2026-08-28 capture
under
`scripts/ci/__tests__/__fixtures__/design-pin-drift/published-2026-08-28/`.
Every row's committed artifact under
`tests/e2e/design/conformance/manifests/` is the verbatim published body; both
hashes in `conformance-pins.json` were re-derived from it, never typed.

| Pin | Was | What the adoption changed | Cost |
| --- | --- | --- | --- |
| `app` | `drift` | one surface gained: `sidebar-assistants-entry` (`open-assistants -> assistants`) | driver + harness mount + test-id contract row |
| `app-components` | `drift` | `scheduling-trigger-tab` retired; `scheduling-step-configured` and `breadcrumb-entity-resolution` gained | one driver retired, two added, two harness mounts, two test-id contract rows |
| `app-extensions` | `drift` | **hashes only** — byte-identical surface declarations | re-pin |
| `app-connectors` | `drift` | **hashes only** — byte-identical surfaces | re-pin |
| `app-notifications` | `drift` | **hashes only** — byte-identical surfaces | re-pin |

The two redeclaring adoptions are the ones the "who moves a pin" rule is
written for, and neither needed product work — both name mechanisms this
repository already ships:

1. **`sidebar-assistants-entry`** is the §IX Assistants nav entry, shipped in
   `src/components/app-sidebar.tsx` with the exact
   `data-conformance-id` / `data-action` literals the surface declares, and
   already asserted at the source by
   `src/components/__tests__/sidebar-assistants-conformance.test.ts`. What was
   missing was a mount that exercises its ACTION to the declared outcome; the
   adoption adds one.
2. **`scheduling-step-configured`** replaces `scheduling-trigger-tab`, and the
   retirement happened **with** the adoption, in one commit, exactly as this
   page required — the driver and harness mount for the retired surface were
   left untouched until the manifest that retires it was pinned. The redraw
   follows the product: the Trigger tab's `cancel`/`release` pair is gone
   because **Run now** was withdrawn with its whole action path, and the two
   surviving operations are the configured schedule step's `Save changes`
   (`save-schedule-changes`, settling to "Saved — the trigger is re-armed on
   these rows" = `rearmed`) and `Cancel schedule`
   (`cancel-trigger-schedule` = `stopped`), both drawn by
   `packages/agents/src/schedule-proposal-card.tsx`.
3. **`breadcrumb-entity-resolution`** is the crumb-contributions resolution
   road: `src/lib/breadcrumb-contributions.ts` (publish / select / clear),
   `src/lib/breadcrumb-trail.ts` (`buildBreadcrumbTrail`, and the
   `idSegmentPlaceholder` floor rule that is exactly the manifest's
   `crumb-placeholder <- entity.id` binding), and the negative surfaces'
   `CrumbContributionsClear`, which is exactly `visit-unauthorized ->
   resolved-names-cleared`. Its mount DRIVES that road rather than modelling
   it: the fields, the action and the state all run through the real modules.

An earlier reading of this page recorded `scheduling-step-configured` as
declaring "actions with no counterpart to drive until the schedule step itself
draws them", and `breadcrumb-entity-resolution` as having no counterpart at
all. Both readings were wrong at the time they were written, and the
reconciliation says so rather than carrying them forward: the schedule card had
already landed, and the breadcrumb road had shipped well before that. Neither
pin needed to be deferred, and none was.

`allowlist.json` gained nothing — it is shrink-only and did not move. Every
surface in every adopted manifest has a driver.

### 2026-09-10 — `app-connectors` (cinatra#3372)

Adopted the published `app-connectors` manifest fetched from the pin file's
`publishedBaseUrl` on 2026-09-10 (HTTP 200, 4821 bytes,
`2b98802f27fb…`), byte-identical on a second fetch. The committed artifact
under `tests/e2e/design/conformance/manifests/app-connectors.json` is that
response verbatim and both hashes in `conformance-pins.json` were re-derived
from it, never typed. The four other pins were not touched.

| Pin | Was | What the adoption changed | Cost |
| --- | --- | --- | --- |
| `app-connectors` | `drift` | three surfaces gained: `connector-sharing`, `connector-sharing-rollup`, `connector-sharing-locked`; the eight surfaces the pin already declared are byte-identical; the embedded spec-content hash moved with them | no driver: none of the three is drawn by anything on `main` |

What moved, surface by surface:

- **`connector-sharing`** declares four field bindings (`name <- connection.connectionId`, `url <- connection.connectorKey`, `access <- policy.runListVisibility`, `co-owners <- connection.coOwners`), four actions (`select-scope -> scopes-selected`, `search-people -> people-listed`, `remove-co-owner -> co-owner-removed`, `save-access -> access-saved`) and the `loading` state.
- **`connector-sharing-rollup`** and **`connector-sharing-locked`** declare no field, action or state of their own.
- The eight surfaces already pinned — `connector-connection-filter`, `connector-grid`, `connector-install-cta`, `connector-empty-panel`, `connector-setup`, `connector-multi-setup`, `connector-connections`, `connector-config-tab` — are unchanged, declaration for declaration. Their part of this move is spec-content-only: the spec source changed under an unchanged drawing.

**No driver is written here, and this pull request stops at this record.** A
driver reads the host code the surface is drawn by, and none of the three
gained surfaces has any: a whole-tree search of first-party source for every
literal they declare (`connector-sharing`, `select-scope`, `search-people`,
`remove-co-owner`, `save-access`, and a per-connection `coOwners` +
`connectorKey` shape) returns nothing. The `runListVisibility` and `coOwners`
vocabulary that does exist belongs to the per-project, per-run and per-skill
co-owner mechanics, which are different surfaces. So the three are recorded
here by name, `allowlist.json` gains nothing (it is shrink-only), and the
functional-acceptance suite stays red for them until the host code lands and a
driver can read it — which is what "preserved" means for this pull request: it
records the adoption and waits, rather than buying a green with an allowlist
entry the ratchet forbids.

**No issue owns those three surfaces yet.** A search of this repository's open
and closed issues for `connector-sharing`, `connector-sharing-rollup`,
`connector-sharing-locked` and for a per-connection sharing feature found none,
so this record names the surfaces without one; the issue that draws them will
name this record back.

The response body is frozen beside the checker's other fixtures under
`scripts/ci/__tests__/__fixtures__/design-pin-drift/published-2026-09-10/` with
its own receipt. A frozen fetch is written FORWARD, never over an earlier one:
the 2026-08-28 rows still describe the fetch of that day, and the unit suite
resolves a pin's adopted body from the newest directory that carries its file,
so the `app-connectors` body of 2026-08-28 is a drift input now.

## Running it locally

```sh
node scripts/ci/design-pin-drift.mjs                 # fetches the published manifests
node scripts/ci/design-pin-drift.mjs --event push-main
pnpm exec vitest run --config vitest.config.ts scripts/ci/__tests__/design-pin-drift.test.mjs
```

The unit suite needs no network: it runs the checker against the frozen
2026-08-28 bodies (the adopted, zero-drift set), against the superseded bodies
beside them (the drift set), against the committed manifest copies, and against
one fixture per failure outcome.
