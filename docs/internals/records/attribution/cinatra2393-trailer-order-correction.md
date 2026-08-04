# Attribution correction: trailer order on the #2393 merge record

One squash record on main is invalid under the truthful-attribution grammar and is
corrected by this record. The underlying verification was real; only the transcribed
record was malformed — a trailer-ordering violation, not a content defect.

## 963b89a98baaf8027c3af2b2588c89011098b773 (PR #2393, agent-skills S5 lifecycle teardown)

The squash body carried all four verification trailers with correct individual grammar
(full identity forms), but placed `Reviewed-by:` between `Gate-suite:` and
`Accountable:`. The gate arm requires `Accountable` to immediately follow `Gate-suite`,
so the record's verification arm failed to parse
(`no-record: Accountable must immediately follow Gate-suite`, post-merge run
30861033601). The true, verifiable state: a real maintainer-tier approval by @groganz
cast at the exact reviewed head `18db0f0c84d9b3485617a7e7aaa901266d4c04d0`
(submitted 2026-08-03T23:00:47Z), all 75 check-runs at that head concluded success or
skipped, zero unresolved review threads at merge time, and every required context of
cinatra-core@2026.07.8 green. The diff was produced with
Claude Code (claude-sonnet-5) assistance. The corrected record reads:

```
Gate-suite: cinatra-core@2026.07.8
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-sonnet-5)
```

Process fix applied coordinator-side: the finisher brief's trailer template now pins the
pair-adjacency rule (`Accountable` immediately after `Gate-suite`, `Reviewed-by` after
the pair) in addition to the full identity grammar, and the drafted block is diffed
line-shape by line-shape against a known-passing record before any squash is issued.
