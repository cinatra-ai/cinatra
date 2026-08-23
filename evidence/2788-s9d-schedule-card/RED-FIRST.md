# Red first — cinatra#2788 (S9d rework)

Every executable claim this rework makes was run against the code as it stood
BEFORE the rework, and failed there. The control is the branch's own base commit
`466be722092422e404e473a748d97e852d80ba26` — the pre-rework S9d implementation,
with `Adjust`, a settled card that was the trigger's chrome everywhere, and the
schedule card mounted in the run screen's body and the review page's GATE
REGION — checked out into a second worktree with only the NEW/CHANGED test files
copied in. Nothing else was changed there.

That is what makes these failures a red-first record rather than a description
of one: the assertions are byte-identical to the ones that pass on this branch,
and the only difference is the implementation under them.

| What §7 requires | The test that fails before | What it says |
|---|---|---|
| the schedule is a STEP in the rail, never a card in the gate region | `src/lib/lifecycle/__tests__/schedule-card-host-mounts.test.ts` → "both pages place the rail STEP and neither mounts the card — the gate region is the review card's alone" | before: both pages mount `ScheduleProposalCard` themselves, and the review page mounts it inside the `page_gate_region` provider beside the review card |
| no Adjust step; the rows are editable and the floor is Confirm | `packages/agents/src/__tests__/schedule-proposal-card.test.tsx` → "NO Adjust control exists on any phase or any host", "the rows are LIVE on first paint, with no control to unlock them", "expired: … on the SAME Confirm floor — and no Adjust anywhere" | before: `[data-action="adjust-schedule-proposal"]` is drawn on the proposal and the expired faces, and the rows are read-only until it is pressed |
| one card across Confirm, changed in place with Save changes | same file → "the chat card KEEPS ITS IDENTITY across Confirm", "settled in a CONVERSATION: the same rows and Save changes, and NO trigger chrome, Cancel or Release", "Save changes posts the EDITED rows as `save` …" | before: the settled card replaced the rows with the trigger's chrome, drew Cancel trigger and Release now in the conversation, and had no Save-changes control at all |
| Save changes re-arms; a fired one-off is refused; a recurring change is future-only | `packages/agents/src/__tests__/trigger-service-save-schedule.test.ts` (all 11) | before: `updateRunTriggerScheduleForActor` does not exist — `TypeError: updateRunTriggerScheduleForActor is not a function` |

## The runs, verbatim

### `packages/agents` — the card suite and the Save-changes server suite, on the pre-rework tree

```
     × a recurring change replaces the schedule and installs the reader's own selections 3ms
     × FUTURE TICKS ONLY: the prior scheduler is cancelled before the replacement, and nothing fires now 0ms
     × an administrator may re-arm somebody else's run 0ms
     × REFUSES a one-off that has already fired — a fired schedule is not a schedule 0ms
     × allows a one-off whose moment is still ahead 0ms
     × REFUSES a released trigger — its held steps are already eligible 0ms
     × REFUSES a run with no armed trigger at all 0ms
     × REFUSES "Run right after setup" — Save changes is not a disguised Release now 0ms
     × REFUSES a caller who is neither the run's owner nor an administrator 0ms
     × REFUSES an unauthenticated caller before it reads anything 0ms
     × REFUSES a run that does not exist 0ms
     × proposal: the option rows EDITABLE as they stand, the chosen row marked, the duration, and a Confirm-only floor 159ms
     × settled on a PAGE host: the trigger's chrome, the SAME editable rows, Save changes, and the two quiet controls 1025ms
     × settled in a CONVERSATION: the same rows and Save changes, and NO trigger chrome, Cancel or Release 1018ms
     × the chat card KEEPS ITS IDENTITY across Confirm — one root before and after, never a second card 1162ms
     × Save changes posts the EDITED rows as `save` on the card's own ref, and re-resolves rather than drawing optimistically 1017ms
     × Save changes is withheld where the server will refuse it — canSave false draws a dead control 1014ms
     × settled: Release now is admin-only — a non-admin body draws no control at all 1011ms
     × settled: ARMING withholds Cancel and says why, rather than drawing a control that fails on press 1009ms
     × settled: an ALREADY-RELEASED trigger offers neither control and reads back why 1009ms
     × expired: the card STAYS VISIBLE, its rows editable, on the SAME Confirm floor — and no Adjust anywhere 55ms
     × NO Adjust control exists on any phase or any host — the rows are the only way to change a proposal 35ms
     × the root carries its lifecycle-card identity, its host and its state — one instance per host, drawing the ratified anchor set 1048ms
     × the widget draws NO cookie-bound affordance: the deep link into the run is first-party only 1008ms
     × Cancel asks first, in the Trigger tab's own words, and only then acts 1018ms
     × Release now asks first with its irreversibility warning, then reaches the release operation 1025ms
     × the rows are LIVE on first paint, with no control to unlock them 40ms
     × an EDITED proposal is re-proposed and THEN confirmed, on the new ref 1077ms
⎯⎯⎯⎯⎯⎯ Failed Tests 28 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  2 failed (2)
      Tests  28 failed | 12 passed (40)
```

### the mount inventory, on the pre-rework tree

```
     × the rail step mounts the card ONCE and declares BOTH page hosts itself 1ms
     × both pages place the rail STEP and neither mounts the card — the gate region is the review card's alone 3ms
     × both pages mint a SERVER-side ref and draw no step when they cannot 1ms
     × the card is defined in exactly ONE module in the whole first-party tree 1ms
     × every ratified §VI anchor is emitted 3ms
     × it consumes its AUTHORIZED body through the one resolve seam, and reads every phase 1ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 6 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  1 failed (1)
      Tests  6 failed | 3 passed (9)
```

## Green, on this branch

`packages/agents` card suite 29/29 · `trigger-service-save-schedule` 11/11 ·
`src/lib/lifecycle` + `src/app/api/lifecycle-views` 46 files / 687 · the whole
`packages/chat` suite 70 files / 875 · `scripts/audit` route-graph-ratchet 31/31.
