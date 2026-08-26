# cinatra#2935 (lifecycle-b W5d) — the picture leg

Head under proof: `39494751b81e9105b79a84be6759c8f9e49c5104`, plus this evidence
commit.

**This set replaces the one taken at `74e10031c5371059888bc3b451cb69ba7f976e40`**
— the same six file names, re-shot on the head above, after the platform began
minting the assistant's report for a started run (`describeStartedRun`,
`packages/agents/src/run-status.ts`) and the refusal sentence at the refusal's
own source (`packages/agents/src/auth-policy.ts`). Nothing of the earlier set
remains here. Every capture below was viewed before it was recorded.

## The runtime, said first

The branch's own dev server (Next.js, Turbopack), `CINATRA_RUNTIME_MODE=development`,
on the round's own database with the branch's own extension tree (112/112 packages
at their lock SHAs). **A real provider key and a real model**: the organization's
own configured provider and model — `openai` / `gpt-5.5` — with all four turns
below recorded as real streams in `usage_events` (19:51:01.030Z, 19:56:40.315Z,
19:57:06.808Z, 20:01:26.826Z). No credential was placed on the capture machine;
the key lives encrypted in the database this round inherited from the template it
was cloned from.

**The signed-in person is an ordinary member.** `member` in `public.member` for
the one organization, **no** row in `cinatra.role_grant`, **no** row in
`cinatra.project_access`, **no** row in `cinatra.project_co_owners`.

**Two agents, one they may start and one they may not.**

| | package | install scope |
|---|---|---|
| may start | `@cinatra-ai/blog-draft-writer-agent` | `owner_level='organization'`, the person's own org |
| may **not** start | `@cinatra-ai/lint-policy-agent` | `owner_level='project'` onto a project owned by **another user**, on which the person holds no grant |

**The third-party application is genuinely cross-site.** The app answers on
`localhost`; the page the widget is embedded in is served from `127.0.0.1`.
Different origins **and** different registrable domains, so the app's
`SameSite=Lax` session cookie cannot ride the embed frame. The widget instance
and its connect-site were written by the two **shipped** writers the CMS OAuth
exchange itself calls (`writeConnectorConfigToDatabase`,
`upsertConnectSiteAndMintCredential`); `deriveFrameBinding` closes (`ok: true`,
site `423e66c5…`, credential version 1); and the person signed in through the
**hosted flow the frame itself opens** — nothing was injected into the frame's
context. The bridge log beside the frame in every widget capture is the real
`cinatra.embed.ready` → `cinatra.embed.context` handshake, with the frame's own
`cinatra.embed.resize` answers after it.

**The waits are the two the recipe names, never a fixed sleep.** Each leg waits
first for the assistant's tool call to settle (the live-status line gone off the
turn), then for the run card to attach under the anchors the hosts publish —
`[data-agent-run-slot]` wrapping `[data-inline-run-card]` — and records both
timestamps.

**The window.** 1440x900 at device scale 2, whole window, both themes.

## The drawing this is graded against

`specs/app-lifecycle-cards.html` at `fe2182547d4a`, **§I The conversation**,
**§IX Where each card appears** and **§XI The relayed refusal**, rendered headless
at 1440 wide and read as pixels.

**§I** — the thread is the frame; two turn shapes: a person's turn right-aligned
with name and initials above, a filled bubble that hugs its text and the quiet
copy/edit marks beneath; the assistant's turn left-aligned with **no bubble**,
the Cinatra mark and name, then the content on the thread ground filling the
column, where **a card takes that content slot at the column's full width,
exactly where prose would otherwise sit**; and **exactly one primary input per
conversation** — the chat box — with any field a card carries drawn subordinate
to it.

**§IX** — four hosts, one card set, the **same card** wherever it appears; only
the **frame** changes. Its reader matrix ends **"No card at all"** for a reader
who may not read the target, on every host.

**§XI** — a refusal is the platform's own sentence, said back: "never softened,
never re-worded, and never replaced by an act"; and a refused act "settles
nothing: no card moves, no gate resolves, no schedule is armed."

**The plan's own words**, added to every line clause below: the assistant
"reports what came back and adds nothing".

## The six captures

| capture | requires | shows | verdict |
|---|---|---|---|
| `chat__assistant-started-the-agent__light.png` | §I turn shapes, the card in the content slot at full width, one primary input; the line is the platform's report sentence | every §I clause holds; the line is the **model's own prose** | **FAIL** — the line clause (D2-chat); §I composition PASS |
| `chat__assistant-started-the-agent__dark.png` | the same, in the app's dark palette | the same composition and the same prose, re-toned | **FAIL** — the same line clause |
| `site-widget__assistant-started-the-agent__light.png` | §IX same card, frame changed; §I shapes inside the frame; the platform's report sentence | the sentence word for word, then the same card | **PASS** |
| `site-widget__assistant-started-the-agent__dark.png` | the same, in dark | the same, dark | **PASS** |
| `site-widget__refused__may-not-start__light.png` | §XI's sentence exactly, **no card** for the refused start, no second run row | the sentence exactly; one card, the first run's; no row written | **PASS** |
| `site-widget__refused__may-not-start__dark.png` | the same, in dark | the same, dark | **PASS** |

