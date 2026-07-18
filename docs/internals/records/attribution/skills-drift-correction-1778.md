# Skills-drift acknowledgement correction — 52d327875 (#1778)

Forward correction (the skills-drift-gate acknowledgement model, cinatra#188) for
squash commit `52d327875a588a4f370ef0a4f451064817cd42b7`
("feat(dashboards): S11c dashboardContribution hardening + 3-way upgrade-merge +
reconciler boot trigger (#1628) (#1778)").

## What was wrong

The `skills-drift-gate / skills-drift-gate` required check failed on the push to
`main` for 52d327875:

```
skills-drift [watch]: blog-content/SKILL.md depends on changed surface
@cinatra-ai/blog-content-workflow (packages). Resolve via 'Skills-PR: <pr> covers:
<skill>', 'Skills-reviewed:', or 'Skills-unaffected: <reason>'.
```

The #1778 squash body carried the truthful attribution arms (`Assisted-by`,
`Gate-suite`, `Accountable`) but no `Skills-*` acknowledgement marker. The gate reads
acknowledgement markers only from the pushed commit range and the merged PR body; the
squash body was assembled without the marker, so the declared-watch finding reds `main`
with no in-band way to clear it on that immutable squash (the squash-marker trap). No
record was fabricated and the skill is not stale; only the acknowledgement marker was
missing from the merge record.

## Why the finding fired (the exact match)

`blog-content/SKILL.md` declares a `cinatra-watches.packages` entry for
`@cinatra-ai/blog-content-workflow`. The gate intersects that exact string against the
PR's changed diff text (both `+`/`-` sides). #1778 contains the literal string on a
single added line in a TEST FIXTURE,
`src/lib/dashboards/__tests__/reconcile-all-contribution-adoptions.test.ts`:

```
const LEGACY = "@cinatra-ai/blog-content-workflow";
```

— a sample legacy package-name constant used to verify that
`reconcileAllDashboardContributionAdoptions` correctly adopts/reconciles a
dashboardContribution emitted by that package. The identifier appears nowhere else in
the change.

## Truth determination: the skill is NOT affected

`blog-content/SKILL.md` documents the blog-content pipeline operator surface — the
authoring and dispatch instructions that watch the `@cinatra-ai/blog-content-workflow`
package. #1778 is dashboardContribution validation/upgrade plumbing:

- `packages/dashboards` mutation-service dashboardContribution validation hardening and
  a 3-way upgrade-merge for contribution adoption.
- A boot-time reconciler trigger
  (`reconcileAllDashboardContributionAdoptions`) and its tests.

None of that changes the `@cinatra-ai/blog-content-workflow` package — its source,
manifest/authoring format, dispatch contract, or runtime behavior are all unchanged;
the package name merely appears as a fixture constant in the reconciler's own unit test.
No watched primitive name, documented param shape, or dispatch convention the
blog-content operator surface teaches is touched. `Skills-unaffected:` is the truthful
acknowledgement; no skill content update is warranted.

## The correction

This forward, docs-only note records the skills-drift acknowledgement for 52d327875.
Its own squash body carries the truthful `Skills-unaffected:` marker (which clears the
declared-watch finding on this note's own push, since this file names the watched
package string), `Correction-for: 52d327875…`, and the machine verification arm
(`Gate-suite: cinatra-core@2026.07.5` + the canonical `Accountable`). It is
non-high-risk (`docs/internals/records/attribution/**` matches no `highRiskPaths`
glob) and changes no runtime code. It is merged up-to-date with `main` so it does not
itself drift.

Process note (the squash-marker trap, for the merging lane): a wave lane
squash-merging a PR whose head body carries a `Skills-*` marker MUST carry that marker
into the squash `--body-file`, since the gate reads acknowledgements only from the
pushed range and the merged PR body. Carry `Skills-unaffected:` / `Skills-reviewed:` /
`Skills-PR:` in the squash body, not just the PR head.
