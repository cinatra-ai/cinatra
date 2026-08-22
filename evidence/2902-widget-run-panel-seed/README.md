# cinatra#2902 — the inline run panel's seed, in the embedded widget

## The claim, in one line

Inside the chat widget embedded on a **customer's own site**, the inline run
panel can **load and draw its run** — from a seed the widget's own credential
authorized, with **no cookie on the wire** — and a run that credential does
**not** bind is refused with one uniform answer.

Before this branch every one of those seeds was answered by a 307 to sign-in
before the handler ran, and the panel drew
`Could not load agent run … — please try again.` for ever.

## What this round DELIVERS

The three code layers and their suites — the guard's bounded matcher, the
route's per-call credential branch, and the client's broker transport — each
listed in `PLAN-WALK.md` against the plan line it answers, and each run green.

**And the pixels.** The four real-path cells in the embedded column were shot on
a capture host that meets the application's own memory floor. Every one of them
is a picture of a state the real flow produced, with the seed request recorded
beside it. `capture-results.json` carries the records; `captures/` carries the
images; `logs/capture.txt` carries the run's own narration.

The first round could not take those pictures — the host it was driven on gave
that account a 10 GiB ceiling and this application's development server does not
fit under it beside a browser, against the 16 GiB floor the repository's own
`docs/internals/workflows/constrained-host-builds.md` measures. That was a host
limit, not a branch limit, and this round is the proof: on a host that meets the
floor the drivers ran the round end to end.

## The four cells, as recorded

Framed on the shared conversation column **inside the embed frame** — the element
that carries both the transcript list and the widget's own primary composer — at
viewport width 1228, `deviceScaleFactor: 2`, light and dark. Every image is
1440x2360 device pixels.

| Cell | What it shows | Status |
|---|---|---|
| `W1__run-panel__site_widget__loaded` | the panel drawn in the embedded column, LIGHT: `[data-testid="inline-run-page-link"]` counted 1, `Could not load agent run` counted 0, and the seed recorded as `cookie: absent`, `widgetUserToken: present (cwu_)`, `status: 200` | CAPTURED |
| `W2__run-panel__site_widget__unbound-run` | the negative control, LIGHT: same credential, same conversation, same screen, a run in another organization — the seed answered `404`, the column draws `Agent run … is not available yet.` and NO second panel (the run-page link stays at 1, the panel from the turn above) | CAPTURED |
| `W3__run-panel__site_widget__loaded__dark` | `W1` on the dark theme, the theme read back inside the embed frame (`documentElement` carries `dark`, `color-scheme: dark`) | CAPTURED |
| `W4__run-panel__site_widget__unbound-run__dark` | `W2` on the dark theme | CAPTURED |

## The wire, as recorded

Every request to the seed route and to the embed document is noted with `cookie`
and `x-cinatra-widget-user-token` as PRESENT/ABSENT — never by value — beside the
response status. Read off the committed records:

| Request | Cookie | Widget user token | Widget origin / assistant | Status |
|---|---|---|---|---|
| the bound run's seed | absent | present (`cwu_`) | present / `wordpress` | **200** |
| the unbound run's seed | absent | present (`cwu_`) | present / `wordpress` | **404** |
| the panel's own later poll (see below) | absent | absent | absent | 500 |

The cookie fact is measured, not assumed: after the frame's own hosted-PKCE
sign-in the browser context DOES hold `better-auth.session_token` for the app's
origin, `SameSite=Lax`, `httpOnly` — and it still never rides the embed, because
the top-level page is another SITE. That jar is in every record (`cookieJar`).

## What the pictures ALSO show, said plainly

Two things appear in the images that this slice does not claim, and neither is
edited out.

1. **"This run finished. Its output could not be loaded here — reload the page to
   try again."** The completion card says the run's OUTPUT could not be read.
   These runs are seeded rows with messages and no output evidence, and the
   output read is not part of the seed this slice opens.

