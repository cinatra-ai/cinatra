# Attribution-record correction — #672 route-graph numeric ratchet (the Truthful Attribution protocol §5)

This note is the forward correction (truthful verification-record spec — the
Truthful Attribution protocol §5) for the attribution record that landed with the
squash merge of PR #712 (`feat(audit): route-graph numeric ratchet for the locked
dev-perf route set`, squash commit
`8f50f104d3b95837bed87ffdcb7523b2685b9130`), which closes #672.

## What landed

PR #712 adds a numeric ratchet to the locked dev-perf route-graph metric.
`scripts/route-graph.mjs` was a pure reporter (no exit code), so a PR could grow a
locked route's reachable first-party module graph with nothing in CI flagging it.
The PR adds `scripts/audit/route-graph-ratchet.mjs` (a no-new-rot ratchet pinning
each `FIXED_ROUTES` route's reachable-module count as a ceiling that may only ever
shrink, mirroring the `file-size-ratchet` / `workspace-dep-cycles` gates, with a
`ROUTE_GRAPH_RATCHET_BASE` base-ref guard and a fail-closed `missingCount > 0`
contract), its committed baseline, and a `node:test` unit test (excluded from the
wholesale vitest suite alongside its `file-size-ratchet` sibling). It also makes
`scripts/route-graph.mjs` import-safe (exports `FIXED_ROUTES` + `analyzeRoute`,
guards the CLI behind a direct-execution check; CLI output byte-identical). It
touches only `scripts/audit/**`, `scripts/route-graph.mjs`, and `vitest.config.ts`
— none of which matches any high-risk glob in `.github/gate-suite.json`
`highRiskPaths` — so the change is non-high-risk and was correctly machine-armed.
It was merged to `main` as squash commit
`8f50f104d3b95837bed87ffdcb7523b2685b9130`.

## What was wrong

The #712 squash record carried both `Assisted-by` trailers in the gate's accepted
form (`Claude Code (claude-opus-4-8)` + `codex (gpt-5.5)` — no bracketed `[1m]`
suffix) and a correct `Closes #672`, but it **omitted the machine verification
arm entirely**: neither `Gate-suite: cinatra-core@2026.06.4` nor
`Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)` was present in the
squash body.

The PR-context `truthful-attribution-gate` accepts an `Assisted-by`-only record
(the live CI run is the evidence), so the gate was GREEN on the PR. But the
post-merge (default-branch push) arm on `main` has no PR context: it requires an
explicit verification arm — a `Reviewed-by` (human arm) or a
`Gate-suite` + `Accountable` (machine/gate arm). With neither present, the
post-merge gate went RED with:

```
no-record: record invalid: no verification arm — need a Reviewed-by (human arm) or a Gate-suite+Accountable (gate arm)
```

The change itself was a genuine, correctly-machine-eligible non-high-risk merge
(scripts/audit + a script + the vitest config; no high-risk path); only the record
was **incomplete** — the machine arm was missing from the squash body. This is the
same class of post-merge `[no-record]` defect corrected for #685 / #686 / #658 in
this directory, differing only in that the prior defects were a malformed
`Assisted-by` token (a `[1m]` suffix) while this one is an absent machine arm.

## The correction

The truthful record for `8f50f104d3b95837bed87ffdcb7523b2685b9130` is exactly the
one that landed, completed with the machine verification arm that the non-high-risk
self-merge was eligible for and should have carried:

```
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: codex (gpt-5.5)
Gate-suite: cinatra-core@2026.06.4
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
```

Nothing about the change's content, risk classification, or eligibility for the
machine arm changes — only the absent `Gate-suite` + `Accountable` arm is supplied.
This docs-only governance note carries the `Correction-for:` trailer that the
post-merge gate consumes to clear the blocked line, plus its own valid machine arm.
