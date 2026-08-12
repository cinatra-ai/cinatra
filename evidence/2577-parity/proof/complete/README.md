# #2577 / #2683 — widget lifecycle parity proof

Captured 2026-08-12 on host2 against a live stack: the **shipped WordPress plugin**
(`cinatra` v0.1.7, active in `wp-admin`) framing the real `/embed/assistant`
surface, a real cinatra dev server on branch `lane/2683-s8f-parity`, and real
lifecycle rows.

## What is real here

- **The surface** is the shipped plugin in `wp-admin` — launcher bubble, panel,
  header, conversation window, prompt window. Never a harness page.
- **The gates** were written by the shipped store (`emitArtifactReviewGate`), on
  runs owned by the reader, against artifacts written by the shipped artifact
  write choke point (`createSemanticArtifact`) carrying **real PNG bytes**.
  Hand-written artifact SQL was tried first and is what the decision core's
  `revisionMember` guard correctly refuses ("a reviewed revision is no longer
  live") — the writer path is used because that guard has teeth.
- **The envelope** is minted by the real producer. The deterministic scripted
  provider decides *which* primitive to call; the runtime performs the call
  against the real self-MCP over the real transport with a real
  `cinatra.widget.mcp-obo` token. The persisted turn shows it:

  ```json
  { "name": "artifact_review_gate_render", "type": "tool_result",
    "serverLabel": "cinatra",
    "result": "{\"$cinatraLifecycleView\":1,\"viewType\":\"artifact_review_gate\",\"ref\":\"b5ybyfc…\"}" }
  ```

  Nothing in this proof was authored by the harness.

## Views

| View | File | State |
|---|---|---|
| V1 | `V1-wp-admin-launcher-closed.png` | delivered |
| V2 | `V2-panel-conversation.png` | delivered — the whole conversation in one frame: both user messages, both replies, the avatars, the per-message actions, the review card and the composer |
| V3 | `V3-composer-mention-flyout.png` | delivered — the composer close-up with the @-mention flyout OPEN over the real participant directory; the prompt-options trigger is in frame (the menu itself cannot be open at the same time — see below) |
| V4 | `V4-widget-review-card.png` | delivered — review card with the target header and island content |
| V5 | `V5-chat-review-card.png` | delivered — the SAME gate on `/chat`, drawn by the same card with its decision bar |
| V6 | `V6-widget-card-decided.png` | delivered — decided, `data-lifecycle-card-state="settled"`, gate row `resolved` |
| V7 | `V7-db-readback.png` (+ `V7-audit-rows.json`) | delivered — audit read-back, widget-decided gate beside its first-party-decided twin |
| V8 | `V8-no-access-no-card.png` | delivered — a second org member with no run access; the real tool answered `{"refs":[]}` and no card exists anywhere |
| V9 | `V9-verification-card.png` | delivered — a VERIFICATION card in the panel, `data-lifecycle-card-state="advisory"`, answering a record the repair pipeline minted |
| V10 | `V10-hosted-signin-grants.png` | delivered — all five grant sentences, including the three new S8f ones |

## The four gaps, closed (2026-08-12)

All ten views are now delivered. What each one needed:

- **V5** — the scripted-provider lifecycle branch now also serves the
  cookie-session `/chat` path. The provider still only NAMES the primitive; the
  runtime performs the call with the shipped chat bearer
  (`issueChatMcpActorToken`), so the delegated-CHAT tool policy and the S1 ladder
  decide the answer, and `serverLabel` is stamped only on results the dispatcher
  reported. Reaching the card also required a real defect fix: `/chat`'s server
  actions were answering **500** at this branch head, because a `"use server"`
  module re-exported a TYPE and the actions loader registered it as a binding
  (`ReferenceError: PendingToolConfirmationRow is not defined`).
- **V9** — the repair pipeline was stood up through its shipped entry points:
  `createSemanticArtifact` (base) → `emitArtifactReviewGate` →
  `recordChangesRequested` → `createSemanticArtifact` (successor) →
  `submitRepairResponse`, whose own best-effort trigger wrote the
  `artifact_verification_records` row (outcome `verified`, one field diff on
  `representation.resource`). Nothing wrote that table directly.
- **V2** — the panel was enlarged with the PLUGIN'S OWN resize corner
  (`.cw-resize`, a real drag inside its clamps) and the shared column's own
  scroll container was scrolled to the top of the conversation.
- **V3** — the flyout would not open because the widget's participant directory
  was unreachable: `/api/assistants/list` gained a widget auth branch in S8f but
  no route-guard entry, so the embed frame's cookieless GET was 307'd to
  `/sign-in`, `fetch` followed it, and the client parsed the sign-in HTML as an
  empty list. With the guard entry the list is real and the flyout opens on the
  first `@`.

### One thing the UI cannot do, measured rather than asserted

The prompt-options menu and the @-mention flyout **cannot be open at the same
time**: the options menu is a modal dropdown, so opening it (by pointer or by
keyboard focus) closes the popover — measured as `menus: 1, listboxes: 0` on both
routes. V3 therefore shows the flyout open with the options trigger in frame, and
no composite was staged to suggest otherwise.

### Still open, and NOT fixed here

Five sibling routes that S8f also gave widget branches carry the same
route-guard defect V3 hit — `/api/assistants/threads/<id>`,
`/api/assistants/autosave`, `/api/chat/pending-tool-calls`,
`/api/chat/undo-candidate`, `/api/artifacts/upload`. They are named in the guard
source next to the entry that was added. Each is a different shape (one dynamic
path, three mutating routes), so each owes its own entry and its own reasoning
rather than a batch exemption written by the lane that needed the directory.
