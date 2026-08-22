# cinatra#2902 — the plan walk

The governing text is the engineering wiki page **PLAN: Agents Lifecycle**.
Every `PLAN>` line below is copied from that page verbatim; every `CELL:` names
the record that answers the line above it, and says where the answer is — or
says plainly that it is not answered yet.

All eight cells are DELIVERED. The four capture cells were shot on a host that
meets the application's memory floor; `README.md` records what the round
measured, what it had to fix in its own drivers, and the two things the pictures
show that this slice does not claim.

---

CELL: W1__run-panel__site_widget__loaded
PLAN> The chat and the widget run the **same conversation code** with a different sign-in: whatever the conversation draws, the widget draws, subject to the widget's own authorization (section 10.2, 10.13).
PLAN> Nothing on this page is chat-only.

**DELIVERED** — `captures/W1__run-panel__site_widget__loaded.png`, record
`W1__run-panel__site_widget__loaded` in `capture-results.json`.

The conversation column INSIDE the embed frame, on a page served by another site,
in LIGHT: the widget's own composer at its foot, the person's turn, the assistant
turn, and the panel drawn under it — `Agentic Run Progress`, `completed`, the
run's own Input and Assistant messages, and `Open the run page`
(`[data-testid="inline-run-page-link"]` counted 1, an element built from
`agentPackageName`, a field nothing but the seed response carries).
`Could not load agent run` counts 0. Beside it the wire entry the picture was
produced by: `cookie: absent`, `widgetUserToken: present (cwu_)`,
`widgetOrigin: present`, `status: 200`.

Whatever the conversation draws, the widget drew: the same column component, the
same panel, under the widget's own authorization.

---

CELL: W3__run-panel__site_widget__loaded__dark
PLAN> The reply says the run started, and a live **run card** appears in the conversation.

**DELIVERED** — `captures/W3__run-panel__site_widget__loaded__dark.png`, record
`W3__run-panel__site_widget__loaded__dark`.

The same claim on the dark theme, with the theme READ BACK inside the embed frame
(the document the picture was taken in) rather than assumed from the browser
context: the record's `measured.theme` carries the frame's own
`documentElement` class list ending in `dark` and `color-scheme: dark`. The run
card is the same card, drawn from the same seed — `status: 200`, cookie absent,
widget token present.

---

CELL: W2__run-panel__site_widget__unbound-run
PLAN> The guard exists so a mis-wired widget mount can never ride an ambient cookie.

**DELIVERED** — `captures/W2__run-panel__site_widget__unbound-run.png`, record
`W2__run-panel__site_widget__unbound-run`.

The negative control, photographed: the same credential, the same conversation,
the same screen — and a run that lives in another organization, owned by another
person, both registered through the shipped routes. The binding refuses it: the
seed for that run answers **404**, the column draws
`Agent run … is not available yet.` and NO panel, and the run-page link count
stays at 1 — the panel from the turn above, still drawn, unmoved.

The refusal is also proven in the route's suite below, before any message or
template is read. This is that refusal happening on the widget's own screen.

One thing this cell needed before it could mean anything, recorded in `README.md`
and asserted by the seeder: the reader must not be a PLATFORM ADMIN. Platform
admin is a rung of the same ladder, so an admin reader is entitled to the other
tenant's run and answers 200 — on the widget branch and on the first-party cookie
branch alike.

---

CELL: W4__run-panel__site_widget__unbound-run__dark
PLAN> The guard exists so a mis-wired widget mount can never ride an ambient cookie.

**DELIVERED** — `captures/W4__run-panel__site_widget__unbound-run__dark.png`,
record `W4__run-panel__site_widget__unbound-run__dark`. The same control on the
dark theme, the theme read back inside the frame, the same 404 in the wire.

---

CELL: guard-suite
PLAN> A host opts in with `LifecycleCardSurfaceProvider` (`packages/agents/src/lifecycle-card-runtime.tsx:167-212`).

**DELIVERED.** `src/lib/__tests__/auth-route-guard-public-paths.test.ts` →
`auth-route-guard - cinatra#2902 inline run panel seed matcher`: four admission
rows (bare UUID, the `run_` form the dispatch paths mint, the `run-` form, and
upper-case hex) proving admission reaches the handler's own check rather than a
307, and four control rows named for the four controls the issue asks for —
`MALFORMED-ID CONTROL`, `DESCENDANT CONTROL`, `SIBLING CONTROL`,
`UNRELATED-PATH CONTROL` — plus a source pin on the matcher's shape and its
rationale. The guard admits reachability only; which host is asking is still the
surface's own opt-in. 88 tests, green.

---

CELL: route-suite
PLAN> broker user token (`cwu_…`) in `X-Cinatra-Widget-User-Token` + `-Origin` + `-Assistant` headers, `credentials: "omit"`

**DELIVERED.**
`src/app/api/agents/runs/[runId]/__tests__/route.widget-branch.test.ts`: the
credential is consumed under this route's own grant; an empty header still
selects the widget branch; a rejected credential 401s and never reads the
session; the run is bound with the widget principal and the TOKEN's org;
forbidden, hidden and absent collapse to one status and one body; and no run
field, message or template survives a failed binding. 12 tests, green, beside the
route's own 6 pre-existing rows.

---

CELL: client-suite
PLAN> No provider means no host, and a card without a host renders **no DOM at all** (`packages/chat/src/renderable-views/lifecycle-card.tsx:107-118`).

**DELIVERED.**
`packages/chat/src/__tests__/inline-agent-run-card-credential.test.tsx`: the
broker call's headers and `credentials: "omit"` are asserted on the recorded
request; the cookie call is pinned as the request it was before this slice — same
URL, same `Accept`, same `cache: "no-store"`, no `credentials` field, no widget
header; and a subtree that declares no host issues no request at all. 5 tests,
green, beside the canonical-link file's 5.

---

CELL: scope
PLAN> The run advances live on its run card. If it needs a piece of input from you (for example an "Idea" field), the field and a **Continue** button appear on the run card in the conversation; you fill it in and continue there.

**DELIVERED as a boundary, not as a picture.** That live half is NOT what this
slice delivers, and nothing here claims it. The guard's matcher terminates at the
seed path and has a descendant control that keeps `/stream` guarded; the grant
declares the seed audience alone. The live transports are named as follow-up, not
promised.

The capture SHOWS that boundary rather than hiding it: after the seed has drawn
the run, the panel's own fallback poll re-reads the same path WITHOUT the widget
header and, on a third-party page with no cookie either, answers 500. It is in
every record's `wire` (cookie absent, widget token absent, 500) and named in
`README.md` as the follow-up it is.

---
