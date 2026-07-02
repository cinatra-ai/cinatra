# assistant-skills drift decision log

Surface-scoped acknowledgements for the release-closeout skills-drift sweep
(cinatra-ai/cinatra#188). The sweep reconciles every cinatra change in a release
range against the `cinatra-watches` declarations in the release-current
`@cinatra-ai/assistant-skills` pin, and refuses to honor a release-wide blanket
`Skills-reviewed:` / `Skills-unaffected:`. Each entry below is attributed to the
EXACT watched surface (the changed primitive / package / route / source-path glob)
so the sweep can resolve it per-surface.

Each release has its own `## <version>` section so a stale older-release ack
cannot mask a new finding. Pass `--decision-log-section <version>` to scope the
sweep to one release.

Recognized ack forms (same set as the per-PR gate):
- `Skills-PR: <url-or-#n> covers: <skill-slug>[, ...]` — a linked assistant-skills update PR (in the bumped pin) naming the impacted skill(s).
- `Skills-reviewed: <skill-or-surface> — <note>` — a surface-scoped recorded review (skills checked + updated, or confirmed already correct).
- `Skills-unaffected: <skill-or-surface> — <reason>` — a surface-scoped recorded override (reason REQUIRED).

## v0.1.4

Range: v0.1.3 (`ef7d23d`) -> release head. Reconciled against assistant-skills
release-current pin `e15a7ca` (the per-PR gate pin `538a8176` lagged by 6 commits;
re-pinned to release-current main before sweeping, per cinatra#188).

The v0.1.3->v0.1.4 range touched 10 declared-watch surfaces. None changed a
watched primitive's NAME or documented param shape, a watched package name, a
route a public SKILL.md references, or the HITL/dispatch convention the public
assistant-skills SKILL.md set encodes. The matches come from internal refactors,
security/authz hardening internals, test files, and a private-tracker-ref comment
scrub. Each is recorded below with its exact-surface attribution.

Skills-unaffected: agent_run — security/authz-internal changes only: A2A service-identity actor resolution removed from the MCP run path (sec hardening), SoD self-approval guard (#585), and the operator-vendor `connector_config.agent_run.allowSelfApproval` policy. The primitive name and its documented `agent_run { packageName, inputParams }` shape are unchanged; no public SKILL.md dispatch instruction drifts.
Skills-unaffected: agent_source_compile — no name/param change; the agent-source path-resolution helpers were extracted into `agent-source-paths` (#544 vendor-namespace write path) — internal refactor only, the authoring primitive surface the skills instruct against is unchanged.
Skills-unaffected: agent_source_publish — no name/param change; touched only by the same internal path-resolution refactor (#544) and a one-canonical vendor/name parser unification (#602). The publish primitive surface is unchanged.
Skills-unaffected: agent_source_write — no name/param change; same internal path-resolution refactor (#544) + vendor/name parser unification (#602). Surface unchanged.
Skills-unaffected: agent_source_write_files — no name/param change; identifier appears only in modified tests and the internal path-resolution refactor. Surface unchanged.
Skills-unaffected: artifact_authoring_emit — no name/param change; identifier appears only via test/handler touches in the range. The artifact-authoring emit surface is unchanged.
Skills-unaffected: workflow_draft_create — no name/param change; identifier appears only via test/handler touches. The workflow-draft authoring surface is unchanged. (#609 removed the /workflows BROWSE page only; the workflow engine, approvals, and draft primitives are retained, and no public SKILL.md references the removed browse route.)
Skills-unaffected: @cinatra-ai/email-outreach-agent — the package is unchanged. The only related change is the in-repo trigger SKILL.md (`packages/trigger-email-send/...`) moving `match_when` under `metadata:` for validator compatibility (Wave-2 #546); the public chat-campaign-creation SKILL.md already nests its watches under `metadata:` and references the package name unchanged.
Skills-unaffected: packages/agents/src/mcp/handlers.ts — refactor + security hardening only: extracted path-resolution helpers into `agent-source-paths`, removed the A2A service-identity actor override on the run path (sec hardening). No watched primitive name, documented param shape, or dispatch convention encoded by the public SKILL.md set changed.
Skills-unaffected: packages/agents/src/verdaccio/client.ts — comment-only change in the release range (stripped a private-tracker reference from a docstring on `publishAgentPackageFromGitDir`/declarative-publish). No behavior, signature, or surface change.

## v0.1.5

Range: v0.1.4 (`0700d0c`) -> release head (`46c04ae`). Reconciled against the
release-current `@cinatra-ai/assistant-skills` pin `a7030f0` (current
assistant-skills main, written into `cinatra-required-extensions.lock.json` by
#724). The per-PR gate pin (`.github/workflows/skills-drift-gate.yml`
`skills_ref: 538a8176`) lags the lock by the two intervening assistant-skills
commits + main HEAD; the lag carries NO new `cinatra-watches` declarations, so the
sweep verdict is identical at either pin (17 SKILL.md scanned, 13 with declared
watches, 3 declared-watch findings, 0 unresolved, 0 heuristic). The `skills_ref`
re-pin to `a7030f0` is a config lockstep fix deferred to a post-tag PR (the
v0.1.5 app surface is frozen at `46c04ae`).

The v0.1.4->v0.1.5 range touched 3 declared-watch surfaces, all from the #657/#659
runtime-lifecycle ("installed_extension as the runtime source of truth") work and
its follow-on refactor (#695) and canary harness (#718). None changed a watched
primitive's LLM-facing tool CONTRACT (name, documented input params, success-response
shape, refusal text, or discovery semantics) the public chat-* SKILL.md set teaches:
a disabled/uninstalled agent now returns a structured refusal / is omitted from
discovery, behaviour the existing SKILL.md error-handling guidance already covers.
The route-link staleness scan over the skill set is clean (the app's `/configuration/*`
and `/connectors` routes; no stale `/settings/connections`, `/settings/*`, removed
`/workflows`, or `/agents/registry`); assistant-skills already fixed the
`/settings/connections` -> `/connectors` link in its own commit `e000767` (within
pin `a7030f0`). Each surface is recorded below with its exact-surface attribution.

Skills-unaffected: agent_run — no name/param/behaviour change: the inline runnable-gate was moved into assertAgentPackageRunnable(); the agent_run { packageName, inputParams } primitive surface and its documented refusal ("Agent is not installed (disabled or uninstalled): <id>") are unchanged. The #659 runtime-lifecycle (installed_extension) gate returns a structured refusal for a disabled agent — behaviour the existing SKILL.md error-handling guidance already covers. No public SKILL.md dispatch instruction drifts.
Skills-unaffected: agent_list — no name/param/behaviour change: the inline discovery filter was moved into partitionRunnableAgentPackages(); the agent_list primitive surface, its listing shape, and the de-list semantics (drop runtime-archived; keep null-package + CG-1 no-row) are unchanged. The #659 gate omits a disabled agent from discovery — covered by existing SKILL.md guidance.
Skills-unaffected: packages/agents/src/mcp/handlers.ts — pure internal refactor: the two #659 runtime-lifecycle gate blocks were extracted verbatim into named helpers in runtime-install-gate.ts (#695, behaviour byte-identical), and #718 added a test-only cross-kind hot-install canary harness + fixtures. No watched MCP primitive name, documented param shape, refusal text, or dispatch convention encoded by the public SKILL.md set changed.

## v0.1.6

Range: v0.1.5 (`34a830a`) -> release head (`8bb48ad`). Reconciled against the
release-current `@cinatra-ai/assistant-skills` pin `d00e0f9` (current
assistant-skills main). Per cinatra#188 the pin was BUMPED FIRST: the
`cinatra-required-extensions.lock.json` resolvedSha and the per-PR
`.github/workflows/skills-drift-gate.yml` `skills_ref` both lag at `a7030f0` (the
v0.1.5 pin), six commits behind main. The six intervening assistant-skills commits
GREW the watched surface — most notably the NEW `chat-extension-discovery` skill
(#41/#42) whose `cinatra-watches` declares `extensions_search`,
`artifact_extension_search`, `agent_registry_list`, and
`packages/extensions/src/mcp/handlers.ts` — so the release-current pin, not the
lagged lock, is the authority for what to reconcile against. The lock-side re-pin
of the `@cinatra-ai/assistant-skills` resolvedSha to `d00e0f9` is already in flight
in the required-extension lock-refresh wave (cinatra-ai/cinatra#820); the per-PR
`skills_ref` re-pin (a `.github/**` change) is routed there / to a post-tag PR
(the v0.1.6 app surface is frozen at `8bb48ad`). The sweep verdict is computed at
the release-current `d00e0f9` here regardless of the lagged pins.

Sweep result (skills-drift-closeout-sweep v0.1.0): 18 SKILL.md scanned, 14 with
declared watches, 9 declared-watch surfaces flagged across the release (5 sourced
from the actual v0.1.5->head CODE diff, + 4 self-referential findings that exist only
because this in-range decision-log commit names newly-watched identifiers in prose —
see the note below), 0 heuristic (advisory), all 9 resolved by the surface-scoped
decisions below. None changed a
watched primitive's LLM-facing tool CONTRACT (name, documented input params,
success-response shape, refusal text, or discovery semantics) or a route a public
SKILL.md references. The two mid-release per-PR skills-drift acknowledgements
already recorded as forward corrections — #786/8a7eda9 (`@cinatra-ai/planner-agent`,
doc `skills-drift-correction-786.md`) and #804/340174b (`artifact_authoring_emit`,
doc `cinatra804-skills-drift-correction.md`) — are re-proven per-surface here so the
whole-release squash-diff carries them (per-PR trailers do not survive the squash).

Route-link staleness scan over the skill set is CLEAN: every route-shaped link
resolves to a valid app route at head (`/configuration/marketplace`, `/connectors`,
`/account`, `/agents/run`, `/agents/<vendor>/<slug>/new` — the `[instanceId]=new`
quick-run path, `/dashboards`, `/skills` — the `src/app/skills/[[...slug]]` optional
catch-all + the `/entity/skills/*` -> `/skills/*` redirects in next.config.ts,
`/configuration/agents/approvals` — valid via the next.config.ts redirect to
`/configuration/approvals?tab=agents`; the detail route `/configuration/agents/approvals/[id]`
keeps its path).
No stale `/settings/connections`, `/settings/*`, removed `/workflows` browse, or
`/agents/registry` route links; assistant-skills's own `e000767` (`/settings/connections`
-> `/connectors`) is within pin `d00e0f9`. Each changed surface is recorded below
with its exact-surface attribution.

Skills-unaffected: @cinatra-ai/planner-agent — the package is unchanged; the literal string appears only in TEST FIXTURES of #786/8a7eda9 (boot deploy-refreshable required-extension OAS materialization + WayFlow-OAS decoupling) — a sample ownership-marker payload and filesystem-path strings in `scripts/extensions/__tests__/build-required-oas-seed.test.mjs` and the acquired-agent seed tests. No change to the package or to the `chat-agent-authoring` authoring surface that watches it. Re-proves the #787/f8e2379 correction (`skills-drift-correction-786.md`) at the release diff.
Skills-unaffected: artifact_authoring_emit — no name/param/behaviour change; #804/340174b adds the structured `consumes` MANIFEST field (`cinatra.consumes`, parsed by `@cinatra-ai/sdk-extensions`) plus a declared-vs-used closure validator (`validateDependencyDeclarations`), and merely ENUMERATES `artifact_authoring_emit` as a known consumable primitive in the build-time consumes registry (plus a test fixture declaring it consumed). The runtime `artifact_authoring_emit` primitive's LLM-facing contract (name, `{ extensionPackageName, mime, content, ... }` params, structured `error.reason` set, cycle/depth guards) that `chat-create-artifact` teaches is unchanged. Re-proves the #804 correction (`cinatra804-skills-drift-correction.md`) at the release diff.
Skills-unaffected: agent_source_write — no name/param/behaviour change; the primitive appears in the range only via the #778/bd4778d internal rename (`agentJsonPath` -> `oasSourcePath`) touching the "not found" error string in packages/agents/src/mcp/handlers.ts. The agent-source-of-truth filename moved from `cinatra/agent.json` to `cinatra/oas.json`, and the release-current skills (`d00e0f9`) already teach `cinatra/oas.json` everywhere — `chat-agent-authoring` and `chat-extension-authoring-core` carry NO stale `cinatra/agent.json` path. The `agent_source_write` tool name, params, and write pipeline are unchanged.
Skills-unaffected: packages/agents/src/mcp/handlers.ts — symmetric internal rename only (#778/bd4778d, `agentJsonPath` -> `oasSourcePath`, 75 insertions / 75 deletions across the OAS-source read/write helpers). No watched MCP primitive name, documented param shape, response, refusal text, or dispatch/discovery convention encoded by the public SKILL.md set (chat-artifact-extension-authoring, chat-extension-discovery, chat-skill-extension-authoring, chat-workflow-extension-authoring) changed. The user-facing `cinatra/oas.json` filename this rename tracks is already current in the release-pinned skills.
Skills-unaffected: packages/agents/src/verdaccio/client.ts — internal only in the range: the #778/bd4778d `agentJsonPath` -> `oasSourcePath` rename, and #775/5b2ed7a (publishAgentPackage ships a synthesized `cinatra/oas.json`) — a publish-pipeline internal that materializes the OAS-source file the skills already reference by its current `oas.json` name. No watched primitive name, documented param shape, or publish-surface behaviour the chat-*-extension-authoring skills teach changed (the `agent_source_publish` contract — refuses to overwrite an existing version, bump `packageVersion` in both files — is unchanged).

The four discovery/publish primitives newly WATCHED by the pin-bump skills (the new
`chat-extension-discovery` #41/#42 and the widened chat-extension-authoring-core /
chat-*-extension-authoring watches) had NO net change in the v0.1.5->head cinatra
CODE range (`git log -S <id> -- packages src scripts docker` is empty for each);
they surface as findings only because this decision-log commit — which is itself in
the release range — names them in prose, and they are now watched surfaces. They are
recorded here as surface-unaffected so the release sweep resolves them at the exact
identifier.

Skills-unaffected: extensions_search — no change in the release code range (the public-registry discovery probe in packages/extensions/src/mcp/handlers.ts is untouched by v0.1.5->head; `git log -S extensions_search` over packages/src/scripts/docker is empty). Newly watched by the pin-bump chat-extension-discovery / chat-extension-authoring-core / chat-*-extension-authoring skills; the primitive's name, params, and result shape the discovery ladder teaches are unchanged.
Skills-unaffected: agent_registry_list — no change in the release code range (empty `git log -S`). Newly watched by chat-extension-discovery's discovery ladder; the primitive contract is unchanged.
Skills-unaffected: artifact_extension_search — no change in the release code range (empty `git log -S`). Newly watched by chat-extension-discovery and chat-create-artifact; the artifact-kind discovery read's contract and `{ packageName, label, acceptedMimes, authorableMimes, hasAuthoringSkill, score }` result shape are unchanged.
Skills-unaffected: agent_source_publish — no change in the release code range (empty `git log -S`; only the internal `agentJsonPath`->`oasSourcePath` rename and the synthesized-oas publish-pipeline internal touch its FILE, not its primitive contract). Watched by chat-agent-authoring / chat-extension-authoring-core; the publish primitive's name, params, and "refuses to overwrite an existing version / bump packageVersion in both files" behaviour are unchanged.
