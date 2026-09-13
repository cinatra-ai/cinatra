# The blog/non-CMS repair road is the new-run road

Recorded 2026-09-11.

## The decision

The product decision recorded on 2026-09-11 names the intended producer of a
repair, which is the first acceptance criterion of the work this record covers:

> the new-run road is the intended repair road — a requested change dispatches a
> new run of the producing agent carrying the request. The plan states it, the
> uncalled direct repair function is removed, and the audit card documents
> readings from that road.

## The measured road

The delivery half lives in `packages/agents/src/lifecycle-repair-dispatch-store.ts`.
A `changes_requested` decision opens a durable `cinatra.lifecycle_repair` row and
routes it; an async-effects-gated `producer_repair` row is then drained into a
DETERMINISTIC repair run (`lifecycle-repair-run:{repairId}`) on the PRODUCING
template, whose `input_params` carry the typed `ChangesRequestedRequest`. That
row IS the delivered request. The producing agent's own graph reads it on that
run and answers through `submitRepairResponse`, which pins the successor in a NEW
gate (never a repin under the reviewer) and re-points the held effect onto it.
The repair is CAS'd `requested` to `dispatched` when the run is created; a repair
whose producing run or template cannot be resolved, and a checkpointed repair
(whose plan half is a RESUME, not a new run), are escalated rather than left
silently pending.

The CMS half (`packages/agents/src/lifecycle-repair-cms-production-bridge.ts`)
completes dispatched `producer_repair` repairs whose base target is a stored CMS
snapshot; a non-CMS base target is left to its own producer's completion path,
which is this same new-run road.

## The measured gap that is now closed

`blog-post-repair-producer.ts` exported a direct-call repair function. Measured
on 2026-08-23 and re-measured at `main` on 2026-09-11: it had no production
caller at all — no route, no orchestration step, no assistant action; the only
occurrences outside its own definition were two comments naming it as the blog
pipeline's inline completion path. The audit card's "after a repair" evidence
cells were therefore produced by a driver calling it directly, not by a road the
product can take.

Under this record:

- the direct-call repair function and its input/result types are removed from
  `packages/agents/src/blog-post-repair-producer.ts`; the module keeps only the
  blog pipeline's repair-capability declaration, which the review orchestration
  reads to route a `changes_requested` to the producer;
- the two comments that named it as a completion path — in
  `lifecycle-repair-cms-production-bridge.ts` and
  `lifecycle-repair-dispatch-store.ts` — now name the new-run road, so the
  producing call named in the repair trail is the honest one (the third
  acceptance criterion);
- `packages/agents/src/__tests__/blog-repair-new-run-road-structural.test.ts`
  pins both: the function is no export of its module, and neither comment names
  a direct-call entry point.

No product behaviour changes with this record: nothing called the removed
function, so nothing loses a path.
