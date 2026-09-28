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

**One, adopted on 2026-09-18 — and this round was NOT a hashes-only re-pin.**
`app-extensions` drifted a fourth time and the `design-pin-drift` job was red on
the default branch until the 2026-09-18 adoption below took it: four pins read
`match` and that one read `drift`. Unlike the three rounds before it, the cause
was not a spec source that moved under an unchanged drawing. The published body
declares **sixteen** surfaces where the pinned one declared thirteen: the
thirteen are field-for-field identical and three are new —
`upload-extension-screen`, `upload-github-form` and
`upload-resolved-install-panel`, section VIII of the drawing, the Upload
Extension screen. That is the class this page's own rule names, so the pin moved
together with the drivers, the harness mounts and the stable-id contract that
answer those surfaces; a hashes-only re-pin would have been refused. With that
adoption all five pins read `match` against the published manifests, including
on the `push`-to-`main` arm that is red on any non-`match` outcome.

**Then one more, reconciled on 2026-09-26 — hashes-only again.** The design
source changed the wording of the `app-extensions` drawing for cinatra#3683 (its
text and version, no drawn example) and republished the manifest, so
`app-extensions` drifted a fifth time and the `design-pin-drift` job was red on
the default branch: four pins read `match` and that one read `drift`. Compared as
parsed JSON with the pinned body, `schemaVersion`, `spec` and all sixteen
surfaces are unchanged and `contentHash` alone moved — the class the 2026-09-13
and 2026-09-17 rounds already recorded. The 2026-09-26 reconciliation below
re-pinned it, and all five pins read `match` again, on both arms.

**Then one more the same day, reconciled on 2026-09-26 in a second round —
hashes-only.** The design source added one sentence to the Breadcrumb section of
the components drawing for cinatra#3693 (its text and version, no drawn example)
and republished the manifest, so `app-components` drifted and the
`design-pin-drift` job would have gone red on the next push to the default
branch: four pins read `match` and that one read `drift`. Compared as parsed JSON
with the pinned body, `schemaVersion`, `spec` and all three surfaces are
unchanged and `contentHash` alone moved. The second 2026-09-26 reconciliation
below re-pinned it hashes-only, and all five pins read `match` again, on both
arms.

Seven adoptions got them there and all seven are recorded below: the 2026-09-10
adoption of `app-connectors`, whose published body redeclares the manifest
(three sharing surfaces gained) and therefore moves with the drivers and harness
mounts that answer those surfaces — it landed with cinatra#3374 — the 2026-09-12
hashes-only re-pin of `app`, `app-components` and `app-extensions`, the
2026-09-13 and 2026-09-17 hashes-only re-pins of `app-extensions` alone, each
after the design source republished its spec under a byte-identical drawing, and
the 2026-09-18 adoption of `app-extensions` with its three new surfaces,
the 2026-09-26 hashes-only re-pin of `app-extensions` after the wording change,
and the second 2026-09-26 hashes-only re-pin of `app-components` after the
Breadcrumb sentence.
`app-notifications` has not moved since 2026-08-30.

A published manifest can republish more than once under one drawing, and
`app-extensions` did three times: the 2026-09-12 round adopted its
republication, the 2026-09-13 round below adopted the next one, and the
2026-09-17 round the one after that. The fourth round is a different thing
altogether — the drawing itself gained a section. Each round keeps its own
frozen pair — the bodies it adopted and the bodies it superseded — so no record
has to be rewritten for another to be true.

The bodies a pin named before an adoption are kept as the checker's own drift
input (see `superseded-pins-2026-08-28/`, `superseded-pins-2026-09-12/`,
`superseded-pins-2026-09-13/`, `superseded-pins-2026-09-17/`,
`superseded-pins-2026-09-18/`, `superseded-pins-2026-09-26/` and
`superseded-pins-2026-09-26-r2/` beside the frozen published ones, and every row a later frozen fetch superseded), because
a gate whose drift path has no input is a gate whose drift path is untested.

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

