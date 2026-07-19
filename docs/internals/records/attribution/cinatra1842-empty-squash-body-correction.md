# Correction: empty squash body on 5dda4a8b (PR #1842)

**Corrected commit:** `5dda4a8b91782b9ada85491257fc23fa03b78096` (main, 2026-07-19) —
squash merge of PR #1842, "feat(objects): claim-lifecycle R3+R4+R2 - restore
reactivation, serialized resumable archival, all-scopes retirement (#1842)".

## What went wrong

The squash landed with a **subject line only** — no body and **no trailers** — so the
`truthful-attribution-gate` on the merged SHA is red. The coordinator's merge shell
referenced a squash-body file that an earlier, aborted merge attempt was supposed to
have created (that attempt exited at its checks-clean guard *before* writing the file).
The `$(cat …)` substitution failed open to an empty string and the REST squash-merge
call proceeded. The diff, subject, and sha-pinning were all correct; only the body was
lost.

## The true record for 5dda4a8b

The intended body (verbatim, as prepared for the reconciled head `1bf5737d`):

> R3: fail-closed reactivation seam fired before the activate transition via
> runInstallAnchorClaimActivation - a restored type is live and bindable
> immediately, no boot cycle; failed reactivation compensates with a fresh op
> and aborts the restore. R4: uninstall/archive/restore serialized under
> withInstallLock; drain-to-fixpoint acquireArtifactRetirementOperation resumes
> stranded running ops under the (scope,package) advisory xact lock; per-batch
> status rechecks during archival. R2: retireArtifactExtensionClaimsAllScopes
> over the 4-source scope union (claims / canonical rows / eligible assertion
> orgs / unreplayed op scopes), wired into platform-admin hard-delete and
> forceDelete. R1 platform (NULL-org) semantics stay owner-flagged on #1837;
> the R2 purge leg is a deferred diagnostic follow-up. Proven on live Postgres:
> 6 scenarios incl. kill-mid-archival resumption and injected-failure rollback.
> Rebase-reconciled after #1843 (route-graph baseline only; product diff
> patch-id-identical to the first approved head).
>
> Part of #1837
>
> Assisted-by: Claude Code (claude-opus-4-8)
> Assisted-by: Codex (gpt-5.6-sol)
> Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)

Every line of that record is true of `5dda4a8b`: the diff was produced by the
Claude Code lane (claude-opus-4-8) with Codex (gpt-5.6-sol) materially converging
design/build/proof, and groganz's real GitHub approval sits at the merged head
`1bf5737d1e858dfa5d5a56a5d4c40a69196da370` (re-approved after the mechanical
route-graph-baseline reconcile; product diff patch-id-identical to the first
approved head `1a46b2d5`).

## Lesson

A squash `--body-file` may only be consumed by the shell that **wrote and verified
it non-empty** (`[ -s "$B" ]`) immediately before the merge call. Never reference a
body file whose creation belonged to a different (possibly aborted) shell.
