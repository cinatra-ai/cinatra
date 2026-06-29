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
