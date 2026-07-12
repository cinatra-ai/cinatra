# Attribution correction — 09de0baa (skills lifecycle A1, #1405)

The squash for the skills lifecycle A1 change
(`09de0baac592e10ace596446f888b027f32b9af3`, PR #1405, Closes #1361) landed
with a **red `truthful-attribution-gate`**: `content-mismatch — the landed
change is not the reviewed change`.

No unreviewed content landed. Every line in the landed tree traces to one of
two independently owner-approved PRs that touched the same file:

- **PR #1403** (feat(agents): trusted dependent-install-id on the signed run
  lineage + edge-bound serving guard), approved by @groganz at
  `e16778b173eeb2e41a0db39bdee72314b5bed8f8`, merged as
  `2511769139b06719cc3676fa006a5a275a3ccca6`. It added a small `agent_runs`
  DDL block to `src/lib/drizzle-store.ts`.
- **PR #1405** (feat(skills): lifecycle A1), approved by @groganz at
  `fb04370590ce0dad8f7c67f86d047b4cadb7ead5`, merged as
  `09de0baac592e10ace596446f888b027f32b9af3`. It added its skill-lifecycle DDL
  to the same file, in a disjoint region.

Both edits touched `src/lib/drizzle-store.ts`. #1405 was merged **behind**
#1403; git auto-merged the two hunks cleanly and #1405's landed hunks are
byte-identical to its reviewed diff. But the gate fingerprints the **full tree
content of every changed path**, not just the applied hunks — so once #1403's
`agent_runs` block was already in the file, the tree content of
`src/lib/drizzle-store.ts` at #1405's merge no longer matched the content that
was reviewed at `fb04370`, and the content binding voided. The mismatch is
purely mechanical: the union of the two reviewed diffs, with no third,
unreviewed edit.

This forward, docs-only governance note records the **complete verification
record** for the corrected tip
`09de0baac592e10ace596446f888b027f32b9af3` and supersedes the transient red.
No runtime code is changed by this note. Non-high-risk.

## Operational rule — sibling-file merges and approval binding

The content-binding gate fingerprints the full tree content of each changed
path, so an approval only stays binding while the changed-file set of the PR is
**disjoint from every commit that landed between the reviewed head and the
merge**. Concretely:

- **When two approved PRs edit the same file, the second must be mechanically
  update-branched before merging** — rebased/merged onto the post-sibling tip
  so its approval is re-anchored at the tree that actually includes the first
  PR's edit. Content binding survives a mechanical (no-diff-change)
  update-branch; it is the reviewed change re-fingerprinted against the current
  tree.
- **A behind-squash is only binding-safe when the merging PR's changed-file set
  is disjoint from every intervening commit.** If the sets overlap — even when
  git auto-merges cleanly and the applied hunks are byte-identical — the tree
  content of the shared path has moved, and the binding voids. Update-branch
  first, then merge.
- Before firing sibling PRs against a shared branch, map the changed-file sets
  and **serialize any pair that overlaps**, update-branching each successor
  after its predecessor lands.

The verification record for `09de0baac592e10ace596446f888b027f32b9af3`:

    Assisted-by: Claude Code (claude-opus-4-8)
    Assisted-by: Codex (gpt-5.6-sol)
    Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
