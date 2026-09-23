# The test-runner worker cap and its invocation inventory

Issue **cinatra#3355** (unit and gate jobs on the shared self-hosted CI host
reach the test runner with no committed worker cap) · gate
`scripts/audit/vitest-worker-cap.mjs` · tests
`scripts/audit/__tests__/vitest-worker-cap.test.mjs`.

This file is the *documented* half of that issue's criterion 1: every
test-runner invocation under `.github/workflows/**` is listed below with the
job it sits in, the stable step id/name (URI-encoded), its informational line, the job's runner class (URI-encoded), the runner the
invocation actually resolves to, and its disposition. It is documentation of the
CI configuration — nothing else lives here.

## The committed value

```yaml
env:
  VITEST_MAX_WORKERS: "3"
```

One top-level `env:` block in each of the 11 governed
workflow files, so the tree carries exactly 11
workflow-level assignments — one per governed file. There is no single committed
source: the gate is what makes an incomplete or inconsistent edit red instead of
silent. A workflow-level `env:` is *a map of variables that are available to
the steps of all jobs in the workflow*, which is why one block per file replaces
a per-step edit; a **called reusable workflow does not inherit it**, so a
reusable file could never be governed from its caller.

That reach is also the qualification the sentence above needs. "All jobs in the
workflow" includes the jobs this inventory classes `hosted-pinned`, which the
cap is not aimed at and which a workflow-level block cannot be scoped away from.
And the variable **overrides what a vitest config declares**: vitest 4 resolves
`fileParallelism: false` down to one worker and then lets `VITEST_MAX_WORKERS`
overwrite that resolution, so a suite that declares itself serial runs parallel
under any workflow-level value above 1. The committed value is therefore a
**MAXIMUM**, not a fixed setting: a job-level or step-level assignment between 1
and it NARROWS the cap at the narrowest scope that owns the reason and keeps the
contract, while one above it breaks the contract and reds the gate. That rule is
not a fifth exception class — it is this same contract read as a maximum.

The gate reads a narrowing assignment in a job's own `env:` mapping or in a
step's, written as a block or a flow mapping. An assignment anywhere else — a
service container's `env:`, say, which sets the service's environment and not
the test step's — is REFUSED rather than ignored, so no override can reach a
step without the maximum rule having read it. Text inside a block scalar sets
nothing and is masked before the walk.

`3` is the INTERIM worker count cinatra#3355 records, now
given a committed home in the tree. It is **not** a measured optimum: that
issue's criterion 3 compares three-, four- and six-runner configurations and
keeps the runner count and the worker count open until the comparison is
recorded. Nothing here claims what the runner services on the box carry today.
Changing the value later means the 11 workflow edits, the
gate's `EXPECTED_VALUE` constant, this document and any value-specific
expectation in the gate's test.

## What the gate governs

An invocation is **governed** when it RESOLVES TO VITEST — either `vitest`
stands in command position, or the package script the command names resolves to
`vitest` in exactly ONE level (`pnpm test` in `packages/agents`,
`pnpm --filter @cinatra-ai/execution-plane run test:e2e`). A workflow file is
governed when at least one of its invocations is. The governed set is DERIVED by
the resolved runner, never by a filename allowlist, and a test-shaped script that
cannot be resolved in one level fails the gate CLOSED.

Three consequences of "resolved runner" the gate spells out, because each is a
way a narrower reading would let an uncapped vitest run pass: a script is read
by its BODY, not by its name (`pnpm verify` running `vitest run` is governed);
`vitest` without the `run` subcommand is still vitest; and a script body whose
FIRST command is another runner is still governed when a later command is
vitest. A step that moves the working directory and whose command the cwd walk
cannot place also fails CLOSED rather than being resolved against the root
manifest.

The gate requires **exactly one** workflow-level `VITEST_MAX_WORKERS`
assignment per governed file, at the expected value, and the same value across
all of them. It is a value contract, not a presence check.

## The four exception classes

