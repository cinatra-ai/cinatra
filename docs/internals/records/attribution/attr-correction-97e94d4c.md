# Attribution record correction — squash 97e94d4c1d50d703f978bf90cb9c1aa26cc7e852 (PR #2635)

Correction-for: 97e94d4c1d50d703f978bf90cb9c1aa26cc7e852

The post-merge truthful-attribution gate reported `gate-suite-fabricated` on this squash, and the
gate is RIGHT about the state it saw: at merge time, the PR's own required context
`truthful-attribution-gate / truthful-attribution-gate` (Actions run 31381586918) stood at
conclusion=failure, so the record's `Gate-suite` arm asserted a suite state that did not hold at
the moment of merge.

The failure was PROCEDURAL, not substantive. That run's red was the gate's designed
`high-risk-without-maintainer` stop for a migrations-class PR awaiting a maintainer approval.
@groganz's approval was submitted at the exact merged head
84719b6f647642d6a7412088c495349b683f553b at 2026-08-10T15:18:53Z — before the merge — but the
coordinator merged without re-running the check (it never auto-retriggers on approval). The
rerun of the SAME run (attempt 2) at the SAME head, performed immediately after the finding,
concluded SUCCESS with no code change, proving the suite's substance was satisfied at merge time.

Every other trailer in the record is accurate: the approval is real, non-self (bot-authored PR),
at the merged head; both Assisted-by trailers match the branch commits; the trailer order is
canonical.

Process correction adopted (merge-doctrine trap 30): for every approval-gated PR, the merge
checklist is (1) approval verified at the live head, (2) rerun the PR's attribution run,
(3) confirm SUCCESS, (4) merge. An approval without the rerun is not a merge precondition met.