### The chat host

![chat, the assistant started the agent, light](chat__assistant-started-the-agent__light.png)

**Requires** (§I) — the card arrives in a conversation, after what the person
asked; the person's turn right-aligned with name and initials above, a filled
bubble that hugs its text, the quiet copy and edit marks beneath; the assistant's
turn left-aligned with **no bubble**, the Cinatra mark and name; the card in that
content slot at the column's **full width**; **exactly one primary input**. And
the plan's words: the assistant's line **is the platform's report sentence** —
never a JSON literal, never the model's own prose.

**Shows** — the thread bar; `Ops Operator Two` + `OO` over a right-aligned filled
bubble holding `use @cinatra-ai/blog-draft-writer-agent to draft a short post
about retrieval augmented generation` verbatim, copy and pencil beneath;
`Cinatra` mark and name, no bubble; the run card — `Agentic Run Progress`, the
`Awaiting input` pill, `Idea (optional)`, `Continue`, `No messages yet.` —
filling the content slot at the column's full width; one composer at the foot
(`Type a message...`). The assistant's line beneath the card reads, word for word:

> The blog draft run is paused for human input before it starts.
>
> **Run ID:** `abdf8e63-d120-4bf5-ba29-eba2cb5047e4`
>
> Please review the approval/input card in this conversation. Once you respond
> there, I can check the run again and show the draft.

That is the model's own prose. The platform's sentence for this start —
`Dispatched \`@cinatra-ai/blog-draft-writer-agent\` (runId: \`abdf8e63-…\`, status:
\`pending_input\`). The run paused for a decision on the recommended skills.` —
appears nowhere on screen.

**Verdict — FAIL on the line clause; PASS on every §I composition clause**
(deviations D1, D4, D7). Sent 19:50:32.275Z · tool call settled 19:51:04.463Z ·
card attached 19:51:04.466Z · run `abdf8e63-d120-4bf5-ba29-eba2cb5047e4`.

![chat, the assistant started the agent, dark](chat__assistant-started-the-agent__dark.png)

**Requires** — the same regions and shapes in the app's dark palette.
**Shows** — the same composition, dark ground, dark bubble, the card's panel and
pill re-toned; the same prose; nothing added, nothing dropped.
**Verdict — FAIL on the line clause; composition PASS** (D1, D4, D5, D7).

### The third-party application

![site widget, the assistant started the agent, light](site-widget__assistant-started-the-agent__light.png)

**Requires** (§IX) — the **same card** on the site-widget host, only the **frame**
changed; §I's two turn shapes and one primary input inside that frame; the
assistant's line **is the platform's report sentence**.

**Shows** — the third-party page's own header and, beside the frame, the live
bridge log (`cinatra.embed.ready` → `cinatra.embed.context` → two
`cinatra.embed.resize`); inside the panel: `You` + `Me` over a right-aligned
filled bubble with the same sentence, copy and pencil beneath; `Cinatra` mark and
name, no bubble; then the platform's sentence, word for word —

> Dispatched `@cinatra-ai/blog-draft-writer-agent` (runId:
> `80fc7252-31c3-4688-ab82-1709cfa05cbd`, status: `queued`). The run started.

— and **beneath it** the same card: `Agentic Run Progress`, `Awaiting input`,
`Idea (optional)`, `Continue`, `No messages yet.`, at the panel's full width; one
composer at the foot.

**Verdict — PASS** (D1, D5 for the dark twin, D6). Sent 19:56:23.188Z · settled
19:56:41.254Z · card attached 19:56:41.263Z · run
`80fc7252-31c3-4688-ab82-1709cfa05cbd`.

![site widget, the assistant started the agent, dark](site-widget__assistant-started-the-agent__dark.png)

**Requires** — the same, in dark.
**Shows** — the same panel, the same sentence and the same card in dark, inside
the third-party page's own unchanged chrome.
**Verdict — PASS** (D1, D5, D6).

### The refusal

![site widget, the refusal, light](site-widget__refused__may-not-start__light.png)

**Requires** (§XI, §IX) — the refusal is the platform's own sentence, relayed
unchanged and in plain words; **no card may appear** for the refused start (§IX's
reader matrix: *No card at all*); and nothing may settle — no run row written.

**Shows** — the first run's card unmoved above; a second person's turn naming
`@cinatra-ai/lint-policy-agent`; then the assistant's answer, alone on the thread
ground:

