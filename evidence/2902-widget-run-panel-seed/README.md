# cinatra#2902 — the inline run panel's seed, in the embedded widget

## The claim, in one line

Inside the chat widget embedded on a **customer's own site**, the inline run
panel can **load and draw its run** — from a seed the widget's own credential
authorized, with **no cookie on the wire** — and a run that credential does
**not** bind is refused with one uniform answer.

Before this branch every one of those seeds was answered by a 307 to sign-in
before the handler ran, and the panel drew
`Could not load agent run … — please try again.` for ever.

## What this round DELIVERS, and what it does NOT

**Delivered, with real exits:** the three code layers and their suites — the
guard's bounded matcher, the route's per-call credential branch, and the client's
broker transport. Each is listed in `PLAN-WALK.md` against the plan line it
answers, and each was run green.

**NOT delivered: the pixels.** The real-path capture in the embedded column did
**not** complete on the host this round was driven on, and no screenshot is filed
here. The section below says exactly how far the round got, what stopped it, and
what the numbers were. Nothing in this directory is a picture of a state a real
flow did not produce, because there is no picture at all.

This matters for reading the branch: the issue's fourth acceptance criterion —
the capture with the seed request recorded — is **open**. The first three are
answered.

## How far the round got, measured

The lane is real and was driven to the edge of the photograph:

| Step | Outcome |
|---|---|
| Lane database + Redis, migrations, 35 agent templates | ran |
| First admin + organization, through the shipped Better-Auth routes | ran (`drivers/lane-setup.mjs`) |
| Widget instance + connect-site, through the two shipped writers | ran (`drivers/seed-widget-site.test.ts`) |
| `deriveFrameBinding` closes for the seeded instance | **asserted, passed** |
| Two agent runs — one this reader's own, one in another organization | ran (`drivers/seed-agent-runs.mjs`) |
| Host page served on its own origin; embed framed cross-site | ran (`drivers/host-page.html`) |
| Embed bridge handshake `cinatra.embed.ready` → `cinatra.embed.context` | completed |
| Embed frame drew its own sign-in (`[data-embed-signin]`, `data-phase="signin"`) | drew |
| The frame's hosted-PKCE popup | **never opened** — the run stopped here |
| The seed request, the panel, the 200 | **not observed** |

So the widget was provisioned, the frame was live and cross-site, and the flow
reached the sign-in ceremony. It did not get a session, so it never issued a
seed, so there is nothing to photograph and nothing to record.

## Why it stopped, with the numbers

The capture host gives this account a hard memory ceiling, and this application's
development server does not fit under it beside a browser.

| Measurement | Value |
|---|---|
| account memory ceiling (`memory.max`) | 10.0 GiB |
| throttling threshold (`memory.high`) | 9.0 GiB |
| swap allowance (`memory.swap.max`) | 2.0 GiB |
| dev server (Turbopack) resident, after compiling three routes | 8.2 GiB |
| account anonymous total at that point | 8.3 GiB |
| headroom left for a browser | ≈ 0.7 GiB under the threshold |

Three configurations were measured, and none leaves room for the browser:

1. **Turbopack, 3 GiB V8 heap.** The server settles at 8.2 GiB resident having
   compiled only `/api/health`, `/embed/assistant` and `/api/auth/get-session`.
   Starting a headless browser beside it drives the account slice onto its
   throttling threshold; the run makes no further progress. On the second attempt
   it took the whole user session down with it.
2. **Turbopack, 1.5 GiB V8 heap.** The server refuses to settle: Next's own
   `Server is approaching the used memory threshold, restarting…` fires and the
   process recycles. There is no stable server to photograph.
