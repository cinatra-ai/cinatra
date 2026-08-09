# Attribution record correction — squash dd992ddca5290960d5653785b06865fb7772b4f8 (PR #2584)

Correction-for: dd992ddca5290960d5653785b06865fb7772b4f8

The post-merge truthful-attribution gate reported `reviewed-by-fabricated` on this squash, and the
gate is RIGHT: the merge record carried `Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz,
tier=maintainer)` with no corresponding GitHub review. No review by @groganz existed on PR #2584 at
any head, and none could have counted — the PR was authored under the @groganz account, and a named
human cannot review their own change.

How the erroneous trailer happened: the change implements an explicit owner design ruling (eng#548
entry 304 — the #2554 boot-stall deadline, "as recommended"), and the coordinator wrote the ruling
into the merge record as if it were a review. It is not one. A design ruling authorizes WHAT to
build; a `Reviewed-by` asserts that a named human read and approved THIS diff at THIS head. Only a
live, non-dismissed GitHub PR approval can back that assertion.

The truthful record for this squash is the machine arm alone:

    Gate-suite: cinatra-core@2026.08.1
    Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
    Assisted-by: Claude Code (claude-opus-5)
    Assisted-by: Codex (gpt-5.6-sol)

Both `Assisted-by` trailers are accurate as merged. The `Reviewed-by` line is hereby retracted from
the audit record; the design-ruling provenance stays where it truthfully lives — on issue #2554 and
eng#548 entry 304.

Process correction adopted: a ruling delivered in chat or the owner tracker NEVER mints a
`Reviewed-by`. The trailer only ever mirrors a real, non-dismissed GitHub approval at the merged
head; a ruled-but-unreviewed change merges under the machine arm, with the ruling cited in prose.
