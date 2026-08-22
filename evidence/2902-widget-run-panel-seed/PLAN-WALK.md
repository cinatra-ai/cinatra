# cinatra#2902 — the plan walk

The governing text is the engineering wiki page **PLAN: Agents Lifecycle**.
Every `PLAN>` line below is copied from that page verbatim; every `CELL:` names
the record that answers the line above it, and says where the answer is — or
says plainly that it is not answered yet.

Four of the eight cells are NOT DELIVERED. The capture round did not complete on
the host it was driven on; `README.md` gives the measurement and the reason. They
are listed here rather than dropped, because a walk that quietly omitted the
lines it cannot answer would read as though it answered them.

---

CELL: W1__run-panel__site_widget__loaded
PLAN> The chat and the widget run the **same conversation code** with a different sign-in: whatever the conversation draws, the widget draws, subject to the widget's own authorization (section 10.2, 10.13).
PLAN> Nothing on this page is chat-only.

**NOT DELIVERED.** This is the picture the round exists to take: the conversation
column INSIDE the embed frame, on a page served by another site, in LIGHT, with
`[data-testid="inline-run-page-link"]` present — an element built from
`agentPackageName`, a field nothing but the seed response carries — and
`Could not load agent run` counting 0, beside a `wire` entry reading
`cookie: absent`, `widgetUserToken: present (cwu_)`, `status: 200`.

The lane reached the frame and stopped at the sign-in ceremony; no seed was ever
issued, so there is no record and no screenshot. What the branch does have for
this line is the code that makes it true and the three suites below. The
measurement that stopped the round, and how far it got, is in `README.md`.

---

CELL: W3__run-panel__site_widget__loaded__dark
PLAN> The reply says the run started, and a live **run card** appears in the conversation.

**NOT DELIVERED.** The same claim on the dark theme, with the theme read back
inside the embed frame (the document the picture would be taken in) rather than
assumed from the browser context's `colorScheme`.

---

CELL: W2__run-panel__site_widget__unbound-run
PLAN> The guard exists so a mis-wired widget mount can never ride an ambient cookie.

**NOT DELIVERED.** The negative control, photographed: the same credential, the
same conversation, the same screen — and a run that lives in another
organization. The binding refuses it and the panel draws no run.

The refusal itself IS proven, in the route's suite below, with the run in another
tenant refused before any message or template is read. What is missing is the
picture of that refusal happening on the widget's own screen.

---

CELL: W4__run-panel__site_widget__unbound-run__dark
PLAN> The guard exists so a mis-wired widget mount can never ride an ambient cookie.

**NOT DELIVERED.** The same control on the dark theme.

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

---
