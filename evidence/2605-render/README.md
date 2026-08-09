# cinatra#2605 — /agents run-affordance render check (lane TRIPLE-245)

Head under proof: `f585fb4d4b3ff485f2fceee5c99c23b6542c9003` (the LIVE PR tip; the
wave-244 version-fence increment had already advanced past `161ea7d5e`, so the
brief's SHA is stale and this record is pinned to the tip that actually ran).

## How it ran

- Real Next dev server on the branch worktree, port 3153, dedicated database
  `tr245_render` on the verify Postgres (5634), Redis 6579, 111/111 extensions
  pinned from the branch's own `cinatra-dev-extensions.lock.json` (lock is
  byte-identical across #2612/#2614/#2615).
- Schema built by the shipped `cinatra instance setup dev`; the first admin was
  created through the REAL setup account step in the browser.
- Real Chrome via Playwright, one browser, workers=1.
- No fixture route. Every capture is `/agents` on the running app.

## Per-item result

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Blog Draft Writer Agent shows **Install** | **PASS** | CTA link text `Install`, accessible name `Install Blog Draft Writer Agent` |
| 2 | …with the marketplace **listing href** | **PASS** | `href=/configuration/marketplace/cinatra-ai/blog-draft-writer-agent` |
| 3 | Blog Draft Writer Agent has **NO run affordance** | **PASS** | no `/agents/cinatra-ai/blog-draft-writer-agent/new` link anywhere in the card |
| 4 | Blog Idea Generator Agent shows **Install** | **PASS** | accessible name `Install Blog Idea Generator Agent` |
| 5 | …with the marketplace **listing href** | **PASS** | `href=/configuration/marketplace/cinatra-ai/blog-idea-generator-agent` |
| 6 | Blog Idea Generator Agent has **NO run affordance** | **PASS** | no `/new` link in the card |
| 7 | A **runnable** agent still shows **Run** | **NOT DEMONSTRATED** | see below |
| 8 | A **missing-required-dependency** agent shows **View requirements** with the reason in `aria-label`/`title` | **NOT DEMONSTRATED** | see below |

Items 7 and 8 are **not** recorded as passes. On a freshly set-up instance every
local template resolves `not-installed`, so all 14 rendered cards carry the
`Install` arm and neither the `runnable` nor the `missing-dependency` arm of
`buildUnavailableAction` (packages/agents/src/pages.tsx) was reachable. Proving
them needs an instance with (a) at least one agent actually installed and
(b) one installed agent whose required dependency is absent. Neither state was
reachable in this lane's budget.

## Control observation (not a #2605 item)

The same fresh-instance path on `fix/2523-run-now-actually-runs` (PR #2615,
which does not carry this fix) renders a **Run** link on both named agents at
`/agents/cinatra-ai/<slug>/new`. That is the pre-fix behaviour this PR removes,
observed on a real running app rather than inferred.

## Honest scope

This record covers the two named `guardedOptional` agents only. It is NOT a full
design-surface conformance pass, and it does not exercise the A2A/MCP narrowing
that the round-3 commit (`f585fb4d4`) touches.
