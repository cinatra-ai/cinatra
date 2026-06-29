# Attribution-record correction — #719 combined workflow fixes, squash trailer-split (the Truthful Attribution protocol §5)

This note is the forward correction (truthful verification-record spec — the
Truthful Attribution protocol §5) for the attribution record that landed with the
squash merge of PR #719 (`ci: combine three workflow fixes (#665, #676, ci#32)`,
squash commit `75574c1dcbdb327c9328772a96130ca6de91e934`, which closes #665, #676
and cinatra-ai/ci#32).

## What landed

PR #719 combines three already-owner-approved single-file workflow fixes into one
PR off current `main` (so each is up-to-date by construction and the owner approves
once instead of re-approving each as it goes stale under strict-up-to-date +
dismiss-stale-reviews branch protection); each change is byte-identical
(sha256-verified) to its approved source PR head:

- `.github/workflows/skills-drift-gate.yml` (ci#32): bump the reusable
  `cinatra-ai/ci` skills-drift gate pin from `@a181cfe` (v0.1.0-next) to
  `@83ca29ef` (v0.1.1), which replaces the inline push-arm block with a shared,
  unit-tested `collect-skills-acks.sh` so the squash-body `Skills-*` markers are
  honored on push-to-main; both the workflow `@ref` and the `ref:` input move
  together.
- `.github/workflows/wp-drupal-uat.yml` (#665): mint a per-run throwaway base64
  32-byte AES `NANGO_ENCRYPTION_KEY` in both the uat-gate and nightly jobs (neither
  exported it, so nango booted with a blank key and the 07:00Z nightly went red),
  and extend the env-presence guard to assert it before `docker compose up`.
- `.github/workflows/dockerhub-publish.yml` (#676): convert the Docker Hub mirror
  trigger from `push: tags: v*` (which raced the canonical builder) to
  `workflow_run` on "Build and publish image" so the mirror starts only AFTER the
  builder succeeds, resolving VERSION from `workflow_run.head_branch` (the tag).

All three files are under `.github/**`, which is the §3 high-risk glob in
`.github/gate-suite.json` `highRiskPaths`. So #719 is a **high-risk** change. It
was reviewed and approved by **@groganz at tier=maintainer** and merged to `main`
as squash commit `75574c1dcbdb327c9328772a96130ca6de91e934`.

## What was wrong

The PR-head branch commit carried both `Assisted-by` trailers in the gate's
accepted form (`Claude Code (claude-opus-4-8)` + `codex (gpt-5.5)`) as the terminal
trailer block. But GitHub's **server-side squash** appended an auto-generated
identity trailer — `Co-authored-by: groganz-bot[bot] <…>` — as a SEPARATE trailing
block after a blank line, so the synthesized squash message ends:

```
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: codex (gpt-5.5)

Co-authored-by: groganz-bot[bot] <groganz-bot[bot]@users.noreply.github.com>
```

`git interpret-trailers --parse` only returns the FINAL contiguous trailer block,
so it saw only the `Co-authored-by` line and missed both `Assisted-by` lines — the
`Assisted-by` records were present but no longer terminal. The post-merge
(default-branch push) arm on `main` therefore went RED (verbatim job-log lines):

```
[error] no-record: record invalid: missing Assisted-by — mandatory on every merge ("Assisted-by: none" for human-only changes)
[error] no-record: record invalid: no verification arm — need a Reviewed-by (human arm) or a Gate-suite+Accountable (gate arm)
[error] high-risk-without-maintainer: high-risk change but no passing tier=maintainer Reviewed-by in the record (high-risk requires the human arm; the gate arm alone is rejected)
```

All three errors trace to the same single defect: the trailing `Co-authored-by`
block split the record so the parser never reached the `Assisted-by` block (nor
any verification arm, which #719's squash body also lacked). The local commit-msg
hook that normally strips the AI `Co-authored-by` and re-anchors `Assisted-by`
as the terminal block did NOT run, because the squash was performed server-side.
This is the same post-merge trailer-anchoring defect class as the `[1m]`-suffix
malformations corrected for #685 / #686 and the orphaned/absent machine arm
corrected for #638 / #672 in this directory; it differs only in the proximate
cause (a server-appended `Co-authored-by` block displacing the terminal record).

## The correction

The truthful record for `75574c1dcbdb327c9328772a96130ca6de91e934` is exactly the
one the PR-head branch carried, with the displaced lines re-anchored as a single
clean terminal trailer block and the machine verification arm that the change was
eligible for supplied:

```
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: codex (gpt-5.5)
Gate-suite: cinatra-core@2026.06.4
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
```

Nothing about #719's content, its high-risk classification, or its tier=maintainer
review changes — the change was genuinely owner-approved at tier=maintainer on the
reviewed head, and only the post-merge RECORD was malformed by the server-appended
co-author block. The post-merge gate validates the first-parent diff of the commit
it runs on; this correction commit touches only `docs/governance/**` (not any
high-risk glob), so it is non-high-risk and self-verifies via the machine arm,
exactly as the #638 high-risk-original correction did. This docs-only governance
note carries the `Correction-for:` trailer that the post-merge gate consumes to
clear the blocked line, plus its own valid machine arm.
