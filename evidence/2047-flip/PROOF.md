# cinatra#2047 — the activation flip, proven live with NOTHING set

The owner ruling of 2026-07-27 (recorded on cinatra#2047) turns **both**
lifecycle activation switches ON by default. This is the live proof that the
default posture — an installation that sets neither variable — actually runs the
merged lifecycle machinery end to end.

## Environment

| | |
|---|---|
| Postgres | `127.0.0.1:5634/flipwalk2047` — this lane's OWN database on the shared verify stack, provisioned from scratch (public schema + Better-Auth migrate + the app's own boot bootstrap) |
| Redis | `127.0.0.1:6579`, lane-scoped queue `cinatra-bg-flipboth2047` |
| App | `pnpm dev` on `:3167`, real first-admin signup, isolated headless Chromium driven from this worktree |
| **Activation env** | **NEITHER switch is set.** `.env.local` contains no `CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION` and no `CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW` line. Every observation below is the DEFAULT. |

Two non-lifecycle affordances are disclosed rather than hidden:

1. `CINATRA_E2E_SETUP_BYPASS=true` — the repo's own documented browser-e2e switch
   (`src/lib/setup-wizard.ts`), the same one CI's browser jobs set, so the walk
   can reach app surfaces on a freshly-provisioned instance. It changes no
   authorization on the review path.
2. One `cinatra.skill_matches` row seeded for
   `(@cinatra-ai/web-research-agent, @cinatra-ai/web-research-agent:web-research-agent)`
   — the exact row shape the LLM skill-match batch writes. The batch needs paid
   model credentials a local walk has none of; the row makes the agent's own
   self-match skill *recommended* so the headless auto-apply has something to
   apply. It does not touch either activation switch.

## Rung 0 — the switches read ACTIVE with nothing set

```
WALKFLIP ENV {"reviewOrchestrationEnvRaw":null,"chipRowEnvRaw":null,
              "isLifecycleReviewOrchestrationActive":true,
              "isRecommendationChipRowHoldActive":true,"optOutValue":"off"}
```

And the boot phase seeds the loops rather than skipping them
(`logs/boot-activation.txt`):

```
[lifecycle-review-orchestration] S1 activation ACTIVE (default) — review-orchestration (30s) + gate-maintenance (60s) loops scheduled
```

## Rung 1 — REVIEW, run-embedded, decided both ways

**Produce.** The shipped producer wrapper inside a real run row. With no env set
the emitter still splices the same-tx produced-event INSERT:

```
WALKFLIP PRODUCE {"slot":"a","runId":"run-flip-34457b99", …
  "outbox":[{"event_id":"26f8edf1…","emitter":"createSemanticArtifact",
             "origin_kind":"agent_produced","destination_class":"none",
             "continuation_mode":"async_effects_gated","status":"pending"}]}
```

**Gate.** The shipped sweeper turns that event into exactly one gate:

```
WALKFLIP GATE {"slot":"a","summary":{"scanned":1,"gatesCreated":1,…},
  "gates":[{"id":"2baa4ca3…","review_task_id":"lifecycle-review:26f8edf1…","status":"pending"}]}
```

On the SECOND production the walk's own sweeper call reported `scanned:0,
gatesCreated:0` and the gate was **already there** — the boot-seeded ~30s
orchestration drain had drained it first. That is the default-on boot loop doing
the work, not the harness (`logs/boot-activation.txt`:
`[lifecycle-review-orchestration] scanned=1 gatesCreated=1 …`).

**Approve (UI).** `screenshots/FLIP-01-review-gate.png` — the run-embedded review
surface with the pinned target, its real revision/mime, Preview/Download and the
Comment · Reject · Approve floor. `FLIP-02-approve-before/-after.png` — the
decision lands and the surface reports *"This review is no longer open"*.

```
WALKFLIP READBACK {"slot":"a","gates":[{… "status":"resolved","disposition":"approve",
  "resolved_by":"35bc70c9-f4fd-454d-a981-55de6f4e9569"}],"repairs":[]}
```

**Changes-requested → repair (UI).** `screenshots/FLIP-03-changes-requested-*.png`.
Typed feedback: *"Tighten the headline and add a CTA."* Surface response,
verbatim:

> Changes requested. The reviewed work has been turned back for repair — a repair
> is now in flight.

```
WALKFLIP READBACK {"slot":"b","gates":[{… "status":"resolved","disposition":"changes_requested",
  "resolved_by":"35bc70c9…"}],
  "repairs":[{"id":"047a2d23…","route":"producer_repair","status":"dispatched","attempt":1}]}
```

The repair went `requested` → `dispatched` between two readbacks with no harness
call in between — the boot-seeded ~60s gate-maintenance drain dispatched it.

## Rung 2 — RECOMMENDATION, BOTH PATHS (the row-6 proof)

Two runs on ONE template (`@cinatra-ai/web-research-agent`), identical except
`human_present`:

```
WALKFLIP REC_SEED {"rows":[{"id":"run-flip-human-8b95d96b","status":"pending_input","human_present":true},
                           {"id":"run-flip-headless-c7a86f7d","status":"pending_input","human_present":false}]}
