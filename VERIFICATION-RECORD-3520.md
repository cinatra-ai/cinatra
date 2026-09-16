## 2026-09-16 — fix/3520-install-failure-reports-on-the-toast preserved-failing state

This head is a preserved failing state, not a candidate.
Verification boundary: preserved-failing at 961a6f3acb9236252368ba6025b70257750c05a4

Failures (verbatim):
- tests/e2e/design/conformance/testid-contract.json (surface "extension-install-panel") — the stable-id contract still REQUIRES the literal data-testid="extension-install-panel-error" in packages/extensions/src/screens/extension-install-scope-panel.tsx (requires[] entry at line ~196) and still describes 'hidden failure mirror [data-testid="extension-install-panel-error"][role="alert"]' in the surface selector prose (line 175), but the candidate deleted that span. node scripts/design/check-conformance-testids.mjs exits 1 on the candidate: 'covered surface "extension-install-panel" lost its stable id: packages/extensions/src/screens/extension-install-scope-panel.tsx no longer contains data-testid="extension-install-panel-error" — contract attributes are breaking-change-by-design (update testid-contract.json + contract.ts + the harness together)'. The same script exits 0 on origin/main in the throwaway worktree ~/lanes/3520-main-throwaway at c53ef20642cc6b3562a7ce11af8502dde4136ce6 ('conformance testid-contract check OK (81 covered surfaces, 3 allowlist entries, 5 pinned manifests, 3 committed-not-yet-pinned)'). Candidate-owned: the contract JSON (and any contract.ts/harness mirror of that id) must be updated in the same change.