| class | reason it is one | where |
|-------|------------------|-------|
| `extension-suite-gate` | the gate caps its own children at `VITEST_MAX_WORKERS: "1"`, spelled for BOTH vitest majors on the tree (vitest 4 reads `VITEST_MAX_WORKERS`; vitest 2, which nine acquired artifact packages pin, reads `VITEST_{MIN,MAX}_{THREADS,FORKS}`) — it is the one road that reaches a vitest-2 suite, and it is left exactly as it is | `scripts/ci/extension-suite-gate.mjs` |
| `hosted-pinned` | a hard-pinned `runs-on: ubuntu-latest` job can never reach the shared self-hosted box — a LITERAL, single hosted label only, so a label set that also names `self-hosted` is not this class | `build-image.yml` job `chat-hitl-held-turn-e2e`, `trusted-read-scale-smoke.yml` job `scale-smoke` |
| `node:test` | node's own test runner, not vitest; no worker cap applies | `wp-mcp-gateway-capture.yml` (the one file with nothing else), `works-after-proof.yml`, and the `node --test` steps inside `build-image.yml`, `gates.yml` and `crm-migration-gate.yml` |
| `playwright` | `playwright test`, not vitest; `VITEST_MAX_WORKERS` does not reach it | `dashboard-live-verify.yml`, `dev-hmr-smoke.yml`, `e2e-app-suites.yml`, and `build-image.yml`'s two e2e steps |

A **fifth** class — an invocation whose resolved runner is none of vitest,
node:test or playwright — fails the gate rather than passing as ungoverned.

Two of those classes sit INSIDE governed files, and the workflow-level block
reaches them too: `build-image.yml`'s hard-pinned `chat-hitl-held-turn-e2e`
job and the `node --test` steps of `build-image.yml`, `gates.yml` and
`crm-migration-gate.yml`. One committed value beats two, so that is accepted;
the cap's effect on that hosted job is unmeasured here.

## The inventory

18 workflow files carry a test-runner step;
11 of them are governed. 137 invocations:
95 governed, 13 hosted-pinned,
20 node:test, 8 playwright,
1 extension-suite-gate.

The gate holds this table to its FULL derived entry set, so an added or removed
job or step inside an already-listed workflow reds it. The stable identity is the step id, or name when no id is declared; anonymous
steps use their command. Duplicate identities within a job are refused. The
step line is informational and excluded from comparison, so inserting unrelated
setup steps does not stale the table. Several invocations in one `run:` block
share the same step identity. The
**effective cap** is the value that actually reaches that step — the
workflow-level one unless a job-level or step-level assignment narrows it, and
`none` when no assignment reaches the step at all.

