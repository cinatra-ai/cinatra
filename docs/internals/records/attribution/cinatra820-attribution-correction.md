# Attribution correction — cinatra#820 (required-extension lock refresh)

## What

The post-merge `truthful-attribution-gate` reported `tree-mismatch` on the #820
squash (`4a29e1094`): the landed tree did not match the tree the checks ran on, so
the machine arm's contexts did not bind.

## Cause

#820 was updated to the then-current main, but another PR (#828) merged in the
interval before #820 was admin-merged, so #820 had silently gone BEHIND again. An
`--admin` squash of a behind PR lands a merged tree (new main + #820) that differs
from the reviewed-head tree (old main + #820), tripping `tree-mismatch`. The
content of #820 (the required-extension lock refresh + regenerated connector maps)
is correct and green; only the attribution record failed to bind.

## Correction

This docs-only forward correction greens the `main` tip with a valid machine arm.
Lesson (reinforces the admin-merge-only-up-to-date rule): re-verify `mergeStateStatus`
== up-to-date IMMEDIATELY before an admin squash, not just after update-branch — a
sibling merge in the interval re-buys the behind state.