### 2026-09-10 — `app-connectors` (cinatra#3374, unblocking cinatra#3372)

Adopted the published `app-connectors` manifest fetched from the pin file's
`publishedBaseUrl` on 2026-09-10 (HTTP 200, 4821 bytes,
`2b98802f27fb…`), byte-identical on a second fetch. The committed artifact
under `tests/e2e/design/conformance/manifests/app-connectors.json` is that
response verbatim and both hashes in `conformance-pins.json` were re-derived
from it, never typed. The four other pins were not touched.

| Pin | Was | What the adoption changed | Cost |
| --- | --- | --- | --- |
| `app-connectors` | `drift` | three surfaces gained: `connector-sharing`, `connector-sharing-rollup`, `connector-sharing-locked`; the eight surfaces the pin already declared are byte-identical; the embedded spec-content hash moved with them | one driver each, written against the host code cinatra#3374 lands; `allowlist.json` unchanged |

What moved, surface by surface:

- **`connector-sharing`** declares four field bindings (`name <- connection.connectionId`, `url <- connection.connectorKey`, `access <- policy.runListVisibility`, `co-owners <- connection.coOwners`), four actions (`select-scope -> scopes-selected`, `search-people -> people-listed`, `remove-co-owner -> co-owner-removed`, `save-access -> access-saved`) and the `loading` state.
- **`connector-sharing-rollup`** and **`connector-sharing-locked`** declare no field, action or state of their own.
- The eight surfaces already pinned — `connector-connection-filter`, `connector-grid`, `connector-install-cta`, `connector-empty-panel`, `connector-setup`, `connector-multi-setup`, `connector-connections`, `connector-config-tab` — are unchanged, declaration for declaration. Their part of this move is spec-content-only: the spec source changed under an unchanged drawing.

**The drivers land with this adoption.** A driver reads the host code the
surface is drawn by, and when the adoption was first prepared none of the three
gained surfaces had any — which is why that pull request stopped at the record
rather than buying a green with an allowlist entry the ratchet forbids.
cinatra#3374 draws them: the setup page's fixed second tab, Sharing, and the
per-connection panels beneath it. So each of the three now has a driver in
`tests/e2e/design/conformance/contract.ts`, mounted on the harness by
`src/app/design-fixtures/conformance/connector-sharing-fixture.tsx`,
`allowlist.json` gains nothing (it is shrink-only), and this pin reads `match`.

**The issue that owns those three surfaces is cinatra#3374**, which draws the
Sharing tab and adopts this pin as part of the same change, per the rule above:
a pin moves in the issue that validates the new contract and updates the
drivers, harness mounts and proofs together with it.

The response body is frozen beside the checker's other fixtures under
`scripts/ci/__tests__/__fixtures__/design-pin-drift/published-2026-09-10/` with
its own receipt. A frozen fetch is written FORWARD, never over an earlier one:
the 2026-08-28 rows still describe the fetch of that day, and the unit suite
resolves a pin's adopted body from the newest directory that carries its file,
so the `app-connectors` body of 2026-08-28 is a drift input now.

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
mounts with it and is adopted where those live — landed with cinatra#3374, the
2026-09-10 record above, which pins the same body this capture froze. Until it
landed, the `push`-to-`main` arm — red on any non-`match` outcome — reported
that single drift; the four other pins read `match` on both arms.

## Reconciliation record — 2026-09-13

Measured 2026-09-13 against the manifests published under `publishedBaseUrl`.
`app-extensions` republished a second time: its body was fetched into a scratch
directory outside the tree and compared, as parsed JSON, with the committed copy
under `tests/e2e/design/conformance/manifests/`. `schemaVersion`, `spec` and the
whole `surfaces` array — thirteen surfaces, the same ids in the same order,
field-for-field identical — are unchanged; `contentHash` alone moved. That is
again the second of the two cases "why a hash-only re-pin is refused" names, the
one nothing downstream catches: the spec source changed under an unchanged
drawing. The committed artifact of that row is now the verbatim published body,
and both hashes in `conformance-pins.json` were re-derived from it through the
checker's own functions, never typed. No other pin moved.

