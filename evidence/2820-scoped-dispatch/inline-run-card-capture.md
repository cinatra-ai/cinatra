# 2820 scoped dispatch: the inline run card, captured on the real surface

**The capture is in this directory**: `inline-run-card.png`. It took three attempts on the real
`/chat` surface, over two days. Each attempt closed the blocker the previous one recorded, and
this file is the single story of all three. Nothing below is inferred. Every claim carries the
log line, the `file:line`, or the pixel that produced it.

- Branch: `fix/2820-scoped-dispatch-streams` (closes #2820).
- Surface: `/chat`, DEFAULT layout, the real composer, a signed-in cookie session.
- Heads: attempts one and two ran at `f4a90d28649cbff4e3a65fc504355dd0606bfec3`; attempt three
  ran at `13c6c00af3987066e613ebae6d517f486a89db5d`. The only code commit between them narrows
  the LEGACY matcher, which the canonical repro message does not touch.

## Attempt one: no model credential, and the adapter gate sits before the pre-router

The attempt signed in, opened `/chat` in default layout, typed the canonical documented form
into the real composer, and sent it:

    Use @cinatra-ai/contact-discovery-agent to find contacts at Acme Corp

The turn ended with a provider error and the explicit-dispatch pre-router never ran. The cause
is an ORDERING fact in the shipped runtime, not a stack defect:

- `src/lib/assistant-runtime/runtime.ts:927` resolves the bound default adapter. `:936` opens the
  no-adapter branch, which emits "No LLM provider configured." and returns at `:942`. Both sit
  BEFORE the pre-router.
- The pre-router is at `src/lib/assistant-runtime/runtime.ts:1367`, downstream of that gate.

So on the cookie-session `/chat` route the turn needs a real model adapter BEFORE it can reach
the branch this PR changes, even though that branch itself calls no model.

The credential-free scripted provider does not cover this message shape. It makes
`hasConfiguredLlmRuntime` answer true (`packages/llm/src/registry.ts:426`), but it stands in for
the model on two paths only: `runtime.ts:759` requires a `widgetPrincipal`, so it does not cover
the cookie-session route; the branch at `runtime.ts:842-848` is the cookie-session path (`:843`
requires NO `widgetPrincipal`) but is gated at `:846-847` on `scriptedTurnAsksForLifecyclePull`
or `scriptedTurnAsksForScheduleProposal`, and a canonical scoped-agent dispatch message is
neither.

Attempt one therefore stopped, and it recorded ONE prediction: with a real model credential the
turn would clear the adapter gate and reach the pre-router. Attempt two tested that prediction.

### Correction carried forward: the earlier note in this directory was wrong about the closure

An earlier note here claimed the app could not boot because the required extension closure was
absent, and that `@cinatra-ai/contact-discovery-agent` "does not exist offline in any form".
That claim described an UNPOPULATED WORKING COPY, not the repository. It is refuted, and the
refutation is kept on the record rather than quietly dropped:

| Claim | Result on a populated copy of this same tree |
| --- | --- |
| `extensions/cinatra-ai/` empty | Seeded from the committed pins, 113 packages, offline |
| closure absent | All 24 `package.json#cinatra.systemExtensions` resolve |
| agent does not exist offline | `@cinatra-ai/contact-discovery-agent@0.1.2` present, with its `cinatra/` directory |
| 173 `TS2307` errors | `tsc --noEmit` exits 0 with 0 errors |
| app cannot boot | App booted and registered 29 agents, including that one |

The closure was populated with NO network fetch and NO credential: `pnpm install` reported
`downloaded 0`, and `pnpm-lock.yaml` was byte-identical before and after.

## Attempt two: with a real credential the pre-router RUNS, and an opt-in install gate holds

A follow-up attempt ran with the operator's sanctioned credential provisioning. The key travels
Keychain to environment to the connector's own save action; it is never in argv, a file, a log,
or this record. Attempt one's prediction held exactly. The turn cleared the adapter gate,
REACHED the pre-router, and `detectExplicitDispatchPackage` matched the canonical package from
the real typed message. The pre-router then reported a non-terminal dispatch failure and fell
through, verbatim:

    [assistant-runtime] explicit-dispatch pre-router HARD attempt failed for @cinatra-ai/contact-discovery-agent: Agent is not installed: @cinatra-ai/contact-discovery-agent — it ships with Cinatra but is opt-in. Install it from the marketplace before running it. — falling through to LLM

That line is quoted byte-for-byte, em dashes included. It is the exact composition of two
template strings in two packages: `src/lib/assistant-runtime/runtime.ts:1406` supplies the outer
sentence, and `packages/agents/src/runtime-install-gate.ts:503` supplies the inner refusal,
reached from the `not-installed` verdict at `:500`.

**What attempt two proves is larger than the line it stopped at.** By this PR's own defect
description, before the fix the client answered the no-responder plan and POSTED NOTHING, so no
assistant request was made and the server pre-router never saw the message at all. The
pre-router running on the canonical typed message is therefore end-to-end evidence that the
CLIENT router change works on the real surface, not only that the server matcher does.

The boundary attempt two hit is the run gate, and it is specific to OPT-IN packages.
`@cinatra-ai/contact-discovery-agent` ships opt-in, has no canonical install row in a lane
database, so the gate refuses before a run is queued
(`packages/agents/src/runtime-install-gate.ts:165`, `:216`, `:500`), and no run means no inline
card. The marketplace install panel that would create the row needs a local registry identity
(`InstanceNamespaceNotConfiguredError` from `loadVerdaccioConfigAsync`), which a lane worktree
does not have and may not provision. Writing the `installed_extension` row by hand was rejected:
a capture enabled by a hand-written row would not be evidence of shipped behaviour.

## Attempt three: a REQUIRED bundled agent needs no install row, and the card renders

The gate attempt two hit is package-scoped, not surface-scoped. `isOptInPackage` is exactly
`record.resolution === "guardedOptional"` (`packages/agents/src/runtime-install-gate.ts:152-153`),
and `isProvisioned` (`:160-166`) refuses `archived` at `:161`, passes `active` at `:162`, refuses
an opt-in record with no canonical row at `:165`, and falls through to `ok: true` at `:166` for
everything else. A required bundled agent is not subject to the opt-in refusal, with or without
an install row. The change under review is package-agnostic, and
`CANONICAL_PKG_RE` (`src/app/api/chat/explicit-dispatch.ts:30`) matches any `@cinatra-ai/<slug>`.

So attempt three used `@cinatra-ai/code-reviewer-agent`, a REQUIRED bundled agent
(`cinatra-required-extensions.lock.json:55`), and the same canonical documented form:

    Use @cinatra-ai/code-reviewer-agent to review this code

**No fixture seeding and no hand-written row were needed.** Ordinary boot installs the bundled
required package by itself:

- Boot log: `[cinatra:extensions:agent] @cinatra-ai/code-reviewer-agent <version> upserted` (the
  version token is elided here for the source-leak gate; the full line is in the lane log), and
  `[static-bundle-lifecycle] anchored 50 bundled serverEntry/required-in-prod package(s) live`
  names it.
- Database after boot: one row, `owner_level=platform`, `status=active`, `is_default=true`.
- `scripts/lib/seed-v64-canonical-demo.mjs` was NOT run. Its own header documents why it does not
  need to be: its platform rows ADOPT the real bundled installs rather than shadow them. Proof
  that it did not run: `select count(*) from cinatra.installed_extension where manifest_hash like
  'seed-v64-%'` returned `0` at the moment of the capture.

The install gate cleared, and the ordering proves it rather than assuming it. In
`packages/agents/src/mcp/handlers.ts` the install assertion is at `:889` and the WayFlow
preflight is at `:1017`. The first send reached `:1017`:

    {"code":"WAYFLOW_NOT_CONFIGURED","error":"WayFlow is not configured for agent '@cinatra-ai/code-reviewer-agent': resolveWayflowUrl: WAYFLOW_BASE_URL is not set. ...","reason":"resolveWayflowUrl: WAYFLOW_BASE_URL is not set"}

Reaching a `:1017` verdict requires `:889` to have returned runnable. The same surface, the same
function and the same turn shape that refused the opt-in agent by name accepted the required one:
a controlled A/B, not an inference. `WAYFLOW_NOT_CONFIGURED` is raised at
`packages/agents/src/wayflow-preflight.ts:95` from the throw at `packages/agents/src/wayflow-url.ts:255`.

Pointing `WAYFLOW_BASE_URL` at a lane-scoped WayFlow runtime on a loopback port (the runtime
reported `{"status":"ok","agents":29,"failed":0}`) closed that gate too, and the same message
then took the HARD short-circuit:

    [chat] explicit-dispatch HARD invokePrimitive returned: {"runId":"523f7069-1c2a-4d2f-857a-8e4fb3a6fe60","status":"queued"}
    [assistant-runtime] explicit-dispatch pre-router HARD short-circuit: @cinatra-ai/code-reviewer-agent → runId=523f7069-1c2a-4d2f-857a-8e4fb3a6fe60

That is `runtime.ts:1387`, inside the success arm that `:1382` opens and `:1389` returns from.
The return is unconditional and sits BEFORE the LLM path, so the card in the capture was produced
with no LLM call in the turn at all.

`inline-run-card.png` is that turn, unretouched. It shows the canonical message in the real
composer's thread, then the inline card: "Creation progress / Queued", "Agentic Run Progress"
carrying `running`, and the "Open the run page" link (`data-testid="inline-run-page-link"`,
the selector the DOM poll matched). The frame is the conversation column of the default layout;
the navigation rail is out of frame because it carries the lane fixture account's identity chip.

**The honest limit of this capture.** It proves the CARD, at `queued` going to `running`,
produced by the shipped short-circuit on the real surface. It does not prove the agent's own
output. The lane's WayFlow runtime carries no model credential, so every queued run failed
downstream of the card; `cinatra.agent_runs` held three rows, all `failed`. That is a property of
the lane, not of the branch: the card renders and the run is queued before any model is called.

## What is proven, and what is not

Proven empirically, on the real surface:

1. The client router change: the message reaches the server at all (attempt two).
2. The server matcher: `detectExplicitDispatchPackage` resolves the canonical package from the
   real typed message (attempts two and three).
3. The HARD short-circuit and the inline run card in default layout, with no LLM turn
   (attempt three, `inline-run-card.png`).

Proven by unit arms at this head:

- `packages/chat/src/__tests__/scoped-agent-dispatch-streams.test.ts`: the `SEAM` block ties one
  literal to BOTH halves. The client plan is `{ kind: "stream" }` and
  `detectExplicitDispatchPackage` returns `@cinatra-ai/contact-discovery-agent`.
- `src/app/api/chat/__tests__/explicit-dispatch.test.ts`: the case-parity block, and the block
  pinning that the case fold stops at the canonical form.

Not proven, and stated as not proven: the agent's own run output, which needs a model credential
inside the WayFlow runtime. Nothing in this PR touches that path.

## Stack the attempts used

Scoped per worktree, torn down unconditionally afterwards.

| | Attempts one and two | Attempt three |
| --- | --- | --- |
| Compose project | `x2912cap`, later `x2912cap3` | `x2912cap5` |
| Postgres / Redis | `127.0.0.1:25436` / `127.0.0.1:26380`, loopback only | same |
| Dev server | port 3199 | same |
| Database | fresh, `scripts/apply-public-schema.mjs` then `scripts/better-auth-migrate.mts` | same, 30 tables |
| `CINATRA_E2E_SETUP_BYPASS` | `true` | `true` |
| Model credential | absent in attempt one; the operator's sanctioned provisioning in attempt two | the operator's sanctioned provisioning |
| WayFlow | not provisioned | lane-scoped runtime on a loopback port, no model credential |

Two operational notes, both learned the expensive way. Warm `/api/mcp` before the first chat
turn: a 2500 ms self-probe races the first-hit dev compile and kills the turn. Do not point
`--public-origin` at localhost if the turn may fall through to the LLM, because the provider's
servers fetch the hosted MCP tool list and cannot reach localhost; it is harmless for a turn that
short-circuits, which is why attempt three was unaffected.

Teardown in every attempt removed the containers, the volumes and the network, deleted
`.env.local`, and left the host's other containers exactly as found.
