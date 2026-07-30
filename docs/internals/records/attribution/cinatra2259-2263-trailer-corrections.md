# Attribution correction: malformed trailers on two 2026-07-30 merge records

Two squash records on main are invalid under the truthful-attribution grammar and
are corrected by this record. The underlying verifications were real in both cases;
only the transcribed records were malformed.

## 4aec695f073aedde8bb10dde8d9cf451857814d1 (PR #2259, exec-plane L5 E2E battery)

The squash body carried a lane-authored line naming Codex with a parenthetical that
included session ids, spaces and semicolons — outside the model-id grammar — which
invalidates the whole record. The true, verifiable state: the diff was produced with
Claude Code (claude-opus-5) and Codex (gpt-5.6-sol) assistance, and the merge was
backed by a real maintainer-tier approval by @groganz, verified at the exact reviewed
head, with the designed-red attribution check re-run green there before merging.

## e65b00cb2d84b280218a1f79c840b264b6a181cf (PR #2263, S7 post-merge acceptance evidence)

The squash body carried an empty gate-suite value: the coordinator shell that reads
the committed suite id/version used a wrong JSON key and the pipeline did not abort,
so the gate arm was transcribed as empty and the record has no valid verification
arm. The true, verifiable state: every required context of cinatra-core@2026.07.8
concluded success at the reviewed head (59 pass / 0 fail), and the change touched
evidence files only.

Process fix applied coordinator-side: trailer unions are now validated against the
record grammar before a squash is issued (invalid lane-authored values are reduced
to their grammar-conforming form), and the suite id/version read now fails closed.
