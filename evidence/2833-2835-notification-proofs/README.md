# cinatra#2833 / #2835 — the notification proofs

Acceptance 3 of both issues: a real-app proof that the review openings and the
recommendation hold now reach the bell, that the entry leads to the work, and
that the row goes away when the decision lands.

Captured on this lane's own development stack on 2026-08-19, at the branch head
that carries the fix. Every picture below has its log lines in
`cells/capture-log.txt`; the anchors are read off each element's OWN identifying
attributes before the shutter, and the notification rows are read straight out of
the database beside them. **A file name carries no authority. The log line does.**

---

## What produced the notifications

Nothing in this directory writes a notification. The drivers stage the SUBJECT —
a run, artifacts, an assigned skill — and the shipped code does the rest:

| Path (#2833/#2835) | What drove it |
|---|---|
| batch sweep — `orchestrateProducedBatch()` | the RUNNING APPLICATION's own 30-second review-orchestration loop, over pending produced-outbox rows the driver staged |
| repair-successor pin — `submitRepairResponse()` | the shipped development seed route `POST /api/development/lifecycle-seed`, fixture `repairVerification`, inside the app |
| verification reopen pin — `writeVerificationRecordAndMaybeReopen()` | the same seed call, inside the app |
| recommendation hold — `maybeHoldRunForRecommendation()` | `drivers/stage-hold.test.ts`, calling the shipped hold evaluator with the app's own `register-run-wait-notifier` host wired |

On `main` every one of those four writes NOTHING. That is the defect both issues
describe, and it is why the bell below is not empty.

---

## #2833 — a review opening reaches its audience

Run `cf144038-a61a-45f9-918f-462790538537`, three gates, three rows.

| Step | Picture | Anchors quoted from the log |
|---|---|---|
| 1. the bell carries a badge | `cells/2833-bell.png`, `cells/2833-bell-page.png` | `bell anchors: {"present":true,"ariaLabel":"Notifications, 5 need your attention","href":"/notifications","badgeText":"5"}` |
| 2. the list carries the entries | `cells/2833-list.png` | `feed anchors: {"listPresent":true,"rowCount":6, …}` — three rows point at `/agents/cinatra-ai/blog-draft-writer-agent/cf144038-…`, stamped `4:43:11 PM` (batch), `4:42:40 PM` (verify) and `4:42:39 PM` (repair) |
| 3. the entry opens the run | `cells/2833-click-through.png` | `clicking the row whose activate link is /agents/cinatra-ai/blog-draft-writer-agent/cf144038-…` → `landed on: …/cf144038-…` → `landing conformance ids: ["sidebar-assistants-entry","run-surface","run-step-rail"]` |
| 4. the run's Review rail holds all three | `cells/2833-batch-run-page.png` | `Review rail entries on the run page:` lists `…/review/lifecycle-review%3Arepair%3A48799029…%3A1`, `…%3Averify%3Averify%3A8eb5783e…` and `…%3Abatch%3Af58e0d49…` |
| 5. the rail entry opens the review | `cells/2833-batch-review-page.png` | `Review rail entry followed: …%3Abatch%3Af58e0d49…` → `review page conformance ids: ["sidebar-assistants-entry","review-gate-card","review-target-island","review-decision-bar","review-prompt-window"]` |
| 6. the decision lands | `cells/2833-batch-decided.png` | `review page conformance ids after Approve: ["sidebar-assistants-entry","review-gate-blocked"]` — the gate is no longer open |
| 7. the row is gone | `cells/2833-row-gone.png` | `feed anchors after the decision: {"listPresent":true,"rowCount":5, …}` — the `4:43:11 PM` row is absent, and the database goes from six dedupe keys to five with `run-awaiting-human:auto:cf144038-…:lifecycle-review:batch:f58e0d49…` the one removed |

The click-through in step 3 is the notification's own `href`, followed by
clicking the row — not a URL typed by the driver.

---

## #2835 — an abandoned hold reaches its audience

Run `b6a72fe7-2dbf-4ad9-b911-1314c7ae12d2`, park
`52040b57-4c27-48f5-bad9-af151e4ef0f0`.

| Step | Picture | Anchors quoted from the log |
|---|---|---|
| 1. the hold parks and writes | (staging output) | `hold: {"held":true,"parkId":"52040b57-…","reason":"core default fires recommendation"}`, park `{"status":"parked","holdNotification":"live"}` — and the row it names: title `A run needs your input`, `holdParkId = 52040b57-…` |
| 2. the bell carries a badge | `cells/2835-bell.png`, `cells/2835-bell-page.png` | `bell anchors: {"present":true,"ariaLabel":"Notifications, 3 need your attention","badgeText":"3"}` |
| 3. the list carries the entry | `cells/2835-list.png` | `feed anchors: … {"title":"A run needs your input","href":"/agents/cinatra-ai/blog-draft-writer-agent/b6a72fe7-…","stamp":"8/19/2026, 5:04:40 PM"}` — the copy the #2729 ruling gives an unanswered input field |
| 4. the entry opens the held card | `cells/2835-click-through.png`, `cells/2835-hold-card.png` | `landed on: …/b6a72fe7-…` → `landing conformance ids: [… "run-chip-row"]`; `chip-row anchors before the decision: {"chipRowPresent":true,"chips":[{"skillId":"@cinatra-ai/chat:blog-content","selected":"false"}],"buttons":[… "Confirm","Skip"]}` |
| 5. Confirm settles the card | `cells/2835-hold-confirmed.png` | `chip-row anchors after the decision: {"chipRowPresent":false, …}`; the park reads `released \| cleared` |
| 6. the row is gone | `cells/2835-row-gone.png` | `rows still pointing at 2835: 0` — the `5:04:40 PM` "A run needs your input" row is absent |

### The clear removed its OWN row, and only that one

Step 6 is worth reading twice. After Confirm the run dispatched and reached a
genuine setup gate, which minted a NEW row on the SAME per-run dedupe key at
`5:13:38 PM` (`"Blog Draft Writer Agent (1)" needs your input`, `holdParkId`
absent, reason `pending_approval`). The hold's own row is gone; the later,
unrelated wait's row is untouched. That is the park-scoped clear doing exactly
what it claims, observed live rather than asserted.

---

## What is real, and what is fixture

REAL and on the path under proof: the application, the sign-up, the bell, the
notification feed, the run surface, the review surface, the chip row, the
orchestration sweep, the batch partition, the gate emit, the repair and
verification pins, the hold evaluator, the fenced notification write, the
park-scoped clear, Postgres and Redis.

FIXTURE, none of it inside the mechanism under proof:

- the instance owner is a REAL Better Auth sign-up through the app's own
  first-owner surface (`drivers/01-signup.mjs`) — listed here only because the
  proofs address their notifications to that identity;
- the runs, created through the shipped `createAgentRun` /
  `createAgentRunPendingInput`;
- one `agent_assigned_skills` row, because the recommendation scorer only offers
  an agent's own assigned set and a fresh instance assigns none;
- for the BATCH cell, the two produced-outbox rows the seed route wrote were
  flipped from `origin_kind = user_provided` to `agent_produced` before the sweep
  read them. That changes what the artifacts DECLARE about their origin — which
  origin the review policy is asked about — and nothing else. The sweep, the
  eligibility partition, the gate emit and the notifier are untouched shipped
  code, and the flip is what lets the batch's targets be REAL artifacts with real
  representations, so the gate is genuinely decidable (step 6 above).

## What could not be produced on this branch, and why

**The hold's notification links to the run page here, not to a conversation.**
The #2729 ruling and the host writer both prefer the conversation a held run was
started in, and the writer resolves it whenever one exists. On this branch a run
started FROM a conversation cannot hold at all — that is S9b
(cinatra-ai/cinatra#2786), gap 6 of the audited plan, and it is not on this
branch's base. So the hold above was started outside chat, the conversation
lookup correctly finds none, and the notification lands on the run page, which is
the shipped fallback. The conversation variant becomes capturable once S9b lands;
the code path that chooses it is pinned in
`src/lib/__tests__/agent-run-wait-notifications.test.ts`.

## Reproducing

```
node evidence/2833-2835-notification-proofs/drivers/01-signup.mjs      <baseUrl> <sessionDir>
npx vitest run --config .../drivers/stage-batch.config.ts              # the batch subject
npx vitest run --config .../drivers/stage-hold.config.ts               # the hold
node evidence/2833-2835-notification-proofs/drivers/capture.mjs        <baseUrl> <outDir> <state.json> <cell> [arg] [arg2]
```

One correction was made to the drivers AFTER the session, and it is disclosed
rather than quietly folded in: both staging drivers passed the role literal
`"owner"` to `sessionAuthorityFromResolvedRole`, which is not a member of the
kernel's `Role` union (the typed name for this actor is `org_owner`) and which
the repository typecheck refuses. The literal was INERT for what these drivers
did: `sessionAuthorityFromResolvedRole` only consults the role when a
capability's rule is not `"member"`, and `EFFECTIVE_GRANTS["owner"]` does not
exist — reaching that branch would have thrown and failed the staging outright.
The staging succeeded, so the branch was never taken, and correcting the literal
cannot change what was captured.

`cells/capture-log.txt` is the session log, kept whole. It includes earlier
attempts against a first, synthetic batch subject whose targets carried no real
representation and whose gate therefore refused its decision
(`review-gate-blocked`, "A reviewed revision is no longer live"). Those cells were
discarded and re-shot against real artifacts; the log keeps the record rather than
hiding it.