3. **Webpack development mode.** Not a fallback on this repository at all: the
   compile fails outright on a C# source file reached through the
   `verdaccio → pacote → node-gyp` import chain
   (`Find-VisualStudio.cs`, "no loaders are configured to process this file
   type"). The dev server answers 500.

This is consistent with the repository's own measured guidance for constrained
hosts, `docs/internals/workflows/constrained-host-builds.md`, which puts the
floor for this application at **16 GiB available**. The ceiling here is 10 GiB.

The blocker is the host, not the branch. On a host that meets that floor the
drivers below run the round end to end without modification.

## The runtime the round was driven on

Next.js development server (Turbopack) via `scripts/dev-server.mjs`,
`CINATRA_RUNTIME_MODE=development`, `NODE_ENV != production`,
`CINATRA_TEST_LLM_PROVIDER=scripted`, on a dedicated lane database and Redis,
loopback only, with the branch's own extension tree. **No model-provider
credential exists on this host**, and none is used.

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
look identical on screen and prove nothing. This pair was live in the round above
— the frame loaded and handshook across it.

## What is real, and what is stood in for

**Real.** The widget: the instance row and its connect-site were written by the
two SHIPPED writers the CMS OAuth exchange itself calls
(`writeConnectorConfigToDatabase`, `upsertConnectSiteAndMintCredential`), and
`deriveFrameBinding` was asserted to close before anything was driven. The frame:
served by the shipped `/embed/assistant` route, framed by a page that holds no
credential and speaks only the embed bridge protocol.

**Stood in for — three things, named exactly.**

1. **The model layer.** Which run to show is decided by
   `packages/llm/src/scripted-test-provider.ts` (`scriptedTurnNamesAgentRun`)
   instead of by a live model. The provider **cannot** put a panel on screen: it
   emits the run id the person named and nothing else — no status, no summary —
   and the panel reads the run's real state itself, under the reader's own
   standing.
2. **The dispatch.** The two run rows were inserted rather than produced by a
   live agent execution, because a run needs a model provider and none exists on
   this host. They are ordinary `completed` runs with ordinary messages, and they
   carry no invented capability.
3. **The setup gate.** The lane runs with `CINATRA_E2E_SETUP_BYPASS=true`, the
   repository's own explicit flag (the one every suite under
   `tests/e2e/config/*` sets). It makes `evaluateSetupGate` answer `complete` so
   the shell renders; it touches no authentication, no guard, no credential and
   no route on the path this issue is about. Without it the lane's shell sits on
   "Redirecting to setup…" because this host has no LLM provider to commit.

## Why the runs are `completed`

A terminal run starts no poll and opens no stream, so what a picture would show
is the **seed and the render and nothing else** — which is exactly what this
slice claims. The panel's live transports are separately session-only and are
named as follow-up, not photographed here as if they worked.

## Cells the round would deliver

Framed on the shared conversation column **inside the embed frame** — the element
that carries both the transcript list and the widget's own primary composer — at
viewport width 1228, `deviceScaleFactor: 2`, light and dark.

| Cell | What it must show | Status |
|---|---|---|
| `W1__run-panel__site_widget__loaded` | the panel drawn in the embedded column, LIGHT: `[data-testid="inline-run-page-link"]` present, `Could not load agent run` counting 0, and the seed request recorded with `cookie: absent`, `widgetUserToken: present (cwu_)`, `status: 200` | NOT CAPTURED |
| `W2__run-panel__site_widget__unbound-run` | the negative control, LIGHT: same credential, same conversation, same screen, a run in another organization — refused, no run drawn | NOT CAPTURED |
| `W3__run-panel__site_widget__loaded__dark` | `W1` on the dark theme, the theme read back inside the embed frame | NOT CAPTURED |
| `W4__run-panel__site_widget__unbound-run__dark` | `W2` on the dark theme | NOT CAPTURED |

No record for these cells is filed in
`scripts/ci/chat-hitl-capture-index.json`. That index carries **lifecycle-card**
evidence, whose contract requires a `data-lifecycle-card-host` anchor the inline
run panel does not emit — it is not a lifecycle card — and the acceptance
manifest cites none of these cell names, so the contract does not reach them.
Filing a record there would have meant inventing an anchor count the real screen
does not produce.

## The wire, when the round runs

`drivers/capture-run-panel-widget.mjs` records every request to the seed route
and to the embed document, reporting `cookie` and
`x-cinatra-widget-user-token` as present/absent — never by value — together with
the response status. That is the evidentiary payload beside the pixels, because
"the panel drew" and "it drew from a credential-bound read" are two different
claims.

## Drivers

Committed complete, and they are the executable recipe: on a host that meets the
16 GiB floor they run this round end to end with no edit.

| File | What it does |
|---|---|
| `drivers/lane-setup.mjs` | First admin + org through the shipped Better-Auth routes. |
| `drivers/seed-widget-site.test.ts` | The widget instance + connect-site, through the two shipped writers; asserts `deriveFrameBinding` closes. |
| `drivers/seed-agent-runs.mjs` | The two runs: one this reader's own, one in another organization. |
| `drivers/host-page.html` | The third-party page. It holds no credential and speaks only the embed bridge protocol. |
| `drivers/capture-run-panel-widget.mjs` | The recorder. It learned `/api/agents/runs/<runId>` here, beside the embed document it already recorded. |

One note for whoever runs it next: the frame's hosted-PKCE sign-in opens a popup,
and a headless browser must be launched with its popup blocker off for that
window to appear at all.