| workflow | job | Stable step | step line | runner class | runner | disposition | effective cap |
|----------|-----|-------------|-----------|--------------|--------|-------------|---------------|
| agents-integration-diagnostic.yml | full-tier | name%3AAgents%20integration%20tests%20%E2%80%94%20WHOLE%20tier%20incl.%20known-red%20files%20(informational%3B%20never%20blocking) | 203 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | actions-pin-gate | name%3AParser%20and%20impact-selection%20tests | 171 | CI_RUNNER_GATE | node:test | node:test | 3 |
| build-image.yml | test | name%3AUnit%20tests%20(packages%2Fagents) | 249 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | skills-unit | name%3ASkills%20unit%20tests%20(full%20packages%2Fskills%20suite) | 288 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | a2a-unit | name%3AA2A%20unit%20tests%20(full%20packages%2Fa2a%20suite) | 331 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | execution-plane-unit | name%3AExecution-plane%20unit%20tests%20(full%20packages%2Fexecution-plane%20suite) | 394 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | rbac-authz-unit | name%3ARBAC%20authz%20unit%20tests%20(incl.%20resolver%20matrix) | 470 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | context-resolve-route-shape | name%3A%2Fapi%2Fcontext-resolve%20response-shape%20regression | 505 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | auth-schema-drift | name%3ASchema%20parity%20test%20(runtime%20%E2%86%94%20migration) | 553 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | auth-schema-drift | name%3AMCP%20auth-plugins%20pure%20builder%20test | 556 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | schema-migration-gate | name%3AGate%20classifier%20tests%20(labelled%20fixture%20corpus%20%2B%20unit%20edges) | 655 | CI_RUNNER_GATE | node:test | node:test | 3 |
| build-image.yml | extension-lifecycle-db-tests | name%3ALifecycle%20DB%20tests%20(demotion%20migration%20%2B%20fresh-prod%20seeding) | 714 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | name%3ASkill-injection%20drop-ledger%20DB%20test%20(cinatra%232091) | 724 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | name%3ABatch-compensation%20scope%20DB%20test%20(cinatra%232415) | 738 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | name%3ABlog-pipeline%20install-record%20heal%20DB%20test%20(cinatra%232536) | 755 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | name%3ADev-boot%20declared-tables%20activation%20DB%20test%20(cinatra%233462) | 772 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | name%3AUpload-on-install%20outbox%20%2B%20consent%20projection%20DB%20test%20(cinatra%232092) | 786 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | name%3ADashboards%20actor%20team-roles%20regression%20(cinatra%231988) | 798 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | name%3AArchive-race%20adversarial%20acceptance%20integration%20tests%20(cinatra%231943) | 821 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | name%3AExecution%20run-seam%20declared-environment%20integration%20tests%20(cinatra%231705%20AC9) | 852 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | name%3AMemory%20promotion%20atomic-apply%20DB%20test%20(cinatra%231381) | 871 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | name%3AArtifact%20promotion%20approvals%20DB%20test%20(cinatra%231437) | 876 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | name%3AAsync%20notification-delete%20seam%20%E2%80%94%20real-DB%20tier%20(cinatra%232882) | 906 | CI_RUNNER_E2E | vitest | governed | 1 |
| build-image.yml | agents-integration-db | name%3AAgents%20integration%20tests%20%E2%80%94%20gated%20set%20(packages%2Fagents) | 1204 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | agents-integration-db | name%3AAG-UI%20durable-resume%20%E2%80%94%20real-Redis%20tier%20(cinatra%233067) | 1255 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | v64-invariants | name%3AExtension%20invariants%20(packages%2Fextensions%20%E2%80%94%20whole%20suite) | 1488 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Allm%20unit%20suite%20(56%20files%20%2F%20656%20tests%2C%201.4s) | 1581 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Aobjects%20unit%20suite%20(59%20files%20%2F%20692%20tests%2C%201.5s) | 1584 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Achat%20unit%20suite%20(40%20files%20%2F%20412%20tests%2C%203.0s) | 1587 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Aagent-ui-protocol%20unit%20suite%20(13%20files%20%2F%20153%20tests%2C%200.7s) | 1590 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Aregistries%20unit%20suite%20(16%20files%20%2F%20142%20tests%2C%201.4s) | 1593 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Ametric-cost-api%20unit%20suite%20(7%20files%20%2F%2030%20tests%2C%200.7s) | 1596 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Amemory%20unit%20suite%20(7%20files%20%2F%2061%20tests%2C%201.9s) | 1599 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Amarketplace-mcp-client%20unit%20suite%20(5%20files%20%2F%2079%20tests%2C%200.6s) | 1602 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Awebhooks%20unit%20suite%20(4%20files%20%2F%20138%20tests%2C%200.6s) | 1605 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Astreams%20unit%20suite%20(4%20files%20%2F%2049%20tests%2C%201.0s) | 1608 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Aextension-types%20unit%20suite%20(2%20files%20%2F%2019%20tests%2C%200.6s) | 1611 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Aartifacts%20unit%20suite%20(1%20file%20%2F%203%20tests%2C%200.5s) | 1614 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Aconnectors-catalog%20unit%20suite%20(1%20file%20%2F%206%20tests%2C%200.5s) | 1617 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Amarketplace-application-reconcile%20unit%20suite%20(1%20file%20%2F%208%20tests%2C%200.6s) | 1620 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Amarketplace-sync%20unit%20suite%20(1%20file%20%2F%2020%20tests%2C%200.5s) | 1623 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Ametric-contracts%20unit%20suite%20(1%20file%20%2F%204%20tests%2C%200.5s) | 1626 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Apm-schedule-reconcile%20unit%20suite%20(1%20file%20%2F%2012%20tests%2C%200.6s) | 1629 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | name%3Aprojects%20unit%20suite%20(1%20file%20%2F%2024%20tests%2C%200.8s) | 1632 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | hosted-mcp-wire-gate | name%3AHosted-MCP%20wire%20gate%20(chat%20%2B%20both%20widget%20kinds%2C%20all%20providers) | 1693 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | hosted-mcp-wire-gate | name%3AAssistant-runtime%20suite%20(the%20gate's%20runtime-side%20companions) | 1699 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | devperf-invariants | name%3Adevperf%20invariants%20(scripts%2F__tests__%2F) | 1733 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | devperf-invariants | name%3ADocker%20host-port%20drift%20guard%20(scripts%2Flib%2F) | 1736 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | name%3APerpetual%20system%20loops%20gate%20tests | 1867 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AExtension%20license-field%20gate%20tests | 1879 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AWP%20MCP%20gateway%20fixture%20pin-integrity%20gate%20tests | 1896 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | name%3AWP%20MCP%20gateway%20capture-freshness%20gate%20tests | 1912 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | name%3AProduced-artifact%20dependency%20gate%20tests | 1941 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | name%3AExtension%20import-ban%20gate%20tests | 1966 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AVitest%20worker-cap%20gate%20tests | 1977 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AExtension%20node%3Afs%20import-ban%20gate%20tests | 1994 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AHost-peer%20value-import%20ban%20gate%20tests | 2011 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3ACore%20-%3E%20extension%20import-ban%20gate%20tests | 2028 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AArtifact-UI%20type-identity%20boundary%20gate%20tests | 2044 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AArtifact-review%20floor%20gate%20tests | 2066 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | name%3AVariable-URL%20dynamic-import%20ratchet%20tests | 2079 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AEXDEV-safe%20rename%20gate%20tests | 2098 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3ADiscovery-dispatcher%20bypass%20gate%20tests | 2116 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3ACore%20-%3E%20extension%20instance-coupling%20gate%20tests | 2137 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AVendor-token%20core%20gate%20tests | 2157 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AIdentity-surface%20coupling%20gate%20tests | 2172 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3ASelf-rendering%20extensions%20border%20gate%20tests | 2198 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3ARequired-extensions%20cover%20host%20imports%20gate%20tests | 2223 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3ASkill-store%20canonicality%20gate%20tests | 2240 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3ARoute-graph%20ratchet%20gate%20tests | 2263 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | name%3ASkill%20frontmatter%20%2B%20mirror-ban%20gate%20tests | 2279 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | name%3AExtension%20dev-fixtures%20gate%20tests | 2288 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AConnector%20access-config%20gate%20tests | 2300 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AVerdaccio%20publish-execution%20ban%20gate%20tests | 2319 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AWorkspace%20phantom-dependency%20gate%20tests | 2336 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | name%3AWorkspace%20dependency-cycle%20gate%20tests | 2354 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | name%3AFile-size%20ratchet%20gate%20tests | 2374 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | name%3AExecution-plane%20compose%20scoping%20gate%20tests | 2392 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | name%3APinned-test%20existence%20gate%20tests | 2414 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3ASDK%20ABI%20%2B%20CLI%20%2B%20inventory%2Fmanifest%20unit%20tests | 2441 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3ARoot%20Vitest%20suite%20(wholesale%20%E2%80%94%20gate%20of%20record) | 2481 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3ARuntime%20installer%20unit%20tests | 2489 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3ARuntime%20installer%20package-scoped%20unit%20tests | 2546 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3ASeed-pack%20manifest%20parity%20tier%20(packages%2Fobjects) | 2594 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AAnthropic%20connector%20tests | 2660 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AGemini%20connector%20tests | 2663 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AObject-history%20writer%20drift%20gate%20tests | 2778 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3ARetention%20policy%20gate%20tests | 2790 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AMutationResult%20rollout%20gate%20tests | 2800 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AObject-history%20unit%20tests | 2807 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AData-safety%20UI%20unit%20tests | 2816 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | name%3AAuthz%20inventory%20drift%20gate | 2821 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-extension-suites | name%3AExtension%20suites%20%E2%80%94%20discovery%20gate%20(every%20materialized%20suite) | 2926 | CI_RUNNER_HEAVY | vitest | extension-suite-gate | 3 |
| build-image.yml | e2e-rbac | id%3Ae2e | 3231 | CI_RUNNER_E2E | playwright | playwright | 3 |
| build-image.yml | chat-hitl-held-turn-e2e | id%3Ae2e | 3557 | ubuntu-latest | playwright | playwright | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | name%3ALifecycle-moment%20triple%20%E2%80%94%20real-DB%20tier%20(cinatra%232928%2C%20W2a) | 3706 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | name%3ALent-action%20grant%20ledger%20%E2%80%94%20real-DB%20tier%20(cinatra%232932%2C%20W5a) | 3711 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | name%3ANamed-agent%20start%20%E2%80%94%20real-DB%20tier%20(cinatra%232935%2C%20W5d) | 3716 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | name%3ARun-window%20conversation%20%E2%80%94%20real-DB%20tier%20(cinatra%232933%2C%20W5b) | 3721 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | name%3ANon-file%20revision%20reader%20%E2%80%94%20real-DB%20tier%20(cinatra%233027%2C%20lifecycle-c%20W3) | 3733 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | name%3AThe%20review%20floor%20%E2%80%94%20real-store%20tier%20(cinatra%233080%2C%20epic%20%233023) | 3748 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | name%3AThe%20editor's%20save%20with%20an%20expected%20base%20%E2%80%94%20real-DB%20tier%20(cinatra%233026%2C%20lifecycle-c%20W2) | 3760 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | name%3AExtension%20tables%2C%20data%20tool%20and%20artifact%20reads%20%E2%80%94%20real-DB%20tier%20(cinatra%233031%2C%20W7) | 3774 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | name%3AObject-backed%20contract%20%2B%20typed%20promotion%20%E2%80%94%20real-DB%20tier%20(cinatra%233028%2C%20lifecycle-c%20W4) | 3789 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | name%3ARun%20folder%20pickup%20%2B%20file%20bindings%20%2B%20mid-run%20revision%20%E2%80%94%20real-DB%20tier%20(cinatra%233030%2C%20lifecycle-c%20W6) | 3807 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | name%3AThe%20image%20tool%20%E2%80%94%20real-DB%20tier%20(cinatra%233032%2C%20lifecycle-c%20W8) | 3823 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | name%3AWidget%20schedule%20grant%20%E2%80%94%20real-DB%20tier%20(cinatra%233052) | 3837 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | presence-degraded-build | name%3ADegradation%20suites%20(guard%20%2B%20consumers%20%2B%20generated%20classification%20%2B%20readiness%20fail-soft) | 4756 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| crm-migration-gate.yml | gate | name%3AOAS%20banned-primitives%20gate%20tests | 152 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| crm-migration-gate.yml | gate | name%3ACRM%20pointer-row%20gate%20tests | 155 | CI_RUNNER_HEAVY | node:test | node:test | 3 |
| dashboard-live-verify.yml | smoke | id%3Ae2e | 440 | CI_RUNNER_E2E | playwright | playwright | none |
| dev-hmr-smoke.yml | hmr-smoke | name%3ARun%20warm%20dev-session%20HMR%20smoke%20(Playwright) | 192 | CI_RUNNER_E2E | playwright | playwright | none |
| e2e-app-suites.yml | render-smoke-e2e | id%3Ae2e | 318 | CI_RUNNER_E2E | playwright | playwright | none |
| e2e-app-suites.yml | notifications-e2e | id%3Ae2e | 541 | CI_RUNNER_E2E | playwright | playwright | none |
| e2e-app-suites.yml | agents-run-invariants | name%3ARun%20agents-run%20tunnel-wiring%20invariant | 610 | CI_RUNNER_E2E | playwright | playwright | none |
| execution-plane-e2e.yml | batteries | name%3ARun%20battery%20%E2%80%94%20%24%7B%7B%20matrix.name%20%7D%7D%20(%24%7B%7B%20matrix.file%20%7D%7D) | 301 | CI_RUNNER_E2E | vitest | governed | 3 |
| extension-readme-gate.yml | tests | name%3ARun%20parser%20tests | 159 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| gates.yml | gates | name%3AWorkspace%20Integrity%20Gate | 104 | CI_RUNNER_GATE | node:test | node:test | 3 |
| gates.yml | gates | name%3AGatekept%20Install%20No%20Direct%20Registry | 200 | CI_RUNNER_GATE | node:test | node:test | 3 |
| gates.yml | gates | name%3ASDK%20ABI%20Doc%20Gate%20%E2%80%94%20extractor%20tests | 272 | CI_RUNNER_GATE | node:test | node:test | 3 |
| gates.yml | gates-pnpm | name%3Adashboards-suite-gate%20%E2%80%94%20dashboards%20default%20suite | 309 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| gates.yml | gates-pnpm | name%3Adashboards-suite-gate%20%E2%80%94%20sdk-dashboard%20default%20suite | 312 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| gates.yml | gates-pnpm | name%3AToolbar%20design-system%20gate%20%E2%80%94%20parser%20tests | 315 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| gates.yml | gates-pnpm | name%3AVendor-byline%20%E2%80%94%20%C2%A7I%20%2F%20%C2%A7II%20byline%20tests%20(packages%2Fextensions) | 318 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| gates.yml | gates-pnpm | name%3AVendor-byline%20%E2%80%94%20resolver%20%2B%20%C2%A7III%2F%C2%A7IV%20byline%20%2B%20parser%20tests%20(root) | 325 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| hosted-build-size-trial.yml | dashboard | id%3Ae2e | 802 | %24%7B%7B%2C%20inputs.cohort%2C%20%3D%3D%2C%20large%2C%20%26%26%2C%20fromJSON(%7Bgroup%3Aci-build-trial-3316%2C%20labels%3Aci-build-trial-3316-8core%7D)%2C%20%7C%7C%2C%20ubuntu-24.04%2C%20%7D%7D | playwright | playwright | none |
| mcp-route-gate.yml | mcp-route-gate | name%3AMCP%20advertised-URL%20route%20shape%20test | 126 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| org-write-boundary-gate.yml | org-write-boundary-gate | name%3AKernel%20test%20suite | 122 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| org-write-boundary-gate.yml | org-write-boundary-gate | name%3AOrg-write%20resolver%2C%20registry%20and%20gate%20self-tests | 124 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| skill-match-eval.yml | live-eval | name%3ARun%20live%20golden-set%20calibration | 119 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| skill-packaging-gate.yml | tests | name%3ARun%20verdict%20%2B%20agreement-pin%20tests | 122 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| trusted-read-scale-smoke.yml | scale-smoke | name%3ARun%20the%20bounded%20hosted%20live%20proof%20series | 196 | ubuntu-latest | vitest | hosted-pinned | none |
| validate-agents.yml | validate-runtime-invariants | name%3ARun%20hermetic%20runtime-invariants%20vitest | 196 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| validate-agents.yml | validate-runtime-invariants | name%3APin-advance%20host-tool%20check%20unit%20tests | 201 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| works-after-proof.yml | proof | name%3AUnit%20tests%20(works-after%20static%20invariants) | 320 | CI_RUNNER_E2E | node:test | node:test | none |
| wp-mcp-gateway-capture.yml | capture | name%3ARun%20equivalence%20suite%20(four%20VERIFY%20verdicts) | 212 | CI_RUNNER_E2E | node:test | node:test | none |
| wp-mcp-gateway-capture.yml | capture | name%3ARun%20repair%20round-trip%20suite%20(cinatra%232286%20S10%20deliverable%207) | 227 | CI_RUNNER_E2E | node:test | node:test | none |
