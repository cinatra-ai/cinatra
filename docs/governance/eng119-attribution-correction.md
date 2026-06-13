# eng#119 — attribution-record correction for the cinatra enforce-bootstrap merge

The enforce-bootstrap squash merge of PR #206 (commit
`733f03932b40364b85106251e23431bae986cf6b`, which flipped the cinatra
`truthful-attribution-gate` caller WARN → ENFORCE) landed with a structurally
**malformed** `Assisted-by` record: the assistant lines were written in the
comma-descriptor form (`Assisted-by: <agent>, <role>`), which the ratified
spec (cinatra-engineering#119 §1, "one assistant per line — no comma lists")
and the gate's parser reject. The merge was authored via the GitHub API, which
bypassed the local commit-msg hook that normalizes comma-lists into repeated
lines, so the defect reached the squash commit.

This change carries the **corrected** truthful verification record for that
merge via a `Correction-for:` trailer, per §5 (detection + forward correction).
The substance of #206 is unchanged and remains as merged; this only repairs the
attribution record so the post-merge `truthful-attribution-gate` validates a
well-formed §1 record on `main` in ENFORCE mode.

- Corrected-for merge: `733f03932b40364b85106251e23431bae986cf6b` (PR #206)
- Record arm: human (maintainer `Reviewed-by`) — the high-risk #206 change was
  approved by the maintainer at the reviewed head; this correction is itself a
  non-high-risk docs change reviewed on its own PR.
