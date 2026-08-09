# Live UAT — PR #2601 (UI-BATCH-233: #2593 + #2599)

Battery B of lane DOUBLE-UAT-236. This is the combined batch UAT this PR's own
UAT section records as deferred ("Both PR3 and S0-compose held the shared primary
browser slot … a live UAT pass (both surfaces, one boot) is owed as a follow-up
whenever the browser slot frees").

**Result: 6 of 6 checks PASS.**

## How this was run

One dev boot carried BOTH unmerged sibling PRs, so a single instance could pay off
two owed UATs:

- throwaway local integration branch `uat/236-local` = `origin/main` (aa83d887)
  + merge of `lane/2597-approval-scope` (8749476f, PR #2602) + merge of
  `batch/ui-233` (2c56966f, this PR). Never pushed; deleted on completion.
- **Both merges were clean — no conflicts.** The two PRs' file sets are fully
  disjoint (verified with `git diff --name-only` of each against main: zero shared
  paths). The anticipated adjacency did not materialise — #2599 touches
  `src/lib/approvals/sources/{types,agent-creation-requests}.ts` and its tests,
  while #2602 touches `src/lib/approvals/{actions,decision-helpers,agent-decision-actions}`
  and the `[id]` route. Adjacent area, no shared file.
- Next dev server on port 3121, workers=1, one browser.
- Dedicated database `uat236` on the verify Postgres (127.0.0.1:5634), migrated to
  the integration branch head. Dropped on completion.
- Extensions synced pinned (`sync-dev-extensions.mjs --pinned` → 111/111).
- `CINATRA_ENCRYPTION_KEY` is 32 bytes (asserted).
- **`CINATRA_E2E_SETUP_BYPASS=true`** — stated per the batch-225 precedent. Both
  surfaces under test are post-setup, so the bypass touches neither contract.
- Sessions are real: Better Auth sign-up + sign-in through the app's own
  `/api/auth/*`, then `organization/set-active`. Two distinct real users were
  signed in and out to get the two viewer perspectives in check 5 vs 6.
- Clipboard assertions use a real CDP permission grant
  (`grantPermissions(['clipboard-read','clipboard-write'])`) and read the actual
  system clipboard back, after seeding it with a sentinel so a stale value cannot
  produce a false pass.

## #2593 — the whole-response action bar

Two threads with byte-identical content, differing only in `slackMode`, both
persisted through the app's own `POST /api/assistants/threads` and opened from the
Threads panel like a user would. Each carries a well-formed prior user turn and a
finished (non-streaming) assistant response — so Try again has a valid resend
target available in both, and its absence in Slack mode is a real suppression
rather than a missing prerequisite.

| # | Check | Result | Capture |
|---|---|---|---|
| 1 | ChatGPT mode (`slackMode: false`): a finished response shows **both** Copy response and Try again | **PASS** — `copyCount: 1`, `tryAgainCount: 1` | `B1-chatgpt-copy-and-tryagain.png` |
| 2 | Copy response actually writes the clipboard in ChatGPT mode | **PASS** — clipboard went from `__uat236_sentinel__` to the exact response text | `B1-chatgpt-copy-and-tryagain.png` |
| 3 | Slack (multi-participant) mode (`slackMode: true`): Copy response present, Try again **never** rendered, with a well-formed prior user turn present | **PASS** — `copyCount: 1`, `tryAgainCount: 0`, `hasUserTurn: true`, `hasAssistantBody: true` | `B2-slack-copy-no-tryagain.png` |
| 4 | Copy response actually writes the clipboard in Slack mode too (the shared arm) | **PASS** — clipboard went from `__uat236_slack_sentinel__` to the exact response text | `B2-slack-copy-no-tryagain.png` |

Checks 3 and 4 together are the point of the fix: the row now mounts in the
Slack-mode branch (Copy works there for the first time), while Try again stays
suppressed exactly as the PR scopes it.

## #2599 — the admin's own chat-created request

The admin is the org's **sole** platform admin, so `viewerMayApproveOwn` is true
through the #392 single-admin exception — a genuine grant, not a
`connector_config.allowSelfApproval` override.

The own row was created through the real `agent_creation_request_propose` primitive
under the **delegated-chat admin** actor (`actorType: "model"`, `source: "agent"`,
`platformRole: "platform_admin"`, `delegatedRestricted: true`) — the frame the chat
model uses on the user's behalf. That path deliberately does not fire the #382
instant grant, so the row queues at `proposed`: exactly the "admin's own
chat-created agent request" state #2599 is about. Confirmed at seed time
(`status=proposed instantGrant=false`).

| # | Check | Result | Capture |
|---|---|---|---|
| 5 | The admin's own chat-created request renders **actionable** in `/notifications` — "Awaiting you" with the inline decide slot (Approve / Reject), not "Awaiting others" | **PASS** | `B4-2599-admin-own-actionable.png` |
| 6 | A genuinely others-only row still shows the passive state | **PASS** | `B5-2599-others-only-passive.png` |

Row text observed for check 5, as the admin:

```
UAT236 B2 Admin Own (chat-created)   Awaiting you   …   Approve  Reject  Details
```

Row text observed for check 6, signed in as the non-admin author, for that
author's own pending request (they must wait on the admin):

```
UAT236 B2 Someone Else   Awaiting others   …   no action for you
```

The contrast is driven by the flag this PR made public: the admin's own row is let
through `isApprovalActionable`'s `mine` branch by `decidableOwn`, while the
non-admin author's own row is not (`viewer.isAdmin` is false, so `mayApproveOwn`
never resolves true) and keeps the passive trailing slot.

## Scope note

`/notifications` also surfaced the requests seeded for Battery A (PR #2602) in the
admin's inbox — expected, since one instance carried both PRs. Those rows are not
part of this PR's checks; #2593 and #2599 are asserted on their own fixtures above.
