# S4 post-change verification (#2042) — live proof

Stack: fresh clone, pinned dev-extension sync, db `s42042` on pg 127.0.0.1:5634,
redis 6579, port 3070, `CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION=on`, real signup
(s4prover@example.com, org `b6b0a9a8…`). Each stage = a live full-page screenshot
+ store verification of the rows it renders.

## V1 — a repair lands → a verification entry appears on the run's rail
`s4-v1-v3-run-rail-core-analysis-entry-and-reopen-gate.png` — the run view under
`/agents/cinatra-ai/s4-verify-demo/run-s4-demo` shows the left step rail with a
**"Core analysis DRIFTED"** entry (the S4 verification record) deep-linking to
`?view=verification`.
Store: `artifact_verification_records` outcome=drifted, field_diff_count=3,
reviewed=rev-base, repaired=rev-repaired.

## V2 — opening it shows the before/after field diff labeled "Core analysis" + advisory
`s4-v2-verification-view-core-analysis.png` — the verification view shows the
**"Core analysis"** chrome + the **Out-of-scope drift** verdict, the before/after
field table (bcc marked OUT OF SCOPE; body + subject before/after), and the
provenance-stamped **Core analysis** advisory comment (lane=core-analysis-lane,
projection digest, authz=authorized, fields=[bcc,body,subject], excluded=[]).
Store: `gate_advisory_comments` author_kind=service, author=core-analysis-lane.

## V3 — a failed verification reopens a bounded gate on the same run
Same screenshot as V1 — the rail's third entry is the reopened **"Review"** gate
`lifecycle-review:verify:verify-…`, pending, on the **same run**.
Store: `artifact_review_gates` reopen gate status=pending, run=run-s4-demo.

## V4 — the extended conformance anchors + engine assert green
56 tests pass: the review-surface conformance test (run-embedded anchors
bidirectional) + the verdict core + the core-analysis provenance.
Additionally, 6 real-pg integration tests (V1 auto record, V2 verified + before/
after diff, V3 unmet + drift bounded reopen idempotent, BOUND escalate, the
advisor lane) pass against real DDL on pg 5634.