2. **The panel's own poll answers 500 in the widget.** After the seed has drawn
   the run, `AgenticRunPanel`'s fallback poll re-reads
   `/api/agents/runs/<runId>` **without** the widget header
   (`packages/agents/src/agentic-run-panel.tsx`, the `no a2a_task_id` fallback).
   On a third-party page there is no cookie either, so that request reaches the
   session branch with no session and returns 500. It is recorded in `wire`
   (cookie absent, widget token absent, 500) rather than hidden. This is the
   live-transport half the slice explicitly does NOT deliver — the seed and the
   render are what the panel drew from — and it is named here as the follow-up
   it is, not photographed as if it worked.

## What the round had to fix in its own drivers, and why it matters

The drivers were committed complete but had never been executed end to end.
Running them found three defects **in the harness** — none in the branch's code —
and each fix is in this directory:

1. **The popup blocker.** The frame's hosted-PKCE sign-in opens a popup, and the
   headless browser must be launched with popups allowed or the window never
   appears. `drivers/capture-run-panel-widget.mjs` now launches with
   `--disable-popup-blocking`.

2. **The seeded message body.** `content_json` IS the shipped message BODY —
   `appendAgentRunMessage` writes `JSON.stringify(body)` and every reader parses
   it straight back into an `AgentRunMessageBody`. The seeder wrote `{ text }`
   alone, so `buildLabelAndContent` fell through its switch, returned
   `undefined`, and the panel died on the destructure ("Cannot destructure
   property 'label'") — a crash the shipped writer cannot produce, because it
   cannot write such a row. `drivers/seed-agent-runs.mjs` now writes
   `{ messageType, role, text }`.

3. **The reader was a platform admin, so the control was vacuous.** The instance
   promotes the first human account to PLATFORM ADMIN on sign-in while exactly
   one human exists (`src/lib/auth.ts`, the initial-admin bootstrap). Platform
   admin is a rung of the ladder the control is supposed to fail on —
   `readAgentRunById` reads owner / co-owner / same-org / platform-admin — so the
   first run of the control answered **200** for another tenant's run, and did so
   on the FIRST-PARTY cookie path too (measured both ways). The control now
   registers a REAL second tenant through the shipped Better-Auth routes, which
   makes the refusal meet a real tenancy AND leaves the bootstrap no longer
   eligible, so the reader stays an ordinary member. `drivers/seed-agent-runs.mjs`
   asserts that role before the pictures are taken and refuses to seed if the
   reader is an admin.

That third one is worth reading twice: with a platform-admin reader the same
pictures would have LOOKED like a passing round and proved the opposite of what
they claim.

## The runtime the round was driven on

Next.js development server (Turbopack) via `scripts/dev-server.mjs`,
`CINATRA_RUNTIME_MODE=development`, `NODE_ENV != production`,
`CINATRA_E2E_SETUP_BYPASS=true`, `CINATRA_TEST_LLM_PROVIDER=scripted`, on a
dedicated lane DATABASE and Redis, loopback only, with the branch's own extension
tree. **No model-provider credential exists on that host**, and none is used.

It is deliberately **not** a production-equivalent build, for the reason
`evidence/2573-s7-conformance/README.md` measured and this round does not
re-derive: `next start` bakes `NODE_ENV=production` into the server bundle, which
the shipped `assertScriptedProviderNotProduction` fence reads, so a production
build and a scripted dispatch are mutually exclusive.

## The origin pair — the thing that makes this round mean anything

| Surface | Origin |
|---|---|
| the Cinatra app | `localhost`, on the lane's dev port |
| the page the widget is embedded in | the loopback IPv4 literal, on another port |

Different origins **and different sites**: `localhost` and the loopback IPv4
literal are not the same registrable domain, so the app's `SameSite=Lax` session
cookie cannot ride the embed. A host page on `localhost:<another port>` would
look identical on screen and prove nothing. Every cell above was taken across
that pair.

## What is real, and what is stood in for

**Real.** The widget: the instance row and its connect-site were written by the
two SHIPPED writers the CMS OAuth exchange itself calls
(`writeConnectorConfigToDatabase`, `upsertConnectSiteAndMintCredential`), and
`deriveFrameBinding` was asserted to close before anything was driven. The frame:
served by the shipped `/embed/assistant` route, framed by a page that holds no
credential and speaks only the embed bridge protocol. The credential: minted by
the frame's own hosted-PKCE ceremony, in a browser context that started with an
empty cookie jar. The second tenant: registered through the shipped Better-Auth
routes, with its own organization and its own person.

**Stood in for — three things, named exactly.**

1. **The model layer.** Which run to show is decided by
   `packages/llm/src/scripted-test-provider.ts` (`scriptedTurnNamesAgentRun`)
   instead of by a live model. The provider **cannot** put a panel on screen: it
   emits the run id the person named and nothing else — no status, no summary —
   and the panel reads the run's real state itself, under the reader's own
   standing. Its deterministic reply is visible in every picture.
2. **The dispatch.** The two run rows were inserted rather than produced by a
   live agent execution, because a run needs a model provider and none exists on
   this host. They are ordinary `completed` runs with ordinary messages, written
   in the shipped body shape, and they carry no invented capability.
3. **The setup gate.** The lane runs with `CINATRA_E2E_SETUP_BYPASS=true`, the
   repository's own explicit flag (the one every suite under
   `tests/e2e/config/*` sets). It makes `evaluateSetupGate` answer `complete` so
   the shell renders; it touches no authentication, no guard, no credential and
   no route on the path this issue is about.

