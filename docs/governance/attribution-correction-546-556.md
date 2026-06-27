# Attribution-record correction for #546 + #556 (Skills Wave-2 + arch #308 ratchet)

Forward attribution-record correction (the Truthful Attribution protocol §5) for two
high-risk squashes that post-merge-failed [tree-mismatch]:

- b35edb49194679ff9a771f33a9c6bcbf3e6379bd (PR #556, engineering#308 file-size/complexity ratchet gate)
- a661baa4917daa89b67f9e714b870a798eef617d (PR #546, cinatra#494/#495 SKILL.md standard-validation + no-mirror-drift gate)

Both carried a real maintainer Reviewed-by approval at their reviewed heads
(e1085bc / e20a63d) and were CLEAN at check time. They were merged back-to-back
in a quiet window; merging #556 advanced main, so #546's landed tree no longer
matched its reviewed-head tree, and the binding check failed [tree-mismatch] on
both pushes. The underlying changes (the file-size ratchet gate + the SKILL.md
validation/no-committed-mirror gate) and their owner approvals were valid and
intended; only the back-to-back merge ordering broke the tree-binding. This green
tip supersedes the red. LESSON: never admin-merge two high-risk PRs back-to-back;
merge one, let main settle, rebase + re-approve the second. Docs-only governance
note; non-high-risk.
