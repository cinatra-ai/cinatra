# Attribution correction — cinatra#844 (humanize setup/HITL fallback labels)

## What

The post-merge `truthful-attribution-gate` reported `tree-unverifiable` on the
#844 squash (`7ebc3fd`): the gate could not resolve tree(merged) and
tree(reviewed head) to confirm the landed tree was the reviewed one, and
correctly failed closed.

## Cause

A resolution failure, not a mismatch. #844's head branch lived on a fork
(`marcushorndt/cinatra:fix/815-humanize-field-labels`), and the gate's shallow
(`fetch-depth: 1`) checkout could not resolve the reviewed-head commit
(`2ecc1cbccd5acc5447f1d91e5396fc8ae6f0961a`) at verification time, so the
anti-fabrication tree-binding step had nothing to compare against.

## Out-of-band verification

Performed on a full clone immediately after the red run
(`git fetch origin main +refs/pull/844/head`):

```
git rev-parse 7ebc3fd6a9eb8da13c5072b37e124a09b9f97f06^{tree}
60fa45169535cf80f4e48d81e3a97f87d603ae66
git rev-parse 2ecc1cbccd5acc5447f1d91e5396fc8ae6f0961a^{tree}
60fa45169535cf80f4e48d81e3a97f87d603ae66
```

The trees are identical: the tree that landed on `main` is byte-for-byte the
tree @groganz approved (two APPROVED reviews, both bound to commit `2ecc1cb`).
The human arm on the squash commit (`Reviewed-by: Sandro Groganz
<sandro@cinatra.ai> (@groganz, tier=maintainer)`) is therefore valid.

## Correction

This docs-only forward correction records the verification and greens the
`main` tip. Lesson: fork-headed PRs can leave the post-merge gate unable to
resolve the reviewed head. Loop-opened PRs now push their branches to the org
repo directly (not forks), which keeps the reviewed head resolvable to the
gate; fork-headed PRs remain subject to this failure mode until the gate
fetches `refs/pull/<n>/head` explicitly.