## Why the runs are `completed`

A terminal run starts no poll and opens no stream, so what the pictures show is
the **seed and the render and nothing else** — which is exactly what this slice
claims. The panel's live transports are separately session-only and are named as
follow-up, not photographed here as if they worked; the 500 in the wire table
above is that boundary showing itself.

## Why these cells are NOT in `scripts/ci/chat-hitl-capture-index.json`

That index carries **lifecycle-card** evidence. Its contract
(`scripts/ci/lib/capture-record-contract.mjs`) requires, for the `site_widget`
host, a `[data-lifecycle-card-host="site_widget"]` anchor counted in the frame
the picture was taken in. The inline run panel is not a lifecycle card and emits
no such declaration — and this round no longer argues that, it **measured** it:
the recorder counts that selector in every cell, and every record says **0**.

A record filed there would therefore fail the contract's own
`record/anchor-count-zero` check, and making it pass would mean writing a count
the screen does not produce. The acceptance manifest cites none of these cell
names, so nothing in the gate is left unanswered by their absence. The records
live beside the pixels in `capture-results.json`, in the same record shape.

## Drivers

They are the executable recipe, and they have now been run end to end.

| File | What it does |
|---|---|
| `drivers/lane-setup.mjs` | First admin + org through the shipped Better-Auth routes, then demotes that account back to an ordinary member. |
| `drivers/seed-widget-site.test.ts` | The widget instance + connect-site, through the two shipped writers; asserts `deriveFrameBinding` closes. |
| `drivers/seed-agent-runs.mjs` | The two runs: one this reader's own, one owned by a REAL second tenant registered here; asserts the reader is not a platform admin. |
| `drivers/host-page.html` | The third-party page. It holds no credential and speaks only the embed bridge protocol. |
| `drivers/capture-run-panel-widget.mjs` | The recorder: the sign-in ceremony, the two turns per theme, the pictures, the counts and the wire. |

Order: `lane-setup.mjs` → `seed-widget-site.test.ts` → `seed-agent-runs.mjs` →
`capture-run-panel-widget.mjs`, with the app on its lane port and the host page
served from the loopback IPv4 literal on another port.