| Pin | Was | What the adoption changed | Cost |
| --- | --- | --- | --- |
| `app` | `match` | nothing — the published body is still the pinned artifact | none |
| `app-components` | `match` | nothing — the published body is still the pinned artifact | none |
| `app-extensions` | `drift` | **hashes only** — byte-identical surface declarations (13 surfaces) | re-pin |
| `app-connectors` | `drift` | three surfaces gained (`connector-sharing`, `connector-sharing-locked`, `connector-sharing-rollup`) — adopted with its drivers by the pull request of #3374 | not this diff |
| `app-notifications` | `match` | nothing — the published body is still the pinned artifact | none |

`app-connectors` is again the one pin this reconciliation does not adopt, for
the reason the record above already gives, and its published body has not moved
since that round measured it. Until the adoption that owns it lands, the
`push`-to-`main` arm reports that single drift; the four other pins read `match`
on both arms.

## Reconciliation record — 2026-09-17

Measured 2026-09-17 against the manifests published under `publishedBaseUrl`.
All five bodies were fetched into a scratch directory outside the tree and
frozen under
`scripts/ci/__tests__/__fixtures__/design-pin-drift/published-2026-09-17/`
beside the receipt that records each one's url, HTTP status, byte length and
hash. Four came back byte-identical to the artifacts their pins already named;
`app-extensions` republished a third time and was compared, as parsed JSON,
with the committed copy under `tests/e2e/design/conformance/manifests/`.
`schemaVersion`, `spec` and the whole `surfaces` array — thirteen surfaces, the
same ids in the same order, field-for-field identical — are unchanged;
`contentHash` alone moved. That is again the second of the two cases "why a
hash-only re-pin is refused" names, the one nothing downstream catches: the
spec source changed under an unchanged drawing. The committed artifact of that
row is now the verbatim published body, and both hashes in
`conformance-pins.json` were re-derived from it on the branch — the manifest
hash over the file's bytes, the spec-content hash read back out of the adopted
body's own `contentHash` field — never typed. No other pin moved.

| Pin | Was | What the adoption changed | Cost |
| --- | --- | --- | --- |
| `app` | `match` | nothing — the published body is still the pinned artifact | none |
| `app-components` | `match` | nothing — the published body is still the pinned artifact | none |
| `app-extensions` | `drift` | **hashes only** — byte-identical surface declarations (13 surfaces) | re-pin |
| `app-connectors` | `match` | nothing — the published body is still the pinned artifact | none |
| `app-notifications` | `match` | nothing — the published body is still the pinned artifact | none |

Unlike the two rounds above, this one leaves no pin outstanding: `app-connectors`
has read `match` since cinatra#3374 landed its drivers and harness mounts, so
after this adoption the `push`-to-`main` arm — red on any non-`match` outcome —
is green on all five. The body `app-extensions` named before this round is
frozen as the round's own drift input under `superseded-pins-2026-09-17/`, with
the provenance receipt that names the commit its bytes were read from.

## Reconciliation record — 2026-09-18

Measured 2026-09-18 against the manifests published under `publishedBaseUrl`.
The `app-extensions` body was fetched into a scratch directory outside every
repository tree with one anonymous `curl -sS`, and both hashes were derived from
those bytes on the branch — the manifest hash over the file's own bytes, the
spec-content hash read back out of the adopted body's own `contentHash` field —
never typed. The other four answered this round's fetch byte-identical to the
artifacts their pins already named. All five are frozen under
`scripts/ci/__tests__/__fixtures__/design-pin-drift/published-2026-09-18/` beside
the receipt that records each one's url, HTTP status, byte length, hash,
schemaVersion and embedded content hash.

