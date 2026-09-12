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
- **A diff that touches the map** touches the ids whose **entry** changed, on the
  same granularity and for the same reason; it touches every id when it moves
  `globalPaths` or the set of pin ids, which decide what the gate reads rather
  than what one pin adopts.
- **A diff that touches the shared driver file** touches the ids whose **driver
  block** changed. The paragraph below states how a block is attributed.
- **A diff that touches the checker or the workflow** touches every id. Those
  change what the gate itself decides, so after such a change no pin's silence is
  trustworthy.
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

### How a shared file is attributed

Three files are listed under every pin — the pin file, the map, and the shared
driver file `tests/e2e/design/conformance/contract.ts` — so a whole-file rule on
any of them reads a one-line edit as every pin, and an adoption goes red on every
other pin that drifts (cinatra#3421: two adoptions red each other, and a seed-helper
edit red all four drifts). Each is attributed by the part of it that changed
instead. **The pin file and the map** by the *entry*: the pins whose entry differs
between the diff base and the head. **The driver file** by the *driver block*,
stated by the file's own structure — a block is one top-level declaration (the
exported driver constants per drawing, and the helpers beside them), running from
its declaration, with the comment written directly above it, to the line before the
next declaration; `SURFACE_DRIVERS` binds a manifest surface id to the block that
drives it, and each pin's manifest declares the surface ids that pin owns. A
changed line therefore answers in exactly one of three ways: a block the table
binds to pinned surfaces attributes to **those pins**; a block the table reaches
only through a computed entry (a family factory spread over a fixture list, whose
surface ids the file cannot name without running it), together with the table's own
braces and comments, attributes to **every pin** — fail-closed; and a block the
table never names — a shared helper such as the seed helper, the imports, the
preamble — attributes to **no pin**. Both sides of the cut are read: a deleted or rebound line
exists only in the base file, so the base text is attributed by the removed line
range and the head text by the added one, and the answer is the union — a
head-only reader would credit a deletion to whatever closed over the gap and
never ask the pin that owned it. Every base-side read names the same merge base
the three-dot path diff already uses, so an entry the target branch moved after
the cut is never read as this branch's adoption. Everything unreadable stays
fail-closed: no diff base, an unparseable file, a declaration this reader cannot
see as a block boundary, diff output carrying no line range, or a
surface-to-driver table the checker cannot find is every id, exactly as a
pin-file edit with no base already was. The rule
"a pin moves only with its adoption" is untouched by this: it changes who is asked,
never what.

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

**One: `app-connectors`.** Its published body redeclares the manifest (three
sharing surfaces gained), so it moves with the drivers and harness mounts that
answer those surfaces and is adopted where those live, not here — until that
lands, the `push`-to-`main` arm, red on any non-`match` outcome, reports that
single drift. The four other pins read `match` on both arms after the
2026-09-12 reconciliation. The record of what each adoption changed is below;
the bodies that were drifting are kept as the checker's own drift fixtures (see
`superseded-pins-2026-08-28/` and `superseded-pins-2026-09-12/` beside the
frozen published ones), because a gate whose drift path has no input is a gate
whose drift path is untested.

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

## Reconciliation record — 2026-09-12

Measured 2026-09-12 against the manifests published under `publishedBaseUrl`.
Each published body was fetched into a scratch directory outside the tree and
its `surfaces` array compared, as parsed JSON, with the committed copy under
`tests/e2e/design/conformance/manifests/`: for `app`, `app-components` and
`app-extensions` the declarations are byte-identical and only the embedded
`contentHash` moved — the second of the two cases "why a hash-only re-pin is
refused" names, the one nothing downstream catches. The committed artifact of
each of those three rows is now the verbatim published body, and both hashes in
`conformance-pins.json` were re-derived from it through the checker's own
functions, never typed. `app-connectors` keeps the artifact and the hashes it
had.

| Pin | Was | What the adoption changed | Cost |
| --- | --- | --- | --- |
| `app` | `drift` | **hashes only** — byte-identical surface declarations | re-pin |
| `app-components` | `drift` | **hashes only** — byte-identical surface declarations | re-pin |
| `app-extensions` | `drift` | **hashes only** — byte-identical surface declarations | re-pin |
| `app-connectors` | `drift` | three surfaces gained (`connector-sharing`, `connector-sharing-locked`, `connector-sharing-rollup`) — adopted with its drivers by the pull request of #3374 | not this diff |
| `app-notifications` | `match` | nothing — the published body is still the pinned artifact | none |

`app-connectors` is the one pin this reconciliation does not adopt: its
published body redeclares the manifest, so it takes the drivers and harness
mounts with it and is adopted where those live. Until that lands, the
`push`-to-`main` arm — red on any non-`match` outcome — reports that single
drift; the four other pins read `match` on both arms.

## Running it locally

```sh
node scripts/ci/design-pin-drift.mjs                 # fetches the published manifests
node scripts/ci/design-pin-drift.mjs --event push-main
pnpm exec vitest run --config vitest.config.ts scripts/ci/__tests__/design-pin-drift.test.mjs
```

The unit suite needs no network: it runs the checker against the frozen
2026-09-12 bodies (the adopted set — four `match`es and the one `app-connectors`
drift the section above names), against the superseded bodies frozen beside
each reconciliation (the drift sets), against the committed manifest copies,
and against one fixture per failure outcome.