Deferred checks (reason):
- CELL1 — proof round — no boot this leg
- CELL2 — proof round — no boot this leg
- A2A protocol unit tests — CI-only hosted job
- Actions SHA-pin gate — CI-only hosted job
- Agents integration — gated set (+ full-tier report) — CI-only hosted job; needs services this host has not got (no docker)
- Agents-run static invariants (tunnel-wiring) — CI-only hosted job
- Analyze (actions) — CodeQL, CI-only
- Analyze (javascript-typescript) — CodeQL, CI-only
- Analyze (python) — CodeQL, CI-only
- Archive acceptance coverage-completeness gate (#1943) — CI-only hosted job
- Better Auth schema parity — needs a database tier this leg has not raised
- CRM migration gates — CI-only hosted job
- Canonical extension invariants — CI-only hosted job
- Chat-HITL held-turn dev-runtime e2e — browser suite, needs a dev boot
- Core-store schema migration gate — needs a database tier
- Create GitHub Release — CI-only release job
- Decide whether to mirror — CI-only job
- Detect changed paths (crm-migration-gate) — CI-only path filter
- Detect changed paths (doc-code-value-gate) — CI-only path filter
- Detect changed paths (gates-pnpm) — CI-only path filter
- Detect changed paths (knip-report) — CI-only path filter
- Detect changed paths (mcp-route-gate) — CI-only path filter
- Detect changed paths (org-write-boundary-gate) — CI-only path filter
- Detect changed paths (wp-drupal-rename-gate) — CI-only path filter
- Detect skip — docs-only or draft (build-image) — CI-only path filter
- Detect skip — docs-only or draft (e2e-app-suites) — CI-only path filter
- Discover batteries — CI-only job
- Execution-plane unit tests — CI-only hosted job
- Extension-anchor lifecycle DB tests — DB tier — no database raised in this boot-less leg
- Hosted-MCP wire gate — CI-only hosted job
- Mirror GHCR image to Docker Hub — CI-only release job
- Notifications browser e2e — browser suite, needs a dev boot
- Perpetual core invariants (loops, ratchets, unit tiers) — CI-only hosted job
- Perpetual extension suites (discovery gate shard) — CI-only hosted job
- Perpetual system loops invariants — CI-only hosted job
- Presence-degraded build (required-only universe) — CI-only build job
- Publish image (non-release) — CI-only build job (docker)
- Publish image (release) — CI-only release job
- Queue path selection — CI-only job
- RBAC authz unit tests — CI-only hosted job
- RBAC browser e2e — browser suite, needs a dev boot
- Render-smoke browser e2e — browser suite, needs a dev boot
- Skills unit tests — CI-only hosted job
- Trigger prod deploy in ops — CI-only deploy job
- Typecheck and unit tests — CI-only hosted job (the typecheck half ran here with 0 errors)
- Upgrade proof (previous releases to candidate) — CI-only hosted job (docker)
- Workspace package unit suites — CI-only hosted job (the packages/extensions tier of it ran here green)
- actions-pinned-gate / actions-pinned-gate — CI-only gate
- build — CI-only build job
- context-resolve route response shape — CI-only hosted job
- design-pin-freshness — CI-only gate (needs the published design manifest)
- devperf invariants — CI-only hosted job
- doc-code-value-gate / doc-code-value-gate — CI-only gate
- docker-battery — no docker on host3
- environment-promotion-rebuild — CI-only job
- gates — CI-only aggregate job
- gates-pnpm — CI-only aggregate job
- gitignore-gate / gitignore-gate — CI-only gate
- hosted-runner reclaim — at most one guarded re-run — CI-only runner housekeeping
- image — CI-only build job (docker)
- load-battery — CI-only hosted job
- mcp-route-gate — CI-only gate
- meta-commentary-gate / meta-commentary-gate — CI-only gate
- org-write-boundary-gate — CI-only gate
- placement-drain — CI-only job
- rename-gate / rename-gate — CI-only gate
- secret-scan-gate / secret-scan-gate — CI-only gate (no credentials on host3)
- secrets-required-gate / secrets-required-gate — CI-only gate (no credentials on host3)
- service-boundary — CI-only gate
- skills-drift-gate / skills-drift-gate — CI-only gate
- truthful-attribution-gate / truthful-attribution-gate — CI-only gate (reads the pushed commit, which did not exist yet at Verify)
- ui-design-system-gate / ui-design-system-gate — CI-only gate
- weekly reclaim count — appended to the tracking issue — CI-only scheduled job

Suites / gates / typecheck (numbers, from Verify):
- packages/extensions unit tier: PASS — 139 test files, 2723 tests passed, 1 skipped, 51.65s
- red-first: src/components/__tests__/install-panel-toast-only-failure.test.tsx — candidate 5/5 passed; origin/main throwaway (c53ef20642cc6b3562a7ce11af8502dde4136ce6): 1 failed / 4 passed (AssertionError: the failed install redrew the panel's own DOM, sr-only span data-testid="extension-install-panel-error")
- src/components/__tests__/extension-install-panel.test.tsx: PASS — 13 tests
- src/lib/objects/__tests__/objects-surface-drift.test.ts: PASS — 10 tests
- design conformance functional suite (app-extensions family): NOT RUN — no boot this leg
- source-leak-gate: exit 0, clean (7286 files scanned, 193 exempt, 0 gated findings, 257 pre-existing tolerated)
- objects-writer-drift: exit 0, clean
- objects-surface-drift: exit 0, 10 tests passed
- route-graph-ratchet: exit 0, no route exceeds baseline (5 routes tracked)
- core-extension-border: exit 0, 43 crossings inside baseline
- product-tree-hygiene: exit 0, 7549 tracked paths, 0 development artifacts
- ci-pinned-tests-exist: exit 0
- toast-banner-gate: exit 0, 0 matches, OK
- lint (eslint on the five changed files): exit 0, no output
- design-pin-drift: exit 1 — identical on origin/main throwaway (sameAsMain: true, host/main state, not this change's)
- conformance testid contract (scripts/design/check-conformance-testids.mjs): exit 1 on candidate, exit 0 on origin/main throwaway — candidate-owned failure (see Failures above)
- typecheck: 0 errors (pnpm run typecheck / tsc --noEmit), no main comparison needed

Surface conflict noted at Verify: SURFACE-GUARD overlap with active lane 3521-fix1 (issue 3521) on surface app-extensions#I; recorded, not resolved by this leg.