> You can't start this agent. Nothing was started.

Exactly the platform's sentence, with no template id, no machine reason and no
scope level in it. **No second card** — measured, both card anchors list exactly
one id, the first run's — and **no row was written** for the refused start
(`agent_runs` for that template: 0 since the round began).

**Verdict — PASS.** Sent 19:56:51.910Z · settled 19:57:07.962Z.

![site widget, the refusal, dark](site-widget__refused__may-not-start__dark.png)

**Requires** — the same, in dark.
**Shows** — the same two turns, the same single card and the same sentence, in dark.
**Verdict — PASS** (D5).

## What these pictures found

**The chat host still does not say the platform's sentence.** It is minted, it is
on the wire, and the widget host says it back word for word — so the mint and the
relay are proven by the widget captures on this same head, in the same minute.
The chat turn's own record shows why: it called `agent_run`, then
`skill_file_read`, then `agent_run_get`, and answered from the poll in words of
its own. `agent_run`'s description carries **both** rules in one text — "`message`
… is your reply: say it back exactly as it is written, add nothing to it" **and**
"MUST be followed by `agent_run_get` polling until a terminal status" — and on a
real model the polling rule wins the last word. The widget's own door carries the
reply rule and no polling rule, and it lands every time.

Reproduced twice, in two fresh threads, with two different paraphrases:

| thread | run | the line the person read |
|---|---|---|
| 19:50:32Z | `abdf8e63-d120-4bf5-ba29-eba2cb5047e4` | "The blog draft run is paused for human input before it starts. … Please review the approval/input card in this conversation." |
| 20:01:02Z | `79152ddd-c06e-4166-a9a2-70cd1d7289fb` | "The blog draft run is paused for approval/input before execution. … Please review the approval card in this conversation." |

Checked before the finding was written: the installed head is
`39494751b81e9105b79a84be6759c8f9e49c5104` (`git rev-parse`); `agent_run` on that
tree returns `message` from `describeStartedRun`; and the same tree's widget door
relays that same mint, which the widget captures show verbatim.

## Deviations

**D1 — the anchors an earlier recipe named are not the anchors either host
publishes**, unchanged on this head and measured 0 on all six captures.
`[data-run-card]` is published in exactly one component,
`packages/chat/src/renderer/ag-ui-interactive.tsx:352` — the decoupled AG-UI
renderer, which neither host mounted here. `[data-inline-agent-run-card]` is
published by **no component at all**: it appears only as a selector literal in
`src/lib/lifecycle/held-turn-card-contract.ts:404`. Both hosts draw the card under
`[data-agent-run-slot]` (`packages/chat/src/chat-messages-view.tsx:271`) wrapping
`[data-inline-run-card]` (`packages/chat/src/inline-agent-run-card.tsx:345`).

**D2 — the two hosts still do not answer alike.** The widget says the platform's
sentence; chat says its own. The half of D2 the earlier set found — a JSON
envelope read out to a person inside a third-party application — is **fixed** and
these captures show it fixed. The other half moved rather than closed: the
wording still differs between the two hosts, and it is chat that deviates now.

**D3 — the relayed refusal is now plain words**, and this is the deviation the
earlier set found being closed: `You can't start this agent. Nothing was started.`
carries no template id, no machine reason and no scope level.

**D4 — in the chat turn the card sits ABOVE the assistant's line**, where §I's own
worked example draws the prose first and the card beneath. The widget host draws
it in §I's order. §I fixes the slot and the width, not the order — named rather
than passed over.

**D5 — the drawing has one palette.** Rendered at the pinned commit with the dark
colour scheme, §I and §IX each produce a **byte-identical** PNG to their light
render (equal sha256, re-measured for this set), so the dark captures are graded
against structure, not against colours the page does not draw.

**D6 — §IX's matrices do not enumerate the agent-run card** (they cover Review,
Verification, Recommendation, Schedule proposal). Its interior is therefore graded
against §I's slot rule and §IX's constancy rule, not against a drawn interior.

**D7 — the run card's own field is not drawn subordinate to the chat box.** §I
takes the weight off a card's field by removing the enclosing box, the raised
ground and the send affordance. The setup gate inside this card keeps an enclosing
box and a filled primary `Continue`, so on both hosts a conversation carrying this
card shows two places that read as somewhere to type. The chat box is still the
one *conversation* input (measured: one composer on every capture); the weighting
rule is what is not applied.

## How to re-take these

Both drivers wait on the tool call's settle and then on the card's attach under
`[data-agent-run-slot]` / `[data-inline-run-card]`; neither uses a fixed sleep for
either. The widget leg drives ONE conversation for both legs — the start, then the
refused start — so the "no second card" reading is made in the same panel that
already carries one.