**This round is the first `app-extensions` adoption that is not hashes-only.**
Compared as parsed JSON with the committed copy under
`tests/e2e/design/conformance/manifests/`, `schemaVersion` and `spec` are
unchanged and every one of the thirteen pinned surfaces is field-for-field
identical — but the published body declares **three more**:
`upload-extension-screen`, `upload-github-form` and
`upload-resolved-install-panel`, between them three fields, five actions and two
`loading` states. They are section VIII of the drawing, the Upload Extension
screen, whose product screens shipped with cinatra#3204. So the rule at the top
of this page applies in its own words — a pin moves only in a change that
validates the new published contract and updates the required drivers, harness
mounts and proofs together with it — and this adoption lands the three drivers
(`tests/e2e/design/conformance/contract.ts`), the three harness mounts
(`src/app/design-fixtures/conformance/upload-extension-fixtures.tsx`) and the
three stable-id contract entries in the same change as the pin.
`tests/e2e/design/conformance/allowlist.json` is untouched: with a driver for
each of the three the unmapped-surface red is unreachable, so there is no
exemption to create, and the shrink-only ratchet reads `0 added/widened`.

| Pin | Was | What the adoption changed | Cost |
| --- | --- | --- | --- |
| `app` | `match` | nothing — the published body is still the pinned artifact | none |
| `app-components` | `match` | nothing — the published body is still the pinned artifact | none |
| `app-extensions` | `drift` | **three surfaces gained** (13 to 16; the thirteen field-for-field identical) | re-pin + drivers, harness mounts and stable ids |
| `app-connectors` | `match` | nothing — the published body is still the pinned artifact | none |
| `app-notifications` | `match` | nothing — the published body is still the pinned artifact | none |

Like the round before it this one leaves no pin outstanding: after the adoption
the `push`-to-`main` arm — red on any non-`match` outcome — is green on all
five. The body `app-extensions` named before this round is frozen as the round's
own drift input under `superseded-pins-2026-09-18/`, with the provenance receipt
that names the commit its bytes were read from, and the checker's own suite
asserts both halves of the finding: that the superseded body still classifies as
`drift` in both hashes, and that the body adopted in its place adds exactly
those three surfaces and redraws none of the thirteen.

## Reconciliation record — 2026-09-26

Measured 2026-09-26 against the manifests published under `publishedBaseUrl`.
All five bodies were fetched with one anonymous `curl -sS` each into a scratch
directory outside every repository tree and frozen under
`scripts/ci/__tests__/__fixtures__/design-pin-drift/published-2026-09-26/`
beside the receipt that records each one's url, HTTP status, byte length, hash,
schemaVersion and embedded content hash. Four came back byte-identical to the
artifacts their pins already named. `app-extensions` had republished after the
design source changed the wording of its drawing for cinatra#3683 — its text
and version, no drawn example — and was compared, as parsed JSON, with the
committed copy under `tests/e2e/design/conformance/manifests/`. `schemaVersion`,
`spec` and the whole `surfaces` array — sixteen surfaces, the same ids in the
same order, field-for-field identical — are unchanged; `contentHash` alone moved,
the one line in which the two bodies differ. That is again the second of the two
cases "why a hash-only re-pin is refused" names, the one nothing downstream
catches: the spec source changed under an unchanged drawing. The committed
artifact of that row is now the verbatim published body, and both hashes in
`conformance-pins.json` were re-derived from it on the branch — the manifest
hash over the file's bytes with the checker's own `sha256Hex`, the spec-content
hash read back out of the adopted body's own `contentHash` field — never typed.
No other pin moved.

| Pin | Was | What the adoption changed | Cost |
| --- | --- | --- | --- |
| `app` | `match` | nothing — the published body is still the pinned artifact | none |
| `app-components` | `match` | nothing — the published body is still the pinned artifact | none |
| `app-extensions` | `drift` | **hashes only** — byte-identical surface declarations (16 surfaces) | re-pin |
| `app-connectors` | `match` | nothing — the published body is still the pinned artifact | none |
| `app-notifications` | `match` | nothing — the published body is still the pinned artifact | none |