```

**The fork, at the shipped seam:**

```
WALKFLIP REC_HOLD {
  "humanPresent":{"runId":"run-flip-human-8b95d96b",
                  "hold":{"held":true,"parkId":"a26f0b64…","reason":"core default fires recommendation"},
                  "park":{"status":"parked","checkpoint":"recommendation"}},
  "headless":{"runId":"run-flip-headless-c7a86f7d",
              "hold":{"held":false,"reason":"headless"},"park":null},
  "parkRows":[{"run_id":"run-flip-human-8b95d96b","checkpoint":"recommendation","status":"parked"}]}
```

**Human-present — the chip row is live.**
`screenshots/FLIP-04-chiprow-parked.png` — the run view renders
`[data-run-recommendation-chip-row]` (count 1), verbatim:

> Confirm the skills for this run
> Recommended for your request. Adjust the selection, then confirm — or skip to run with the default set.
> Skills (0/1) · web-research-agent · Confirm · Skip

**Confirm releases it and the selection governs delivery.**
`screenshots/FLIP-05-chiprow-confirm-before/-after.png` — the skill chip is
picked (`data-selected="true"`), Confirm is pressed, and the row collapses to
*"Skills confirmed (1) @cinatra-ai/web-research-agent:web-research-agent"* while
the run dispatches (it then stops at the agent's own HITL, `pending approval`).

**Headless never parks, and auto-applies when the checkpoint fires.**
Silent org (lattice default):

```
WALKFLIP REC_HEADLESS_APPLY {"applied":{"mode":"skipped","reason":"core default skips recommendation","written":0},"parks":[]}
```

With an org `required` bound on the recommendation checkpoint:

```
WALKFLIP REC_REQUIRED_BOUND {"rule":{"id":"e3585725…"},
  "applied":{"mode":"auto_applied","reason":"headless run auto-applied top recommendations (no park)","written":1,
             "selection":[{"skillId":"@cinatra-ai/web-research-agent:web-research-agent",
                           "selectionSource":"recommended_auto_applied"}]},
  "parks":[]}
```

Both selections side by side in the immutable per-run store — the human path and
the headless path, distinguishable by their source:

```
WALKFLIP REC_READBACK {
  "parks":[{"run_id":"run-flip-human-8b95d96b","checkpoint":"recommendation","status":"released"}],
  "selected":[{"run_id":"run-flip-headless-c7a86f7d","skill_id":"…:web-research-agent","selection_source":"recommended_auto_applied"},
              {"run_id":"run-flip-human-8b95d96b",   "skill_id":"…:web-research-agent","selection_source":"recommended_confirmed"}],
  "runs":[{"id":"run-flip-headless-c7a86f7d","status":"pending_input","human_present":false},
          {"id":"run-flip-human-8b95d96b","status":"pending_approval","human_present":true}]}
```

## Rung 3 — the ops surfaces render real state

- `screenshots/FLIP-06-ops-lifecycle-operations.png` —
  `/configuration/lifecycle-operations` renders both panels against the live
  store: "No stuck releases" and "No blocked effects", which is the truthful
  read of this walk's state (every gate resolved inside its budget, no park past
  its deadline).
- `screenshots/FLIP-07-run-timeline.png` — the run surface for the
  changes-requested production shows the lifecycle entry
  `Review CHANGES_REQUESTED` on the rail.

Store-side aggregate at the end of the walk:

```
WALKFLIP OPS {"gates":[{"status":"resolved","n":2}],
              "events":[{"status":"processed","n":2}],
              "parks":[{"checkpoint":"recommendation","status":"released","n":2}],
              "repairs":[{"status":"dispatched","n":1}]}
```

## Observation recorded, NOT fixed here

`maybeHoldRunForRecommendation` resolves the agent's candidate set through
`getAssignedSkillIdsForAgent(packageName)` with **no ActorContext**. That
resolver deliberately treats an actor-free call as the most restrictive
non-admin caller, so every `workspace`- / org-scoped skill row is filtered out
and only platform `system` skills and the agent's own `agent`-level self-match
survive. On a stock instance every bundled skill is `workspace`-level, so the
chip row does not appear for those agents — the hold returns
`{held:false, reason:"no recommendation candidates"}` and the run dispatches
normally (`WALKFLIP REC_HOLD` for `@cinatra-ai/blog-draft-writer-agent`, first
round). This is the C3 seam's pre-existing behaviour, unchanged by the flip; it
makes the hold UNDER-fire, never deadlock, so it is not a blocker for the
activation ruling. It is why the recommendation rung runs against
`@cinatra-ai/web-research-agent`, which carries an `agent`-level self-match
skill. Worth a follow-up issue on #2037.

## Layout

- `logs/walk-raw.txt` — every `WALKFLIP` line, verbatim.
- `logs/boot-activation.txt` — the dev server's own lifecycle boot lines.
- `drivers/` — the walk harness (`walk.test.ts` + `walk.config.ts`), the lane
  signup driver and the isolated-Chromium UI driver, exactly as run.
- `screenshots/` — the live surfaces.
