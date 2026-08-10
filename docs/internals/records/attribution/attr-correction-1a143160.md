# Attribution record correction — squash 1a143160411e68bfba1a633d9ef39745ee8b3263 (PR #2629)

Correction-for: 1a143160411e68bfba1a633d9ef39745ee8b3263

The post-merge truthful-attribution gate reported `no-record: record invalid: Accountable must
immediately follow Gate-suite` on this squash, and the gate is RIGHT about the grammar: the
coordinator wrote the verification block in the order Gate-suite → Reviewed-by → Accountable,
and the canonical record grammar requires Accountable immediately after Gate-suite, with
Reviewed-by following it.

Nothing in the record is false. The `Reviewed-by` assertion is backed by a real, non-dismissed
GitHub approval: @groganz approved PR #2629 at head 730599899 — exactly the commit that was
squashed — and the PR was bot-authored (app/groganz-bot), so the approval is non-self. Both
`Assisted-by` trailers match the branch commits. The defect is ordering alone.

The corrected record for this squash, in canonical order:

    Gate-suite: cinatra-core@2026.08.1
    Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
    Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
    Assisted-by: Claude Code (claude-opus-5)
    Assisted-by: Codex (gpt-5.6-sol)

Process correction adopted: the coordinator's merge-body template now fixes the trailer order
(Accountable directly after Gate-suite; Reviewed-by after Accountable) instead of re-deriving
it per merge.
