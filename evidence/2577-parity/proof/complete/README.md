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
| V2 | `V2-PARTIAL-panel-no-visible-history.png` | **partial** — panel, avatar, name, assistant answer and the message actions are visible; the user message scrolled out of the panel viewport and did not stay in frame |
| V3 | `V3-PARTIAL-composer-no-flyout.png` | **partial** — the shared multi-line composer and its attachments control are visible; the @-mention flyout did **not** open and the prompt-options menu was not captured |
| V4 | `V4-widget-review-card.png` | delivered — review card with the target header and island content |
| V5 | `V5-MISSING-chat-no-card.png` | **missing** — `/chat` drew no card; see below |
| V6 | `V6-widget-card-decided.png` | delivered — decided, `data-lifecycle-card-state="settled"`, gate row `resolved` |
| V7 | `V7-db-readback.png` (+ `V7-audit-rows.json`) | delivered — audit read-back, widget-decided gate beside its first-party-decided twin |
| V8 | `V8-no-access-no-card.png` | delivered — a second org member with no run access; the real tool answered `{"refs":[]}` and no card exists anywhere |
| V9 | `V9-MISSING-no-verification-record.png` | **missing** — see below |
| V10 | `V10-hosted-signin-grants.png` | delivered — all five grant sentences, including the three new S8f ones |

## The gaps, stated plainly

- **V5** — `/chat` renders no lifecycle card in this stack. The scripted-provider
  branch that makes the model layer call the lifecycle primitives is gated to the
  **widget** path (`widgetPrincipal` present); the cookie-session `/chat` path
  resolves a real adapter and would need a real LLM to choose the tool. The
  comparison view was therefore not produced. No substitute was photographed.
- **V9** — `verification_record_render` answered the real refusal
  (`"Not available to you."`) because **no verification record exists**: a record
  is minted by the repair pipeline against a landed repair successor, which this
  proof did not stand up. Seeding the row directly would not have been the
  product path.
- **V2 / V3** — the panel viewport is short and the conversation pins to the
  newest line; scrolling the message list did not keep the user message in frame,
  and the @-mention flyout did not open under synthetic keystrokes. Both files are
  named `*-PARTIAL-*` so they cannot be read as the view they were meant to be.
