# LLM-provider dependency vocabulary for agents

Status: ratified (closes #1062, wave 7 of the cross-extension-kind dependency
semantics epic #1055).

## Problem

An agent selects an LLM provider through the OAS `metadata.cinatra.llm` block
(`{ preferredProvider?, preferredModel?, capabilityRequired? }`, validated by
`packages/agents/src/validate-agent-json.ts` against `OasCinatraLlmSchema` in
`packages/agents/src/llm-provider-policy.ts`). The runtime bridge already
enforces provider availability with an actionable error at dispatch time
(`resolveCinatraLlmDispatch` in `src/app/api/llm-bridge/_llm-dispatch.ts`).

The gap is **upstream** of the runtime: nothing surfaced an agent's provider
requirement to run-enqueue, so a provider that is not installed/configured only
failed deep inside the run (at the `/api/llm-bridge` step), not before it. For
example, `media-transcript-agent` routes to Gemini (`preferredProvider: "gemini"`
+ `capabilityRequired: "media_input"`), but that need was invisible to the run
preflight.

## Decision

**The canonical LLM-provider requirement vocabulary is the existing OAS
`metadata.cinatra.llm` block.** It is the single source of truth for both LLM
routing (runtime) and the run-enqueue availability preflight (this change). An
agent that needs a specific provider declares `preferredProvider`; an agent with
a capability need declares `capabilityRequired` (satisfied by any provider the
capability matrix maps to). `media-transcript-agent` already declares this shape
— no manifest change was required to satisfy the ratified vocabulary.

### Rejected: a `kind: "connector"` dependency edge on the provider connector

The epic offered an alternative — model the requirement as a canonical
`cinatra.dependencies` edge (`kind: "connector"`) on the specific provider
connector package, so it would ride the connector preflight derived from
canonical edges (#1056). **This was rejected for LLM providers** for a concrete
correctness reason:

- All three LLM provider connectors (`gemini-connector`, `openai-connector`,
  `anthropic-connector`) ship `access: { scope: { only: "admin" } }` — they are
  admin-only surfaces, because configuring a provider (its API key) is an
  administrator action.
- The connector preflight built in #1056 gates a run through
  `requireConnectorAuthority(..., mode: "use")`, which is an **access-policy**
  check. For an admin-only connector it denies a **non-admin** actor with
  `admin_only_connector` regardless of mode.
- A required connector edge on a provider connector would therefore block every
  **non-admin** run of a provider-using agent at enqueue — a regression, since
  those runs work today (the bridge dispatches on the org-configured credential
  with no per-run connector-access gate; usability is credential presence, not
  connector-management access).

In other words, an LLM provider connector's admin-only access governs *who may
manage the provider*, not *who may consume the org's configured LLM at runtime*.
Those are different questions, so the connector-access preflight is the wrong
gate for an LLM-provider requirement. Provider **usability** is adapter
availability (`resolveProviderAdapter`), which is exactly what the runtime
dispatch already checks.

A capability-style *manifest* dependency ("any configured LLM provider") was
also considered and deferred: no live agent needs a provider-agnostic LLM edge
today (the only capability in use, `media_input`, maps to a single provider), and
introducing a package-independent capability edge would require the run gate to
resolve capability -> provider-connector in core, re-introducing the
extension-instance coupling the `core-extension-instance-coupling-ban` gate
forbids. The OAS `capabilityRequired` field already expresses capability needs
without any new canonical vocabulary.

## Wiring

A host-side run-enqueue **LLM-provider availability preflight** was added,
mirroring the runtime dispatch so the two cannot drift:

- `src/lib/agent-llm-preflight.ts` — `assertLlmProviderAvailableForRun(llm, probe)`
  **reuses the same pure resolver as `/api/llm-bridge`**
  (`resolveCinatraLlmDispatch`) with the real `resolveProviderAdapter`
  availability probe. It blocks the run **only** on the resolver's 503
  (`capability_unsatisfiable`) outcome — i.e. no installed-and-configured
  provider satisfies the agent's requirement — and throws
  `LlmProviderNotConfiguredError` (code `LLM_PROVIDER_NOT_CONFIGURED`,
  actionable message from `describeCapabilityRequirement`, settings href
  `/configuration/llm`). A soft fallback or a resolved dispatch passes, matching
  runtime: a preferred provider that is down but has a capability-compatible
  alternative, or a bare `preferredProvider` with no capability gate, must not
  hard-fail enqueue.
- `packages/agents/src/read-llm-requirement-from-mount.ts` —
  `readLlmRequirementFromMount(packageName, version)` reads the installed
  agent's source `cinatra/oas.json` from the runtime mount and returns its
  validated `metadata.cinatra.llm`. Absent or unreadable OAS -> `undefined`
  ("no preflight signal", never "provider missing"). Cached by
  `packageName@version`. No schema migration is introduced.
- `src/lib/agent-run-enqueue.ts` — the enqueue chokepoint runs the LLM preflight
  (alongside the #1056 connector preflight) whenever the caller supplies the
  agent package identity, honoring the existing `softPreflight` (dev-preview)
  escape hatch. The package identity is threaded from the same run-start call
  sites that already thread the #1056 connector deps — the two `run-actions.ts`
  start paths and the MCP `agent_run` handler (hard preflight), plus the
  project-dispatch scheduler's dispatch tick (`src/lib/project-dispatch.ts`,
  threading the same deps via `enqueueDepsForTemplate` under `softPreflight`: the
  tick has no live session actor, so a missing provider surfaces as a run failure
  at execution rather than a hard enqueue block) — i.e. exact parity with the
  #1056 connector gate's coverage.
- `packages/agents/src/run-actions.ts` — the run action results surface the
  actionable preflight error (`LlmProviderNotConfiguredError` and the sibling
  `ConnectorNotConfiguredError`) instead of the generic "enqueue failed", so the
  missing/unconfigured provider is visible at the point the user starts a run.

This feeds the same surfaces as the epic intended: the run-enqueue preflight
(#1056's chokepoint) and, via the same OAS vocabulary, the install-time
configuration surfacing tracked in #1057.

## Follow-ups

- If a second provider ever satisfies `media_input` (or any capability an agent
  hard-requires), no agent change is needed — the capability preflight already
  routes across all matrix-compatible providers.
- Credential-presence detail beyond "no provider available" (the five distinct
  connector states) and install-time surfacing are owned by later waves (#1058,
  #1057); this change supplies the vocabulary and the run-enqueue gate they build
  on.
- The run-enqueue preflight (both the #1056 connector gate and this LLM gate)
  fires only on the call sites that thread the template identity into
  `enqueueAgentRun`. The remaining producers that enqueue with a bare `runId`
  (`agents/src/actions.ts` registry run, the A2A wrappers, `trigger-release-job`,
  `agent-tools-registry`, and the agent-builder / dev-child-preview paths) get no
  run-start preflight for connectors OR LLM providers today; making the chokepoint
  self-derive the identity from `runId -> template` would close both gaps at once
  and is a shared follow-up on the #1056 machinery, not specific to this wave.