Because no surface was added, retired or redrawn, no driver, harness mount or
stable-id entry moves with this pin, and
`tests/e2e/design/conformance/allowlist.json` is untouched. Like the two rounds
before it this one leaves no pin outstanding: after the reconciliation the
`push`-to-`main` arm — red on any non-`match` outcome — is green on all five.
The body `app-extensions` named before this round, which is the body the
2026-09-18 adoption took, is frozen as the round's own drift input under
`superseded-pins-2026-09-26/`, with the provenance receipt that names the commit
its bytes were read from, and the checker's own suite asserts both halves of the
finding: that the superseded body still classifies as `drift` in both hashes,
and that the body adopted in its place declares the same sixteen surfaces.

## Reconciliation record — 2026-09-26, second round

Measured 2026-09-26, after the round above, against the manifests published
under `publishedBaseUrl`. All five bodies were fetched again with one anonymous
`curl -sS` each into a scratch directory outside every repository tree and
frozen under
`scripts/ci/__tests__/__fixtures__/design-pin-drift/published-2026-09-26-r2/`
beside the receipt that records each one's url, HTTP status, byte length, hash,
schemaVersion and embedded content hash. The `-r2` suffix names the second round
of that date: the first round's frozen pair is never rewritten, and the
receipt's `fetchedAt` is the plain date. Four came back byte-identical to the
artifacts their pins already named. `app-components` had republished after the
design source added one sentence to the Breadcrumb section of the components
drawing for cinatra#3693 — its text and version, no drawn example — and was
compared, as parsed JSON, with the committed copy under
`tests/e2e/design/conformance/manifests/`. `schemaVersion`, `spec` and the whole
`surfaces` array — three surfaces, the same ids in the same order,
field-for-field identical — are unchanged; `contentHash` alone moved, the one
line in which the two bodies differ. That is again the second of the two cases
"why a hash-only re-pin is refused" names: the spec source changed under an
unchanged drawing. The committed artifact of that row is now the verbatim
published body, and both hashes in `conformance-pins.json` were re-derived from
it on the branch — the manifest hash over the file's bytes with the checker's
own `sha256Hex`, the spec-content hash read back out of the adopted body's own
`contentHash` field — never typed. No other pin moved.

| Pin | Was | What the adoption changed | Cost |
| --- | --- | --- | --- |
| `app` | `match` | nothing — the published body is still the pinned artifact | none |
| `app-components` | `drift` | **hashes only** — byte-identical surface declarations (3 surfaces) | re-pin |
| `app-extensions` | `match` | nothing — the published body is still the pinned artifact | none |
| `app-connectors` | `match` | nothing — the published body is still the pinned artifact | none |
| `app-notifications` | `match` | nothing — the published body is still the pinned artifact | none |

Because no surface was added, retired or redrawn, no driver, harness mount or
stable-id entry moves with this pin, and
`tests/e2e/design/conformance/allowlist.json` is untouched. The same
republication also moved `app-artifact-review`, which is not a pin: it is a
staged manifest this gate does not read, recorded with its own hashes in the
staging test beside the conformance manifests, and it joins the pin gate only
with the adoption that covers every one of its surfaces. After this
reconciliation the `push`-to-`main` arm — red on any non-`match` outcome — is
green on all five. The body `app-components` named before this round, which is
the body the 2026-09-12 reconciliation took, is frozen as the round's own drift
input under `superseded-pins-2026-09-26-r2/`, with the provenance receipt that
names the commit its bytes were read from, and the checker's own suite asserts
both halves of the finding: that the superseded body still classifies as
`drift` in both hashes, and that the body adopted in its place declares the same
three surfaces.

## Running it locally

```sh
node scripts/ci/design-pin-drift.mjs                 # fetches the published manifests
node scripts/ci/design-pin-drift.mjs --event push-main
pnpm exec vitest run --config vitest.config.ts scripts/ci/__tests__/design-pin-drift.test.mjs
```

The unit suite needs no network: it runs the checker against the frozen
published bodies, each pin served the body of the newest capture that carries
its file (the adopted set — five `match`es), against the superseded bodies
frozen beside each reconciliation (the drift sets), against the committed
manifest copies, and against one fixture per failure outcome.
