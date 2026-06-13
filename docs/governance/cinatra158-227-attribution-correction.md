# Attribution-record correction — #227 install/update durability merge (cinatra-engineering#119 §5)

This note is the forward correction (truthful verification-record spec
cinatra-engineering#119 §5) for the attribution record that landed with the
squash merge of PR #227 (`fix(cinatra#158): install/update durability —
append-only journal, EXDEV fix, required deps, durable-restore events`,
merge commit `8cc1d72375722e293af9e73524e97c9fe46e429e`).

## What was wrong

The #227 squash record itself is **well-formed**: it carries one-per-line
`Assisted-by` trailers with base model-ids and a human verification arm
(`Reviewed-by` from the maintainer), i.e.

```
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: Codex (gpt-5-codex)
Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
```

The defect is **not** in the trailer block. The post-merge (default-branch
push) `truthful-attribution-gate` run on `main` failed with this tree-identity
error (verbatim job-log line):

```
[tree-mismatch] tree(merged) != tree(reviewed head) — the landed tree is not what was reviewed; approvals/contexts do not bind
```

### Root cause: squash-merge while BEHIND main (base advancement)

PR #227 was approved by the maintainer (@groganz) at its reviewed head
`a9d5dc8edfaee4f6e2c1f92ba7f1961b7f417dca`. Between that approval and the
merge, `main` advanced (PRs #223 and #226 landed first), so the merge parent
became `b7c0a44f39112ad0b6add219c5fdf66bc3854568`. `main` protection requires
branches be up to date before merge (`required_status_checks.strict = true`),
so merging #227 while behind its base required an admin override; the merge was
performed by @groganz. The squash applied #227's approved diff onto the
advanced base, producing merge commit `8cc1d723` with tree
`681c98ff26b8cd41a5ba43794f4358185c7e6f5a`.

Because the gate computes `reviewedHeadSha` from the approval and compares the
*tree object* of the landed merge against the *tree object* of the reviewed
head, the base advancement made `tree(merged) != tree(reviewed head)` even
though the **#227 diff landed intact**. This is a tree-hash divergence caused
purely by base advancement — there was **no content tampering** and no change
to the approved diff.

### Evidence the #227 diff landed intact

- **Patch-identity match.** The approved-head diff (reviewed head
  `a9d5dc8` against its merge-base with the advanced base) and the landed
  squash diff (merge `8cc1d723` against its parent `b7c0a44f`) have the **same
  `git patch-id`** (`8c4097355443e39d1618a161c16dbd65c43e6dd3`) and the same
  shape (25 files, +1333 / −420): the approved and landed diffs are
  patch-identical. The only difference between reviewed and merged is the
  surrounding (unchanged) base, which is what moved the tree hash.
- The #227 content is present at the merged SHA — e.g.
  `migrations/core/core__0005_extension-install-ops-append-only.mjs` and
  `src/lib/extension-install-ops.ts` both exist at `8cc1d723`.
- All other post-merge check-runs on the merged SHA either **succeeded or were
  skipped**; only `truthful-attribution-gate` failed (with the tree-mismatch
  error above). The succeeded checks include the content- and
  migration-sensitive ones: `build`, `Typecheck and unit tests`,
  `Core-store schema migration gate`, `Extension-anchor lifecycle DB tests`,
  `Presence-degraded build (required-only universe)`,
  `Better Auth schema parity`, and the browser e2e suites.

(For substance review history: the #227 squash record states the change was
Codex-converged with an independent Codex security review,
APPROVE-WITH-CAVEATS / 0 blocking. That is reproduced here as context from the
#227 record, not re-verified by this correction.)

### No production migration ran

The #227 record describes `core__0005` as a destructive core migration.
Production migrations are **not** applied by merge — core deploy is manual and
the last production deploy predates this merge (2026-06-08). No production
migration ran as a result of the #227 merge; this correction has no bearing on
production data state.

## The corrected record

Per §5 (detection + forward correction), this change carries a well-formed
truthful verification record bound to the defective merge SHA via a
`Correction-for:` trailer. Because the tree-mismatch invalidated the binding of
the original approval/contexts to the *landed* tree, the correction re-binds the
verification arm on a PR whose head is up to date with `main` — so its own
reviewed-head tree equals the tree it lands.

This correction's verification arm is the **human arm**: a real maintainer
approval of this PR (mirroring the §5 precedent cinatra#211, which corrected the
#206 merge record and whose own post-merge gate concluded success). The record
is valid only once that maintainer approval exists at the merged head. The
squash record this PR will carry is:

```
Assisted-by: Claude Code (claude-opus-4-8)
Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Correction-for: 8cc1d72375722e293af9e73524e97c9fe46e429e
```

(The `Reviewed-by` line is composed at merge time from the maintainer's real
PR approval; the PR is authored by the dedicated machine identity
`cinatra-agent-bot[bot]` so that author ≠ approver holds.)

**Operational condition (avoid recurring the same defect):** opening this PR
off current `main` is necessary but not sufficient. If `main` advances again
after the maintainer approves, the same tree-mismatch can recur. This PR must be
approved at, and merged from, a head equal to the tree that lands — i.e. merged
before any further base advancement, or refreshed and re-approved.

The code merged in #227 (commit `8cc1d723`) remains merged and unchanged; this
is a record-only correction.

## Summary

| Field | Value |
|---|---|
| Corrected-for merge | `8cc1d72375722e293af9e73524e97c9fe46e429e` (PR #227) |
| Reviewed head of #227 | `a9d5dc8edfaee4f6e2c1f92ba7f1961b7f417dca` (approved by @groganz) |
| Merge parent (advanced base) | `b7c0a44f39112ad0b6add219c5fdf66bc3854568` (after #223, #226) |
| Defect | `tree-mismatch` — base advancement only; #227 diff landed intact (patch-id match) |
| Content tampering | none |
| Production migration run | none (manual core deploy; last 2026-06-08) |
| Verification arm | human (maintainer `Reviewed-by`) |
| Precedent | cinatra#211 (§5 forward correction of #206) |
