# cinatra#2935 (lifecycle-b W5d) — the picture leg

Head under proof: `ba19ed0bdc1f41d61d6bac6a8ca66bc824feff7f`, plus this evidence commit.

Six full-window captures, light and dark, of the two hosts this slice names — the
chat page and the embedded assistant on a third-party application — plus the
refusal. Every capture was viewed before it was recorded here.

## The runtime, said first

The branch's own dev server (Next.js, Turbopack), `CINATRA_RUNTIME_MODE=development`,
on a dedicated database created for this round by cloning the previous round's
template, with the branch's own extension tree. **A real provider key and a real
model**: the organization's own configured provider and model — `openai` /
`gpt-5.5` — with the turns below recorded as real streams in `usage_events`
at 15:05:44.976Z, 15:06:12.188Z, 15:10:24.902Z and 15:10:52.413Z (and at
14:32:42.482Z for the chat leg). No credential was placed on the capture machine;
the key lives encrypted in the database the round inherited.

**The signed-in person is an ordinary member.** `member` in `public.member` for
the one organization, **no** row in `cinatra.role_grant`, **no** row in
`cinatra.project_access`, **no** row in `cinatra.project_co_owners`.

**Two agents, one they may start and one they may not.**

| | package | install scope |
|---|---|---|
| may start | `@cinatra-ai/blog-draft-writer-agent` | `owner_level='organization'`, the person's own org |
| may **not** start | `@cinatra-ai/lint-policy-agent` | `owner_level='project'` onto a project owned by **another user**, on which the person holds no grant |

**The third-party application is genuinely cross-site.** The app answers on
`http://localhost:3020`; the page the widget is embedded in is served from
`http://127.0.0.1:3021`. Those are different origins **and different sites** —
`localhost` and `127.0.0.1` are not the same registrable domain, so the app's
`SameSite=Lax` session cookie cannot ride the embed frame. The widget instance
and its connect-site were written by the two **shipped** writers the CMS OAuth
exchange itself calls (`writeConnectorConfigToDatabase`,
`upsertConnectSiteAndMintCredential`), `deriveFrameBinding` was asserted to close
before anything was driven (`ok: true`, site `423e66c5…`, credential version 1),
and the person signed in through the **hosted flow the frame itself opens** —
nothing was injected into the frame's context.

**The waits are the two the recipe names, never a fixed sleep.** Each leg waits
first for the assistant's tool call to settle (the live-status line gone off the
turn), then for the run card to attach, and records both timestamps.

## The drawing this is graded against

`specs/app-lifecycle-cards.html` at `fe2182547d4a`, **§I The conversation** and
**§IX Where each card appears**, rendered headless at 1440 wide and read as
pixels. What §I fixes: the thread is the frame; two turn shapes — a person's turn
right-aligned with name and initials above, a filled bubble that hugs its text
and the quiet copy/edit marks beneath; the assistant's turn left-aligned with
**no bubble**, the Cinatra mark and name, then the content on the thread ground
filling the column, where **a card takes that content slot at the column's full
width, exactly where prose would otherwise sit**; and **exactly one primary
input per conversation**, the chat box, on the raised ground with the send
affordance. What §IX fixes: four hosts, one card set, the **same card** wherever
it appears — only the **frame** changes; and the reader matrix, whose bottom row
is **"No card at all"** for a reader who may not read the target.

## Captures

| capture | requires | shows | verdict |
|---|---|---|---|
| `chat__assistant-started-the-agent__light.png` | §I: the card arrives in a conversation, after what the person asked; the person's turn right-aligned with name + initials, a filled bubble, copy/edit marks beneath; the assistant's turn left-aligned, no bubble, mark + name; the card in the assistant's content slot at the column's full width; one primary input | Thread bar `Chat ›` with the thread's title. `Ops Operator Two` + `OO` above a right-aligned filled bubble holding the sentence verbatim, copy and pencil beneath. `Cinatra` mark and name, no bubble. The run card — `Agentic Run Progress`, the `Awaiting input` pill, the `Idea (optional)` field, `Continue` — fills the assistant's content slot at the column's full width, with the assistant's prose and `Run ID: ef3d6e38-0c00-4172-a11d-be426ea50441` beneath it. One composer: `+`, `Type a message...`, the circled send. | **PASS** (deviations D1, D4) |
| `chat__assistant-started-the-agent__dark.png` | the same regions and shapes, in the app's dark palette | Byte-for-byte the same composition, dark ground, dark bubble, the card's own panel and pill re-toned; nothing added, nothing dropped | **PASS** (deviations D1, D4, D5) |
| `site-widget__assistant-started-the-agent__light.png` | §IX: the **same card** on the site-widget host, only the frame changed; §I's two turn shapes and one primary input inside that frame | The third-party page's own header, then the widget panel: `You` + `Me` above a right-aligned filled bubble with the sentence, copy/pencil beneath; `Cinatra` mark and name, no bubble; the **same** card — `Agentic Run Progress`, `Awaiting input`, `Idea (optional)`, `Continue`, `No messages yet.` — in the assistant's content slot at the panel's full width; one composer at the foot. The bridge log below the frame carries the real `cinatra.embed.ready` → `cinatra.embed.context` handshake. | **PASS** (deviations D1, D2, D6) |
| `site-widget__assistant-started-the-agent__dark.png` | the same, in dark | The same panel and the same card in dark, inside the third-party page's own (unchanged, light) chrome | **PASS** (deviations D1, D2, D5, D6) |
| `site-widget__refused__may-not-start__light.png` | the refusal is the platform's own sentence, relayed; **no card may appear** for the refused start; §IX reader matrix: "No card at all" | A second person's turn naming `@cinatra-ai/lint-policy-agent`; the assistant's answer carries the platform's sentence **word for word**; the first run's card is unmoved above it and **there is no second card** — measured `[data-agent-run-slot]` and `[data-inline-run-card]` both list exactly one id, the first run's. No row was written for the refused start (`count(*) = 0` on that template after the fixture was corrected). | **PASS** (deviation D3) |
| `site-widget__refused__may-not-start__dark.png` | the same, in dark | The same two turns and the same single card, in dark | **PASS** (deviations D3, D5) |

