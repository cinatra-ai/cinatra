# 2820 scoped dispatch: the inline run card attempt, and where it stopped

**There is no capture in this directory.** This is a boundary record for ONE attempt, never
evidence of behaviour. It replaces an earlier note in this directory whose stated blocker was
wrong; that correction is recorded below rather than quietly dropped.

- Branch: `fix/2820-scoped-dispatch-streams` (closes #2820).
- Head the attempt ran at: `f4a90d28649cbff4e3a65fc504355dd0606bfec3`.
- Reproduction message, the canonical documented form:
  `Use @cinatra-ai/contact-discovery-agent to find contacts at Acme Corp`
- Surface: `/chat`, default layout, streamed reply plus the inline run card.

## Correction: the earlier blocker in this directory did not hold

The earlier note claimed the app could not boot because the required extension closure was
absent, and that `@cinatra-ai/contact-discovery-agent` "does not exist offline in any form".
That claim described an UNPOPULATED WORKING COPY, not the repository. It is refuted here:

| Claim | Result on a populated copy of this same tree |
| --- | --- |
| `extensions/cinatra-ai/` empty | Seeded from the committed pins, 113 packages, offline |
| closure absent | All 24 `package.json#cinatra.systemExtensions` resolve |
| agent does not exist offline | `@cinatra-ai/contact-discovery-agent@0.1.2` present, with its `cinatra/` directory |
| 173 `TS2307` errors | `tsc --noEmit` exits 0 with 0 errors |
| app cannot boot | App booted and registered 29 agents, including that one |

The closure was populated with NO network fetch and NO credential: `pnpm install` reported
`downloaded 0`, and `pnpm-lock.yaml` was byte-identical before and after.

## The blocker that actually holds, scoped to this attempt

The attempt got as far as the real surface. It signed in, opened `/chat` in default layout,
typed the canonical message into the real composer, and sent it. The turn then ended with a
provider error, and the explicit-dispatch pre-router never ran.

The cause is an ORDERING fact in the shipped runtime, not a stack defect:

- `src/lib/assistant-runtime/runtime.ts:927` resolves the bound default adapter, and
  `:936` returns early when no adapter resolves. Both sit BEFORE the pre-router.
- The pre-router is at `src/lib/assistant-runtime/runtime.ts:1367`, downstream of that gate.

So on the cookie-session `/chat` route the turn needs a real model adapter BEFORE it can
reach the branch this PR changes, even though that branch itself calls no model.

The credential-free scripted provider does not cover this message shape. It makes
`hasConfiguredLlmRuntime` answer true (`packages/llm/src/registry.ts:426`), but it stands in
for the model on two paths only:

- `runtime.ts:759`: it requires a `widgetPrincipal`, so it does not cover the cookie-session route.
- `runtime.ts:844`: the cookie-session path, but gated on
  `scriptedTurnAsksForLifecyclePull` or `scriptedTurnAsksForScheduleProposal`. A canonical
  scoped-agent dispatch message is neither.

Producing this capture therefore needs a real model credential. This lane may use none, so
the attempt stops here rather than reaching for one.

## What WOULD produce the capture

Either of these closes it without weakening the credential rule:

1. Run the turn with any real provider credential configured. Everything the capture needs is
   otherwise present and was verified working in this attempt.
2. Extend the cookie-session scripted branch (`runtime.ts:844`) to recognise a canonical
   scoped-agent dispatch turn, the way it already recognises the lifecycle-pull and
   schedule-proposal shapes. That keeps the capture credential-free and is a change to the
   test seam, not to the shipped dispatch path.

## What IS proven, and where

The client-to-server seam is pinned by unit arms at this head:

- `packages/chat/src/__tests__/scoped-agent-dispatch-streams.test.ts`: the `SEAM` block ties
  one literal to BOTH halves: the client plan is `{ kind: "stream" }` and
  `detectExplicitDispatchPackage` returns `@cinatra-ai/contact-discovery-agent`.
- `src/app/api/chat/__tests__/explicit-dispatch.test.ts`: the case-parity block, and the
  block pinning that the case fold stops at the canonical form.

The empirical half of the claim, the card rendering in default layout, remains unproven. It
is stated as unproven rather than inferred.

## Stack the attempt used

Scoped per worktree, torn down unconditionally afterwards. Compose project `x2912cap`;
Postgres on `127.0.0.1:25436` and Redis on `127.0.0.1:26380`, both loopback-only; dev server
on port 3199; fresh database via `scripts/apply-public-schema.mjs` then
`scripts/better-auth-migrate.mts`; `CINATRA_E2E_SETUP_BYPASS=true`; no model credential
present in the environment at any point. Teardown removed both containers, both volumes and
the network, and left the host's other containers untouched.
