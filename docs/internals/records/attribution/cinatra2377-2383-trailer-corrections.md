# Attribution correction: malformed identity trailers on two 2026-08-03 merge records

Two squash records on main are invalid under the truthful-attribution grammar and are
corrected by this record. The underlying verifications were real in both cases; only the
transcribed records were malformed — both carried `Reviewed-by:` / `Accountable:` values
as a bare login instead of the full identity form (`Name <email> (@login[, tier=…])`).

## 994daf08d169e1ee45738f9081a5a0ebdbeea521 (PR #2377, post-login redirect target)

The squash body transcribed `Reviewed-by: groganz (tier=maintainer)` and
`Accountable: groganz` — bare-login values outside the identity grammar, which invalidate
the record's verification arm. The true, verifiable state: the merge was backed by a real
maintainer-tier approval by @groganz cast at the exact reviewed head
`88b89b88c3866f42e9951d77753fc730f16079d1`, with every required context of
cinatra-core@2026.07.8 concluded success at that head and the designed-red attribution
check re-run green there before merging. The diff was produced with
Claude Code (claude-sonnet-5) assistance.

## b136e76b93208d1cb19a8e53599725f2ab09ca0b (PR #2383, notifications mark-unread)

The squash body transcribed the same two bare-login trailer values. The true, verifiable
state: a real maintainer-tier approval by @groganz cast at the exact reviewed head
`b066e2e2d56c6c90c6839dec2088b1101f5f1a68`, all 75 check-runs at that head concluded
success or skipped, zero unresolved review threads at merge time, and the landed squash
re-derives to the same content fingerprint as the reviewed change (unrelated-files
base movement only). The diff was produced with Claude Code (claude-sonnet-5) assistance.

Process fix applied coordinator-side: the merge-finisher brief now pins the full identity
grammar for `Reviewed-by:` / `Accountable:` (never a bare login), and the transcribed
trailer block is validated against a known-passing record before the squash is issued.
