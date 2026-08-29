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
  drawing. Three of the five known drifts below are this case, and the
  functional-acceptance suite would stay green through a blind re-pin of them.
  Nothing downstream catches it, which is precisely why the hashes are compared
  here and why a re-pin is still an adoption: the claim "this repo verified
  against THAT artifact" stops being true the moment the hash is edited without
  someone checking what moved.

Replacing the committed artifact and both hashes is the *first* step of an
adoption, never the whole of it.

## Rollout state

**Not yet a required check.** cinatra#3057 lands in two parts:

- **(a) this page's state.** The job runs on every pull request, on
  `merge_group`, on every push to `main` and on dispatch — its own job, not a
  step in `gates`, because `gates` is a required context and a red here has to
  be visible without blocking anything yet. The first `main` run is expected red
  with five drifts. Nothing is blocked by it: no context for it is listed in
  `.github/branch-protections.json`, and the PR that adds this job deliberately
  does not add one.
- **(b) the follow-up.** Once the exact check name has been observed on a real
  run, a separate PR adds that context to `.github/branch-protections.json` and
  applies the live protection from that file. Both PRs touch `.github/**` and
  follow the high-risk path. cinatra#3057 closes after (b), not before.

## Known drifts

Measured 2026-08-28 against the published manifests. The five frozen bodies are
committed under
`scripts/ci/__tests__/__fixtures__/design-pin-drift/published-2026-08-28/`, with
a `capture.json` receipt recording each one's URL, date, status, byte length and
hash — so any row below can be re-checked by hand with
`curl -sS <url> | shasum -a 256`. All five pins differ in **both** hashes.
**No adopting issue is filed for any of them yet**; each needs its own, and the
right-hand column is a to-do, not a record.

| Pin | Outcome | What differs | Adopting issue |
| --- | --- | --- | --- |
| `app` | `drift` | a declaration change: one additional surface, `sidebar-assistants-entry`, which has no driver and no harness mount here | none filed |
| `app-components` | `drift` | a declaration change: `scheduling-trigger-tab` is gone; `breadcrumb-entity-resolution` and `scheduling-step-configured` are new | none filed |
| `app-extensions` | `drift` | **hashes only** — the published manifest declares byte-identical surfaces; the spec source moved under an unchanged drawing | none filed |
| `app-connectors` | `drift` | **hashes only** — byte-identical surfaces | none filed |
| `app-notifications` | `drift` | **hashes only** — byte-identical surfaces | none filed |

The split matters. Only the first two would ever reach the
functional-acceptance suite; the other three are visible **here and nowhere
else**, which is the case this job was written for.

`app-components` is the most expensive of the five and the reason the "who moves
a pin" rule is written the way it is. Adopting it costs three things in one
commit, none of which a hash edit provides:

1. `scheduling-trigger-tab` is retired **with** the adoption and not before it —
   the currently pinned artifact still declares that surface, and a declared
   surface with no driver and no allowlist entry is a red, so retiring its
   driver and harness mount first would break the suite to record a fact this
   page records without breaking anything.
2. `scheduling-step-configured` declares actions with no counterpart to drive
   until the schedule step itself draws them.
3. `breadcrumb-entity-resolution` has no driver, no harness mount and no
   testid-contract entry anywhere in this repo, and `allowlist.json` is
   shrink-only, so it cannot be exempted — it has to be covered in the same
   commit that moves the pin.

## Running it locally

```sh
node scripts/ci/design-pin-drift.mjs                 # fetches the published manifests
node scripts/ci/design-pin-drift.mjs --event push-main
pnpm exec vitest run --config vitest.config.ts scripts/ci/__tests__/design-pin-drift.test.mjs
```

The unit suite needs no network: it runs the checker against the frozen
2026-08-28 bodies, against the committed manifest copies (the zero-drift set),
and against one fixture per failure outcome.
