# assistant-skills drift decision log

Surface-scoped acknowledgements for the release-closeout skills-drift sweep
(cinatra-ai/cinatra#188). The sweep reconciles every cinatra change in a release
range against the `cinatra-watches` declarations in the release-current
`@cinatra-ai/assistant-skills` pin, and refuses to honor a release-wide blanket
`Skills-reviewed:` / `Skills-unaffected:`.

> **Post-consolidation note (cinatra#2090 S3):** the single assistant-skills
> pack was consolidated into six successor skill repos; the per-PR gate now
> pins the UNION of those repos (`skills_repos` in the caller, one
> `owner/name@sha` entry per successor, each in STRICT LOCKSTEP with that
> repo's `resolvedSha` in `cinatra-required-extensions.lock.json`). Entries
> below this line predate the fold and reference the retired single-pack pin;
> they are historical records, not current mechanics. Each entry below is attributed to the
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

## v0.1.7

Range: v0.1.6 (`5290018`) -> release head (`372d85e4`), 111 commits. Reconciled
against the release-current `@cinatra-ai/assistant-skills` pin `e9d5a7e` — the
lock-resolved assistant-skills ref (assistant-skills main at reconciliation
time): the resolvedSha the required-extension lock refresh (#1086) wrote into
`cinatra-required-extensions.lock.json`, so lock and sweep authority agree. Per cinatra#188 the pin was BUMPED FIRST: the per-PR
gate's `skills_ref` (`.github/workflows/skills-drift-gate.yml`) lagged at
`538a817`, seventeen assistant-skills commits behind the lock; the sweep is
computed at the release-current `e9d5a7e`, and — unlike the two prior
ceremonies, which deferred it — the `skills_ref` re-pin to `e9d5a7e` is
prepared in the same closeout wave on its own branch (a `.github/**` change,
routed as its own PR).

Sweep result (skills-drift-closeout-sweep at the gate-pinned engine): 18
SKILL.md scanned, 14 with declared watches, 26 declared-watch surfaces flagged
across the raw release range, 0 heuristic (advisory). Two resolved directly by
in-range squash-body acks (the agent-run primitive via the #961 squash ack;
the agents MCP handlers path via the #1021 and #917 squash acks); the rest are
resolved by the surface-scoped decisions below. Two per-PR acknowledgements lived ONLY in their PR bodies and
did not survive the squash (#1016, #949) — they are re-proven per-surface here
so the whole-release squash-diff carries them. None of the flagged surfaces
changed a watched primitive's LLM-facing tool CONTRACT (name, documented input
params, success-response shape, refusal text, or discovery semantics), a
watched package, or the HITL/dispatch conventions the public SKILL.md set
encodes.

Route-link staleness scan: the valid-route inventory was rebuilt from
`src/app` (App Router pages + route handlers) at head plus the
`next.config.ts` redirects, and every route-shaped link in the assistant-skills
SKILL.md set AND the org's other skill trees (blog-skills, drupal-skills,
skill-creator-skills, legal-archive-skills, dev-skills-store, claude-plugin)
was checked against it. ONE release-drift stale navigation link found —
exactly the route class this release changed: chat-assistant-core taught
`[Run an agent](/agents/run)`, and the standalone run-agent picker page was
REMOVED by design (cinatra#1007, the /agents split #1016 — no redirect; the
`/agents` "All Agents" tab is the picker now). Fixed in assistant-skills
(branch `closeout/skills-drift-route-fixes`, commit `7a7d8ce`): the link now
points at `/agents`, and the removed route was added to the assistant-skills
`extension-kind-gate` DEAD_APP_ROUTES list so a future reference fails that
repo's CI. Every other route-shaped link resolves at head — verified set:
`/configuration/marketplace` (+ detail `[scope]/[name]`),
`/configuration/agents/approvals` (valid via redirect), `/connectors`,
`/account`, `/skills`, `/dashboards/{id}`, `/artifacts/{id}`, the
`/agents/<vendor>/<slug>/new` quick-run form, `/agents`, `/agents/executions`
— with the sole exception of two pre-existing embed examples, recorded as
KEPT (pre-existing, unchanged since the initial assistant-skills
import, present at BOTH endpoints of this range so not release drift): the
chat-assistant-core "Case 1" embed examples name `/contacts/{contactId}` (no
matching app route at either endpoint — the legacy entity-contacts page
surface predates this range's removal history) and `/accounts/{accountId}`
(structurally resolves to the `/accounts/[path]` administration view). Both
teach the chat embed-widget renderer rather than navigation; correcting them
needs a live chat-UI verification pass and is routed as follow-up work in the
skills repo, not silently rewritten here.

Skills-unaffected: @cinatra-ai/blog-content-workflow — the identifier appears in the release diff only via the regenerated build-time extension registry rows in `src/lib/generated/extensions.server.ts`: #951 added `"accessConfig": null` and #1027 added `"envOverrides": null` to every registry record (additive fields, null for every current extension; the #1027 squash ack records this). The extension package itself — prompts, tools, workflow steps, authoring surface — is unchanged; blog-content references the package name unchanged.
Skills-unaffected: @cinatra-ai/blog-pipeline-agent — same regenerated-registry-row-only surface as above (#951 `accessConfig`, #1027 `envOverrides`, both additive-null); the package and the blog-content pipeline instructions that watch it are unchanged.
Skills-unaffected: @cinatra-ai/blog-wordpress-publish-agent — same regenerated-registry-row-only surface (#951 + #1027, additive-null fields); package unchanged; blog-content unaffected.
Skills-unaffected: @cinatra-ai/code-reviewer-agent — same regenerated-registry-row-only surface (#951 + #1027, additive-null fields); package unchanged; the chat-agent-authoring example-roster reference is unaffected.
Skills-unaffected: @cinatra-ai/drupal-agent — same regenerated-registry-row-only surface (#951 + #1027, additive-null fields); package unchanged; chat-assistant-core unaffected.
Skills-unaffected: @cinatra-ai/email-outreach-agent — regenerated-registry-row-only in the code surface (#951 + #1027, additive-null fields), plus the identifier appears in #853's NEW unit tests as a grouped-setup renderer-id fixture (`...:setup-form`) — test-only; the #853 squash ack records the HITL run-surface consolidation as behavior-preserving (submit payloads, polling/SSE semantics byte-identical, pinned by those tests). The package and chat-campaign-creation's dispatch instructions are unchanged.
Skills-unaffected: @cinatra-ai/lint-policy-agent — same regenerated-registry-row-only surface (#951 + #1027, additive-null fields); package unchanged; chat-agent-authoring unaffected.
Skills-unaffected: @cinatra-ai/planner-agent — same regenerated-registry-row-only surface (#951 + #1027, additive-null fields); package unchanged; chat-agent-authoring unaffected.
Skills-unaffected: @cinatra-ai/security-reviewer-agent — same regenerated-registry-row-only surface (#951 + #1027, additive-null fields); package unchanged; chat-agent-authoring unaffected.
Skills-unaffected: @cinatra-ai/trigger-agent — same regenerated-registry-row-only surface (#951 + #1027, additive-null fields); package unchanged; chat-assistant-core unaffected.
Skills-unaffected: @cinatra-ai/wordpress-agent — same regenerated-registry-row-only surface (#951 + #1027, additive-null fields); package unchanged; chat-assistant-core unaffected.
Skills-unaffected: agent_list — comment-only in the release diff: #1016 (the /agents split) updated prose comments in `packages/agents/src/runtime-install-gate.ts` and test/e2e fixtures to say the run picker moved from the removed standalone page to `/agents`; the agent_list MCP contract (name, params, listing shape, and the runtime-lifecycle discovery-omission semantics for disabled agents) is untouched. Re-proves the #1016 PR-body-only ack at the release diff.
Skills-unaffected: agent_run — resolved in-range by the #961 squash ack (Installed-page UI redesign + archived-discovery read model; no dispatch, polling, schema, or primitive-semantics change); also touched by #908 (orchestrator renderer-gate resolution + stepper display only) and #853 (behavior-preserving HITL consolidation, byte-identical pinned by new unit tests). The documented contract the skills teach — returns `{runId, status}`, polled to a terminal state — is unchanged.
Skills-unaffected: agent_run_get — #931 only: the chat progress-label helpers relocated verbatim (identical `+`/`-` diff lines, verified at the release diff) from the chat-page monolith to `assistant-parts.ts`; no primitive name/param/response change. Re-proves the #931 squash ack per-surface.
Skills-unaffected: agent_run_messages_list — #931 verbatim label-helper relocation only (identical moved lines); primitive contract unchanged.
Skills-unaffected: agent_source_compile — #931 verbatim label-helper relocation only (identical moved lines); primitive contract unchanged.
Skills-unaffected: agent_source_list — #931 verbatim label-helper relocation only (identical moved lines); primitive contract unchanged.
Skills-unaffected: agent_source_publish — #931 verbatim label-helper relocation only (identical moved lines); the publish primitive's name, params, and "refuses to overwrite an existing version / bump packageVersion in both files" behaviour are unchanged.
Skills-unaffected: agent_source_read — #931 verbatim label-helper relocation only (identical moved lines); primitive contract unchanged.
Skills-unaffected: agent_source_validate — #931 verbatim label-helper relocation only (identical moved lines); primitive contract unchanged.
Skills-unaffected: agent_source_write — #931 verbatim label-helper relocation only (identical moved lines); primitive contract unchanged.
Skills-unaffected: agent_source_write_files — #931 verbatim label-helper relocation only (identical moved lines); primitive contract unchanged.
Skills-unaffected: extensions_search — #931 verbatim label-helper relocation only (identical moved lines); the discovery probe's name, params, and result shape the discovery ladder teaches are unchanged.
Skills-unaffected: artifact_authoring_emit — #949 only ENUMERATES the primitive name as a legacy-persistence lint token (the new OAS parity gates warn when an agent OAS prompt instructs prompt-driven persistence; the declarative produces-binding replaces that in AGENT prompts) plus test fixtures naming it; the runtime chat emit primitive's LLM-facing contract and the chat-create-artifact authoring surface are unchanged. Re-proves the #949 PR-body-only ack at the release diff.
Skills-unaffected: packages/agents/src/mcp/handlers.ts — two mechanical changes in the range: #917 renamed the dev-extension path resolver (`resolveAgentInstallDir` -> `resolveDevExtensionSourceRoot`, identical `<cwd>/extensions` semantics for every source-authoring pipeline) and #1021 swapped a locally-duplicated constant for the identical shared artifact-contract import plus a comment update; `validateArtifactPackageOnDisk` behavior is byte-for-byte unchanged. Both squash acks are in-range; recorded here so the file surface carries one authoritative per-surface decision.
Skills-unaffected: packages/agents/src/verdaccio/client.ts — #949 additively carries the manifest `cinatra.produces` declaration through to the generated publish manifest and adds a non-fatal WARN-phase produces-materialization log; no chat-*-extension-authoring surface, publish primitive name/param/refusal, or authoring contract changed. Re-proves the #949 PR-body-only ack at the release diff.
