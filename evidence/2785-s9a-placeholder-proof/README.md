# S9a — the two transcript cards are placeholders

This slice's central claim is visual: two of the four lifecycle kinds are not
drawn. The claim needs three proofs. One is delivered here. Two are not, and
this file says exactly why and exactly what would deliver them.

## (c) DELIVERED — the required gate names both undrawn kinds

`required-gate-run.txt` is the verbatim run of the gate with no flags, on this
branch, whose product tree is byte-identical to the default branch:

```
$ node scripts/audit/chat-hitl-one-card-gate.mjs
[chat-hitl-one-card] 6 violation(s):
  … [R5] 'trigger_schedule_proposal' has no card of its own …
  … [R5] 'verification_summary' has no card of its own …
exit 1
```

The ordinary run is the done-check, so this is the run anybody makes. Six
findings, not two: the recommendation card's root obligation and its three
unmounted hosts are named in the same output rather than filtered out of it.

## (a) and (b) NOT DELIVERED — the schedule shell and the verification shell in a real chat conversation

Both cells need the same thing: a lifecycle `DATA_PART` inside an assistant turn
of a real conversation, resolved and authorized by the server, drawing the S1
shell. Neither is delivered. The reasons are code-grounded, not scheduling.

**No shipped path puts a lifecycle data part into a chat transcript without a
model dispatch.** The development API surface is two routes — `lifecycle-seed`
and `logs`. Nothing writes an assistant turn. Reaching a chat-hosted card
therefore needs an LLM-backed dispatch through the deterministic scripted
provider, which is the same conclusion the earlier conformance round recorded
for its own chat cells. That runs on the development runtime only: the
scripted-provider fence and the lifecycle-seed fence make a production build and
a model-backed dispatch mutually exclusive by construction, which is why a
development-runtime capture is the sanctioned form here and why every such image
must carry its runtime label.

**The verification cell (b) has a seed; the schedule cell (a) has none.** The
development seed drives shipped writers only and exposes exactly two fixtures:
`repairVerification`, which produces a real review gate, a real repair and a real
verification record bound to that gate, and `restorableChangeSet`. There is no
schedule-proposal arm. So (b) needs the seed plus a dispatch that carries its ref
into a turn; (a) needs a proposal produced first, which today means either a real
scheduling dispatch or a new fixture arm in that seed. Adding a fixture arm is a
change to shipped development surface, and it is not this slice's to make
unasked.

**Machine discipline.** A sibling lane held the capture stack. The bounded wait
ran to 34 of its 40 iterations before that project released, and no stack was
started here, so nothing contended with it and nothing was left running. The
operator's own stack was never touched.

## What would deliver (a) and (b)

Per cell, on a throwaway project with its own name and ports, on the development
runtime, with the runtime named on the image:

1. Seed the subject with the shipped writers. For the verification cell that is
   the existing fixture. For the schedule cell, a real proposal must exist first.
2. Dispatch a turn through the deterministic scripted provider so the kind's
   `DATA_PART` lands in a real conversation, then open that conversation.
3. Assert on the DOM of the card that draws, not on a screenshot alone:
   - `[data-lifecycle-card="trigger_schedule_proposal"]` / `[data-lifecycle-card="verification_summary"]` present, exactly one of each;
   - `data-lifecycle-card-state` equal to the state the server resolved, which
     is `advisory` for the verification kind;
   - **zero** occurrences of that kind's ratified anchors — `schedule-option-rows`,
     `schedule-proposal-floor`, `scheduled-run-chrome`,
     `[data-action="cancel-trigger-schedule"]`, `[data-action="release-trigger-now"]`
     for the schedule kind; `verification-in-thread` and all three outcome
     anchors for the verification kind. The absence is the evidence.
4. Record the machine assertions beside the pixels. A screenshot is never the
   only evidence.

Under the capture-ownership rule these cells are provisional wherever they are
produced: the canonical cell names, the capture index and the manifest's
transition to proven belong to the final conformance slice.
