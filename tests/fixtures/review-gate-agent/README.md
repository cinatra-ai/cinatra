# `review-gate-agent` — the marked artifact-review gate fixture

A deterministic, **no-LLM, no-connector, no-secret** agent that exists for one
reason: it declares the `metadata.cinatra.artifactReview.targetsInput` marker, so
the run executor's MARKED artifact-review gate path has a producer an e2e harness
can drive.

Not a product extension. Private, never published, and mounted only from this
tree — the same shape `tests/fixtures/works-after-agent/` uses for the
works-after WayFlow proof.

## Why it exists

`packages/agents/src/oas-compiler.ts` propagates the marker from an
`InputMessageNode` gate onto the compiled step as `artifactReviewTargetsInput`;
`packages/agents/src/execution.ts` reads it at the `input-required` interrupt and
PINS the run's review targets through `emitArtifactReviewGate`. Before this
fixture, **no shipped extension declared the marker**, so that whole path had no
producer: a review card could not be exercised end to end without a credentialed
agent run, and a SQL-seeded gate is invisible by construction (the listing filters
every candidate through `enforceReviewRunAccess`, which 404s a gate whose `run_id`
resolves to no `agent_runs` row).

## The flow

```
StartNode(review_targets: array)
   → InputMessageNode "review_gate"      ← metadata.cinatra.artifactReview.targetsInput = "review_targets"
       → EndNode(userResponse)
```

The targets are the run's OWN `inputParams.review_targets` — an array of
`{ artifactId, representationRevisionId }`. Whatever the harness uploaded through
the real artifact-upload path is what the gate pins, so the card renders real
artifacts at real pinned revisions with no LLM anywhere in the chain.

## How it is used

`tests/e2e/agents-run/review-gate-fixture.ts` owns the three steps:

1. `stageReviewGateFixture(repoRoot)` — copy this tree into
   `extensions/<vendor>/<slug>/`, which is the directory BOTH the host's dev boot
   scan and the WayFlow runtime (`./extensions:/agents:ro`) read.
2. `seedMarkedReviewGateRun({ userId, orgId, targets })` — create the queued run
   with the targets pre-filled and enqueue the execution job. Only run CREATION is
   seeded, exactly as `tests/e2e/agents-run/seed.ts` already does; everything
   downstream is the shipped path.
3. `waitForMarkedReviewGate(runId)` — poll until the executor has minted the gate.

## Keeping the marker in sync

`.cinatra-published.json` carries `oasSha256` over the raw bytes of
`cinatra/oas.json`. The WayFlow loader refuses to mount an agent whose marker does
not match, so **re-hash after every edit**:

```sh
shasum -a 256 cinatra/oas.json
```

The OAS must also satisfy the host compiler's structural validation:
`agentspec_version` pinned to the compiler's expected value,
`metadata.cinatra.type`, a string (never `null`) `description` on every
control/data-flow edge, and a `license` on `package.json` (the SPDX detection gate
rejects a package with none).