### The refusal, quoted

> Run failed: agent-template-scope: create/requesting-actor refused for template 80d761cd-a8eb-4ad0-81e4-288244b79727 — not_project_member (scope: project)

It is the platform's own sentence, relayed with nothing added and nothing
softened, which is what the plan requires of this surface. What it says is
covered by D3.

### Timings, per leg

| leg | sent | tool call settled | card attached | run |
|---|---|---|---|---|
| chat | 14:32:18.218Z | 14:32:42.372Z | 14:32:42.374Z | `ef3d6e38-0c00-4172-a11d-be426ea50441` |
| site widget, the start | 15:10:08.951Z | 15:10:25.009Z | 15:10:29.017Z | `06a703fe-e779-4ba5-852c-73c41c513924` |
| site widget, the refusal | 15:10:37.546Z | 15:10:51.595Z | — (none, and none owed) | none written |

Both pictured runs read back with `run_by` = the signed-in person, `org_id` =
their organization, `human_present` = true.

## Deviations, stated

**D1 — the anchors the recipe names are not the anchors either host publishes.**
The recipe says to wait on `[data-run-card]` / `[data-inline-agent-run-card]`.
Measured on all six captures: **both are 0**. `[data-run-card]` exists in exactly
one component, `packages/chat/src/renderer/ag-ui-interactive.tsx:352`, the
decoupled AG-UI renderer, which neither host mounted in this round.
`[data-inline-agent-run-card]` **exists in no component at all** — it appears
only as a selector literal in `src/lib/lifecycle/held-turn-card-contract.ts:404`,
inside `RUN_CARD_SUBTREES`. What both hosts actually draw is
`[data-agent-run-slot]` (`packages/chat/src/chat-messages-view.tsx:271`) wrapping
`[data-inline-run-card]` (`packages/chat/src/inline-agent-run-card.tsx:345`).
The card is drawn on both hosts; the two anchor names in the recipe, and one of
the three subtrees the held-turn contract accepts, match nothing shipped.

**D2 — the two hosts do not answer alike for the same act.** In chat the turn
answers in prose ("The blog draft writer is paused for human input before it
starts." plus the run id). In the widget the turn's text is the tool result
verbatim — `{"ok": true, "runId": "…", "status": "queued"}`. §I fixes the
assistant's turn as content on the thread ground and a raw payload is content, so
the shape holds; the wording does not.

**D3 — the relayed refusal is an internal diagnostic, not plain words.** Relaying
it unaltered is exactly what the plan and §XI require, and that half is right.
The sentence itself, however, names a template UUID and internal labels
(`create/requesting-actor`, `not_project_member (scope: project)`) to a person
inside a third-party application; §XI asks that the turn carry the refusal "in
plain words".

**D4 — the card sits above the assistant's prose in the chat turn.** §I's own
worked example draws the assistant's prose first and the card beneath it. §I
fixes the slot and the width, not the order, so this is a difference from the
drawn example rather than a broken rule — named rather than passed over.

**D5 — the drawing has one palette.** Rendered at the pinned commit with the dark
colour scheme, `specs/app-lifecycle-cards.html` produces a **byte-identical** PNG
to the light render (equal sha256) for both §I and §IX. The page fixes no dark
tokens, so the dark captures are graded against its structure — the regions, the
two turn shapes, the card in the content slot, the one composer — and not against
colours it does not draw.

**D6 — §IX's matrices do not enumerate the agent-run card.** The presence matrix
covers Review, Verification, Recommendation and Schedule proposal. The run card's
own interior (`Agentic Run Progress`, the status pill, the setup field,
`Continue`) is therefore graded against §I's slot rule and §IX's constancy rule —
same card, only the frame changes — and not against a drawn interior, because
this page draws none for it.

## One reading worth recording

"Bound to a project they hold no grant on" has a trap in it. An **organization**-
owned project hands **every member of that organization** an implicit `read`
grant (`deriveImplicitOwnedRole`, `src/lib/better-auth-db.ts:1465`), and
`holdsProject` tests **presence, not role**
(`packages/agents/src/auth-policy.ts:1636`). With the restricted agent anchored to
an org-owned project, the ordinary member's start was **admitted** and a run row
was written. Re-anchoring the same project to another **user** — nothing else
changed — makes the same start refuse with the sentence quoted above and write
**no row at all**. Both readings happened on this database, in that order. The
gate behaved as its code says; what the round learned is that an org-owned
project fences nothing from that org's own members.

## Layout

- the six PNGs, full window, uncropped, `deviceScaleFactor: 2`
  (chat 1440×900, site widget 1440×1400 — the third-party page mounts the widget
  in a 1180px-tall frame, so the window is sized to hold the site header and the
  whole frame).
- Nothing here carries a credential, a token, a machine name or a machine path.
