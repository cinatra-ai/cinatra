# Attribution-record correction — 2efb4f63 (#1000 marketplace accent palette + core__0016 migration)

Forward correction (the Truthful Attribution protocol §5) for the verification
record of squash commit `2efb4f639b205142a747bfe9009b4415de58664b` (PR #1000,
"feat(marketplace): accent palette to the spec categorical set + core__0016
CHECK migration"), which under-attributes the merge: it dropped one of the
PR's two material `Assisted-by` contributors.

## What landed

PR #1000 (item 7 of #988) reconciles `EXTENSION_ACCENTS` — in both
`src/lib/extension-accent.ts` and its `packages/sdk-ui` mirror — to the pinned
design spec's seven categorical accent hexes, and pairs it with the
`migrations/core/core__0016_accent-palette-spec-categorical.mjs` DB `CHECK`
migration (plus its `migrations/manifest.json` entry) that remaps persisted
`accent_color` values on both surfaces and swaps the constraint. It closes `#988`
and was merged to `main` as squash commit
`2efb4f639b205142a747bfe9009b4415de58664b`.

Because the change touches `migrations/**`, it matches the `**/migrations/**`
entry in `.github/gate-suite.json` `highRiskPaths` — #1000 is correctly
**high-risk**, and correctly required (and carried) the human arm: a real,
non-self `Reviewed-by` from `@groganz` at `tier=maintainer`, who approved the
PR (two `APPROVED` reviews recorded on 2026-07-05T07:26Z) on the reviewed
branch tip `8b6461699b7c3f850e915b2e4e1b84dc51cd0e16`, where all 30 non-skipped
checks — including the pre-merge `truthful-attribution-gate` — concluded
success. The merge itself is sound and unaffected by this correction.

## What was wrong

The PR-head working commit (`aafd7229f0768789ca670566fbf489a85f9c2cd2`,
"feat(design): reconcile the accent palette to the spec categorical set +
core__0016 CHECK/remap migration (#988 item 7)") carried both material
contributors in the gate's accepted form:

```text
Assisted-by: Claude Code (claude-fable-5)
Assisted-by: Codex CLI (gpt-5.5)
```

Codex CLI materially shaped this diff (the migration's guarded-DO-block
shape, the remap/CHECK ordering, and the live-Postgres verification
sequence). But the GitHub squash-merge synthesis for #1000 carried forward
only the first `Assisted-by` line — the merge commit's trailer block reads:

```text
Assisted-by: Claude Code (claude-fable-5)
Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
```

Codex CLI's line was silently dropped in transcription. Unlike the run of
prior corrections in this directory, this is **not** a gate-visible defect:
the resulting trailer block is fully well-formed (single-line `Assisted-by`,
a genuine `Reviewed-by` matching a real, non-self, non-stale approval at
`tier=maintainer` by a login holding maintainer permission) — the post-merge
`truthful-attribution-gate` run on `2efb4f639b205142a747bfe9009b4415de58664b`
concluded `success`. The gate's presence/anti-fabrication checks verify that
what's recorded is truthful; they do not cross-reference the recorded
`Assisted-by` set against the PR's working-commit history to catch an
under-count. So the merge is green but the record it left on `main` is
incomplete: it under-attributes Codex CLI's material contribution to #1000.

## Root cause: a dropped contributor line, not an invalid record

The defect is a transcription loss during squash synthesis, not a
verification gap or a malformed field. #1000's substance, its high-risk
classification, and its genuine tier=maintainer human-arm review are all
correct and unchanged by this correction; only the historical `Assisted-by`
set on the merge commit needs to be completed to match what the PR's own
working commit — and the actual authorship of the diff — already recorded.

## The correct record

The verification record `2efb4f639b205142a747bfe9009b4415de58664b` should
have carried is:

```text
Assisted-by: Claude Code (claude-fable-5)
Assisted-by: Codex CLI (gpt-5.5)
Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
```

— both authoring agents, unchanged, and the same genuine human arm the merge
already carried.

## The correction

This forward, docs-only note records that intended record. Its own squash
carries `Correction-for: 2efb4f639b205142a747bfe9009b4415de58664b` plus its
own verification arm. This correction touches only `docs/governance/**` —
not any `highRiskPaths` glob — so it is non-high-risk and self-verifies via
the machine arm (`Gate-suite` + `Accountable`). Landed via a pull request so
the gate can verify that arm with PR context, per protocol §5.
