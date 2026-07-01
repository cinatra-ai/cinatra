# Skills-drift acknowledgement correction — 8a7eda9 (#786, ops#436 stage-1)

Forward correction (the skills-drift-gate acknowledgement model, cinatra#188) for
squash commit `8a7eda9770f42fb32df710c20a4026ae7435723f`
("feat(boot): deploy-refreshable required-extension OAS materialization + WayFlow-OAS
decoupling (#786)"), the cinatra-image side of cinatra-ai/ops#436.

## What was wrong

The `skills-drift-gate / skills-drift-gate` required check failed on the push to
`main` for 8a7eda9:

```
skills-drift [watch]: chat-agent-authoring/SKILL.md depends on changed surface
@cinatra-ai/planner-agent (packages). Resolve via 'Skills-PR: <pr> covers: <skill>',
'Skills-reviewed:', or 'Skills-unaffected: <reason>'.
```

The #786 PR-head body DID carry the truthful `Skills-unaffected:` marker, but the
squash-merge dropped it: the gate reads acknowledgement markers ONLY from the pushed
commit range (the squash body is HEAD on `main`), and the squash body was assembled
without the marker. This is the squash-marker trap — a PR-head marker is discarded by
squash, so a declared-watch finding reds `main` with no in-band way to clear it. No
record was fabricated and the skill is not stale; only the acknowledgement marker was
missing from the merge record.

## Why the finding fired (the exact match)

`chat-agent-authoring/SKILL.md` declares a `cinatra-watches.packages` entry for
`@cinatra-ai/planner-agent`. The gate intersects that exact string against the PR's
changed diff text (both `+`/`-` sides). #786 contains the literal string on one added
line in a TEST FIXTURE,
`scripts/extensions/__tests__/build-required-oas-seed.test.mjs`:

```
JSON.stringify({ packageName: "@cinatra-ai/planner-agent", oasSha256: "deadbeef" })
```

— a sample ownership-marker payload used to verify the build-stage OAS-seed script.
The other `planner-agent` occurrences in #786 are filesystem-path strings in tests
(`.../cinatra-ai/planner-agent/...`) asserting the boot materializer seeds / prunes /
preserves the correct on-disk directories.

## Truth determination: the skill is NOT affected

`chat-agent-authoring` documents the agent-source authoring lifecycle — the
scaffold → validate → compile → publish → review primitives and the meta-agent toolkit
packages it instructs against. #786 changed none of that authoring surface:

- `packages/agents/src/agent-install-path.ts` adds a `CINATRA_AGENT_INSTALL_DIR` env
  override (precedence env > DB metadata > default) to install-dir resolution. This is
  deploy/boot infrastructure governing WHERE the required-set agent OAS trees are
  materialized on disk — not an authoring primitive the skill documents.
- The build-stage OAS-seed script, the fail-closed `required-extension-materialize`
  boot phase, and their tests perform deploy-time materialization of the
  ALREADY-PUBLISHED planner-agent OAS into the agent-install dir.

None of the watched authoring primitives changed, and neither watched path
(`packages/agents/src/a2a-actions.ts`, `packages/agents/src/server-actions.ts`)
was touched. The planner-agent's definition, its authoring surface, and its behavior
are unchanged. `Skills-unaffected:` is the truthful acknowledgement; no skill content
update is warranted.

## The correction

This forward, docs-only note records the skills-drift acknowledgement for 8a7eda9.
Its own squash body carries the truthful `Skills-unaffected:` marker (which clears the
declared-watch finding on the push), `Correction-for: 8a7eda9…`, and the machine
verification arm (`Gate-suite: cinatra-core@2026.06.4` + the canonical `Accountable`).
It is non-high-risk (`docs/governance/**` matches no `highRiskPaths` glob) and changes
no runtime code. It is merged up-to-date with `main` so it does not itself drift.

Process note (the squash-marker trap, for the merging lane): a wave lane squash-merging
a PR whose head body carries a `Skills-*` marker MUST carry that marker into the squash
`--body-file`, since the gate reads acknowledgements only from the pushed range. Carry
`Skills-unaffected:` / `Skills-reviewed:` / `Skills-PR:` in the squash body, not just
the PR head.
