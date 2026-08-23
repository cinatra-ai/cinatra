# 2820 scoped dispatch — real-surface capture: NOT POSSIBLE on a credential-free stack

**There is no capture in this directory.** This note records why, so the next reader does
not spend the attempt again. It is a boundary record, never evidence of behaviour.

- Branch: `fix/2820-scoped-dispatch-streams` (closes #2820).
- Reproduction message the capture would have used, the canonical documented form:
  `use @cinatra-ai/contact-discovery-agent to find leads at Acme`
- Surface: `/chat`, default layout, streamed reply plus the inline run card.

## What the capture needed

The pre-router hard short-circuits BEFORE the model layer
(`src/lib/assistant-runtime/runtime.ts`, the `explicitDispatchPackage` branch): it calls
`serverSideExplicitDispatch`, which invokes the real `agent_run` primitive and emits the
synthetic `tool_call` / `tool_result` carrying the `runId`. The inline run card pins its id
from that `agent_run` tool_result and from nothing else, then resolves the run server-side
under the reader's own standing. So the card draws only when a REAL run row exists, which
needs the agent package registered and mounted.

## The blocker, exactly

The app gates boot on its required extension closure
(`packages/extensions/src/dependency-closure.ts` → `requiredClosureOk`;
`src/lib/__tests__/extension-closure-boot-gate.test.ts`). The core declares 24
`systemExtensions` in `package.json#cinatra`, and `cinatra-dev-extensions.lock.json` pins 88
packages. NONE of them exist in this tree:

- `extensions/cinatra-ai/` is empty — extensions ship one repo per extension.
- `node_modules/@cinatra-ai/` holds only workspace packages (agents, llm, skills, …).
- Acquisition is a NETWORK fetch of private-repo tarballs at pinned SHAs
  (`cinatra-required-extensions.lock.json` → `packages/cli/src/prod-extension-acquisition.mjs`),
  or a local verdaccio, which was not running.

So the app cannot boot offline, and `@cinatra-ai/contact-discovery-agent` does not exist
offline in any form. Independently corroborated: a repo-wide `typecheck` on this machine
reports 173 pre-existing `TS2307 Cannot find module '@cinatra-ai/…'` errors, all of them this
same gap. Even past the boot gate, that agent is credentialed, and this lane may use no key.

**No Docker daemon was started for this attempt.** The blocker was established from the tree
alone, so the stack was never brought up.

## What WOULD produce the capture

Seed the extension closure from a reachable registry, then follow the credential-free route
the run-card captures already use: a deterministic no-LLM fixture agent
(`tests/fixtures/review-gate-agent/`, `tests/fixtures/works-after-agent/` — a `<vendor>/<slug>/`
tree with `cinatra/oas.json` and a `.cinatra-published.json` marker), published under an
`@cinatra-ai/<slug>` name so the canonical matcher fires, with run creation seeded the way
`tests/e2e/agents-run/seed.ts` seeds it. Everything downstream of run creation is then the
shipped path, and no key is involved anywhere.

## What IS proven, and where

The client-to-server seam is pinned by unit arms instead, at the same head:

- `packages/chat/src/__tests__/scoped-agent-dispatch-streams.test.ts` — the `SEAM` block ties
  one literal to BOTH matchers: the client plan is `{ kind: "stream" }` and
  `detectExplicitDispatchPackage` returns `@cinatra-ai/contact-discovery-agent`.
- `src/app/api/chat/__tests__/explicit-dispatch.test.ts` — the case-parity block.

The empirical half of the claim — the card rendering in default layout — remains unproven on
this stack, and is stated as unproven rather than inferred.
