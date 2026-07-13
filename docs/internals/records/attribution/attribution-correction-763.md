# Attribution-record correction — 1508cee (route-graph baseline reset, #763)

Forward correction (the Truthful Attribution protocol) for the verification record
of squash commit `1508cee19fcac6337ad9535ff2887be4c07ee4fc`
("chore(audit): reset route-graph ratchet baseline to current main (#763)").

## What landed

1508cee is the PR-A'' baseline reset: it raises four route-graph ratchet ceilings
by +1 each (`/api/mcp` 1331->1332, `/chat` 1371->1372, `/api/a2a` 1337->1338,
`/api/llm-bridge` 1341->1342; `/sign-in` unchanged) to absorb the one new shared
`@cinatra-ai/agents` module (`build-agent-template-seed.ts`) the agent-serving
routes legitimately reach. Baseline-JSON-only; non-high-risk (no `highRiskPaths`
glob matches `scripts/audit/route-graph-ratchet.baseline.json`).

## What was wrong

The 1508cee squash record itself was correct and complete — a well-formed machine
arm (`Gate-suite: cinatra-core@2026.06.4` + the canonical `Accountable`, with two
truthful `Assisted-by` lines). The post-merge `truthful-attribution-gate` failed it
on a single `tree-mismatch` finding: `tree(merged) != tree(reviewed head)`.

## Root cause: a merge-race tree drift, not a fabricated or missing record

PR #763 was up-to-date with `main` when its required checks were verified green, but
commit `9854159` (#760, "fix(ui): unify /configuration domain-icon tiles") landed on
`main` in the brief window before the admin squash executed. The squash therefore
landed on top of #760, so the merged tree differs from the reviewed-head tree by
exactly one file — `src/app/configuration/page.tsx` (#760's change) — which the
ratchet-baseline PR neither touched nor reviewed. The gate fails closed on any
tree drift because it cannot prove the landed tree is the reviewed one; here the
drift is wholly #760's already-reviewed UI change, and the baseline change that #763
intended landed correctly and verbatim on `main`. No record was fabricated and none
was missing.

## The correction

This forward, docs-only note records the tree-mismatch root cause for 1508cee. Its
own squash carries `Correction-for: 1508cee…` plus the same machine arm
(`Gate-suite: cinatra-core@2026.06.4` and the canonical `Accountable`). It is
non-high-risk and changes no runtime code. It is merged up-to-date with `main` so it
does not itself drift.

Process note (mirrors the standing "ADMIN-MERGE only while UP-TO-DATE" rule):
re-confirm the PR head's parent equals `origin/main` immediately before the admin
squash, since a strict-protection PR can be raced by an unrelated merge in the
verify→merge window.
