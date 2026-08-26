# cinatra#2933 lifecycle-b W5b — the picture leg

The prompt window outside the chat, photographed on the real running app: a run
owner who is **not** a platform administrator types into it, a real model
answers, and the exchange is there after a reload.

Full-window captures at 1440x900, device scale 2 (2880x1800 px), light and dark,
taken through the app's own theme control. Every capture was viewed before it was
recorded. The environment, run ids, timestamps and hashes are in
`capture-records.md`.

Graded against design commit `fe2182547d4a`:
`specs/app-artifact-review.html` §VI (the decision — approve / reject / comment
and the prompt window) and §IX (the conversation above the prompt window), and
`specs/app-lifecycle-cards.html` §X (typing to the bound card).

## Surfaces reached

| Surface | Where it was photographed | Window drawn? |
|---|---|---|
| schedule | the run page's scheduling step of a `pending_trigger` run | yes |
| armed-trigger | the Trigger tab of a run with an armed recurring schedule | yes |
| step-by-step | the 5-step campaign rail of an `email-outreach` run at its first gate | yes |
| review | the artifact review page of a run that produced a blog post artifact | yes |
| run-page | the agentic run panel at a mid-run gate | **no — see Deviation 1** |

## The captures

| Capture | Requires (design `fe2182547d4a`) | Shows | Verdict |
|---|---|---|---|
| `schedule__box-placeholder__{light,dark}` | §IX: the window is the field alone until the first message — "There is no panel above an empty exchange"; §VI: the field is offered as *"Ask Cinatra to suggest edits to the fields above…"* | the scheduling step with the field alone at the foot of the page, placeholder read verbatim; no panel above it; signed in as a non-administrator run owner | **PASS** |
| `schedule__exchange-after-reload__{light,dark}` | §IX: turns not a transcript — the reader's own turn right-aligned on the primary ground, the assistant's left-aligned on the muted surface, at most four-fifths of the panel width, no author label, no avatar, no timestamp; clicking into the field opens the panel again | the panel above the field after a browser reload, holding `what is this step waiting for?` right-aligned on the primary ground and the model's answer left-aligned on the muted surface, both without label, avatar or timestamp | **PASS** on shape; the persistence itself is a **named deviation from §IX's stale sentence** — see Deviation 2 |
| `armed-trigger__box-placeholder__{light,dark}` | as above, on the armed-trigger tab | the configured recurring schedule (`recurring`, `At 09:00 AM, only on Wednesday`, `UTC`) with the field alone beneath it, placeholder verbatim | **PASS** |
| `armed-trigger__exchange-after-reload__{light,dark}` | as above | after a reload, this surface's own turn and the model's answer — an answer that read the run's real state (`armed`, waiting on a schedule decision) through the platform's own tools | **PASS** |
| `step-by-step__box-placeholder__{light,dark}` | as above, on the step-by-step screen | the five-step rail (Campaign setup → Test & send) with the gate's form, and the field alone beneath, placeholder verbatim, paperclip offered (a non-setup gate) | **PASS** |
| `step-by-step__exchange-after-reload__{light,dark}` | as above | after a reload, the person's turn right-aligned and the model's answer left-aligned above the field | **PASS** |
| `review__box-placeholder__{light,dark}` | §VI: one decision bar — rationale field *"Add a note for the run and the audit trail…"*, `Comment`, `Reject` (destructive), `Approve` (primary) — with the conversational prompt window beneath it | the artifact review card (`Blog Post Artifact`, the model's own draft), the decision bar exactly as drawn, and the window's field beneath with the placeholder verbatim | **PASS** |
| `review__exchange-open__{light,dark}` | §IX turns-not-transcript; §VI: "typing a change request into it is how a reviewer requests changes … on submit the gate resolves changes-requested and a repair goes in flight"; §X: "a typed comment lands word for word" | the person's turn, the model's answer, and the platform's own line `Changes requested. The reviewed work has been turned back for repair — a repair is now in flight.` — the §IX drawing's own example sentence, verbatim | **PASS** |
| `review__exchange-after-reload__{light,dark}` | §IX: "The window is drawn only for a reader who may act on the screen it sits on" | after the reload the gate is resolved (`Changes requested by Rita Owner`) and there is **no window and no exchange** on the page — the surface has no decision left to take | **PASS** as §IX's access rule; **DEVIATION 3** against the recipe's "the exchange open after the reload" for this one surface |
| `run-page__no-window-drawn__{light,dark}` | §IX: the window is drawn wherever the reader may act on the screen it sits on | the run page's own gate (`Draft Context`, a live `Continue`) with **no window at all** for the run's own owner | **DEVIATION 1** |
| `{run-page,schedule,armed-trigger,step-by-step}__no-respond-access__{light,dark}` | §IX: "where they may not [act], there is no window and no exchange rather than a field that would be refused" | a signed-in member who is not the run's owner is refused the run itself — no window, no exchange, no field | **PASS** |
| `review__no-respond-access__{light,dark}` | as above | `You don't have access to this review — This review belongs to an agent run you're not authorized to see.` with no window and no field | **PASS** |

## Deviations, named

1. **The run-page window is not drawn on the real surface.**
   `packages/agents/src/agentic-run-panel.tsx:1497` requires `!!templateId`
   before the window renders, and the only production mount of that panel
   outside the chat — `packages/agents/src/setup-completion-watcher.tsx:225` —
   passes no `templateId` (nor does the screen pass one to the watcher at
   `packages/agents/src/instance-screens.tsx:1275`). The panel's other mount is
   the chat's inline run card, where the window is suppressed by design
   (`surface !== "chat"`). So on a run whose detail takes the `agentic` branch
   the box is absent for the run's own owner, as
   `run-page__no-window-drawn__{light,dark}` shows. This is **not introduced by
   this slice** — `templateId` is absent from that file on `main` at
   `cb896cee9231` too — and the slice's own surface test is a source-text check,
   not a render. The four other windows are reached and photographed.

2. **The exchange survives a reload; §IX says it must not.** §IX states "It is
   not carried across a reload either: what survives a reload is the reader's
   unsent draft in the field, not the turns above it". The captures show the
   turns after a reload. That is this slice's whole point and the plan's
   Done-definition; the spec sentence is a faithful drawing of the product
   *before* this slice and is now stale. A paired design correction is owed
   before §IX is graded as conformance. (Recorded as Deviation 2 in the PR body.)

3. **The review window's exchange cannot be photographed after a reload.** On
   the review page the same keystroke that sends the message also files the
   review's change request (§VI: "there is no dedicated 'request changes'
   button"), so the gate resolves and the window is correctly gone on the next
   paint. The exchange itself IS stored with the run — `agent_run_messages`
   rows 1 and 2 under `message_type='window'` for run
   `de326907-2d87-4ee7-a247-b13b5cc09eeb`, listed in `capture-records.md` —
   it is the SURFACE that no longer draws a window, not the record that is lost.
   `review__exchange-open__{light,dark}` photographs the exchange on that same
   surface a moment earlier.

4. **The tool-less capture is not in this set.** The platform's own sentence for
   a model that cannot operate anything is reached only on a conversation-only
   provider (`packages/llm/src/mcp-access.ts` / `isConversationOnlyProvider` —
   Gemini today). On this instance the provider is committed and
   Administration's **Change provider** control is disabled with no stated
   reason, so the state cannot be reached through the product's own path here.
   Named rather than faked.

5. **Dark-theme bubble ground.** §IX draws the reader's turn "on the indigo
   ground in white". The window paints it with the same design token in both
   themes (`bg-primary text-primary-foreground`), so in dark theme the ground is
   the theme's own light primary with ink text. Same token, dark-theme value —
   recorded, not counted as a deviation from the light-mode drawing.
