# The test-runner worker cap and its invocation inventory

Issue **cinatra#3355** (unit and gate jobs on the shared self-hosted CI host
reach the test runner with no committed worker cap) · gate
`scripts/audit/vitest-worker-cap.mjs` · tests
`scripts/audit/__tests__/vitest-worker-cap.test.mjs`.

This file is the *documented* half of that issue's criterion 1: every
test-runner invocation under `.github/workflows/**` is listed below with the
job it sits in, the step's line, the job's runner class, the runner the
invocation actually resolves to, and its disposition. It is documentation of the
CI configuration — nothing else lives here.

## The committed value

```yaml
env:
  VITEST_MAX_WORKERS: "3"
```

One top-level `env:` block in each of the 10 governed
workflow files, so the tree carries exactly 10
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
Changing the value later means the 10 workflow edits, the
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

16 workflow files carry a test-runner step;
10 of them are governed. 136 invocations:
95 governed, 13 hosted-pinned,
20 node:test, 7 playwright,
1 extension-suite-gate.

The gate holds this table to its FULL derived entry set, so an added or removed
job or step inside an already-listed workflow reds it. The step line is the
`run:` key's line; several invocations in one `run:` block share it. The
**effective cap** is the value that actually reaches that step — the
workflow-level one unless a job-level or step-level assignment narrows it, and
`none` when no assignment reaches the step at all.

| workflow | job | step line | runner class | runner | disposition | effective cap |
|----------|-----|-----------|--------------|--------|-------------|---------------|
| build-image.yml | a2a-unit | 346 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | actions-pin-gate | 187 | CI_RUNNER_GATE | node:test | node:test | 3 |
| build-image.yml | agents-integration-db | 1229 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | agents-integration-db | 1271 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | agents-integration-db | 1296 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | auth-schema-drift | 568 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | auth-schema-drift | 571 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | chat-hitl-held-turn-e2e | 3621 | ubuntu-latest | playwright | playwright | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | 3770 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | 3775 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | 3780 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | 3785 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | 3797 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | 3809 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | 3823 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | 3838 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | 3856 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | 3872 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | chat-hitl-held-turn-e2e | 3886 | ubuntu-latest | vitest | hosted-pinned | 1 |
| build-image.yml | context-resolve-route-shape | 520 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | devperf-invariants | 1775 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | devperf-invariants | 1778 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | e2e-rbac | 3295 | CI_RUNNER_E2E | playwright | playwright | 3 |
| build-image.yml | execution-plane-unit | 409 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | 729 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | 739 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | 753 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | 770 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | 787 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | 801 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | 813 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | 836 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | 867 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | 886 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | 891 | CI_RUNNER_E2E | vitest | governed | 3 |
| build-image.yml | extension-lifecycle-db-tests | 921 | CI_RUNNER_E2E | vitest | governed | 1 |
| build-image.yml | hosted-mcp-wire-gate | 1735 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | hosted-mcp-wire-gate | 1741 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1623 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1626 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1629 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1632 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1635 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1638 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1641 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1644 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1647 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1650 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1653 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1656 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1659 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1662 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1665 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1668 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1671 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | package-unit-suites | 1674 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | perpetual-core | 1909 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 1921 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 1938 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | 1954 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | 1983 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | 2008 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2019 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2036 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2053 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2070 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2086 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2108 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | 2121 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2140 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2158 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2179 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2199 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2214 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2240 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2265 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2282 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2305 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | 2321 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | 2330 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2342 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2361 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2378 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | 2396 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | 2416 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | 2434 | CI_RUNNER_POOL | node:test | node:test | 3 |
| build-image.yml | perpetual-core | 2456 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2483 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2523 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2531 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2588 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2636 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2702 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2705 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2820 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2832 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2842 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2849 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2858 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2863 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-core | 2882 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | perpetual-extension-suites | 2990 | CI_RUNNER_HEAVY | vitest | extension-suite-gate | 3 |
| build-image.yml | presence-degraded-build | 4747 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | rbac-authz-unit | 485 | CI_RUNNER_POOL | vitest | governed | 3 |
| build-image.yml | schema-migration-gate | 670 | CI_RUNNER_GATE | node:test | node:test | 3 |
| build-image.yml | skills-unit | 303 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | test | 264 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| build-image.yml | v64-invariants | 1530 | CI_RUNNER_POOL | vitest | governed | 3 |
| crm-migration-gate.yml | gate | 152 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| crm-migration-gate.yml | gate | 155 | CI_RUNNER_HEAVY | node:test | node:test | 3 |
| dashboard-live-verify.yml | smoke | 440 | CI_RUNNER_E2E | playwright | playwright | none |
| dev-hmr-smoke.yml | hmr-smoke | 192 | CI_RUNNER_E2E | playwright | playwright | none |
| e2e-app-suites.yml | agents-run-invariants | 613 | CI_RUNNER_E2E | playwright | playwright | none |
| e2e-app-suites.yml | notifications-e2e | 544 | CI_RUNNER_E2E | playwright | playwright | none |
| e2e-app-suites.yml | render-smoke-e2e | 321 | CI_RUNNER_E2E | playwright | playwright | none |
| execution-plane-e2e.yml | batteries | 301 | CI_RUNNER_E2E | vitest | governed | 3 |
| extension-readme-gate.yml | tests | 155 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| gates.yml | gates | 104 | CI_RUNNER_GATE | node:test | node:test | 3 |
| gates.yml | gates | 200 | CI_RUNNER_GATE | node:test | node:test | 3 |
| gates.yml | gates | 272 | CI_RUNNER_GATE | node:test | node:test | 3 |
| gates.yml | gates-pnpm | 309 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| gates.yml | gates-pnpm | 312 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| gates.yml | gates-pnpm | 315 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| gates.yml | gates-pnpm | 318 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| gates.yml | gates-pnpm | 325 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| mcp-route-gate.yml | mcp-route-gate | 126 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| org-write-boundary-gate.yml | org-write-boundary-gate | 122 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| org-write-boundary-gate.yml | org-write-boundary-gate | 124 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| skill-match-eval.yml | live-eval | 119 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| skill-packaging-gate.yml | tests | 122 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| trusted-read-scale-smoke.yml | scale-smoke | 149 | ubuntu-latest | vitest | hosted-pinned | none |
| trusted-read-scale-smoke.yml | scale-smoke | 156 | ubuntu-latest | vitest | hosted-pinned | none |
| validate-agents.yml | validate-runtime-invariants | 153 | CI_RUNNER_HEAVY | vitest | governed | 3 |
| works-after-proof.yml | proof | 320 | CI_RUNNER_E2E | node:test | node:test | none |
| wp-mcp-gateway-capture.yml | capture | 212 | CI_RUNNER_E2E | node:test | node:test | none |
| wp-mcp-gateway-capture.yml | capture | 227 | CI_RUNNER_E2E | node:test | node:test | none |
