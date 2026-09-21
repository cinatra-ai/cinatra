# Hosted build size trial

This opt-in workflow compares three maintained production workloads on two disposable GitHub-hosted runner classes at one immutable source commit. It does not provision runners, change routing variables, publish images, retry jobs, or run on pull requests and pushes.

## Workload contract

| Trial selection | Source job | Per-job limit |
| --- | --- | --- |
| design | design-visual-verify.yml / pixel-diff | 70 minutes |
| dashboard | dashboard-live-verify.yml / smoke | 45 minutes |
| image | build-image.yml / image | 45 minutes |

The generated workflow preserves each source job's real installation, production build, database setup and acceptance commands. Design explicitly selects the full existing design plan; dashboard bypasses only its path-selection stub; image loads and tests its image locally. The unrelated publication jobs are absent. The image workflow's normal manual dispatch also publishes a nonrelease image, so use this dedicated trial instead.

Both arms omit artifact transfers, build/package cache transfers and Docker build-record uploads. Captures remain on the disposable VM; never attach trial media or raw run bundles to a product branch. Ordinary job logs contain bounded numeric observations and build/test output. Store the collected comparison and any downloaded logs in approved private storage.

The standard arm uses Ubuntu 24.04 x64, 4 CPUs and approximately 16 GiB RAM. The large arm uses Ubuntu 24.04 x64, 8 CPUs and approximately 32 GiB RAM. Existing source CPU limits, heap settings and swap commands remain identical. CPU count and disk size also change with the runner class: this is not an isolated causal test of RAM alone.

## Source verification

Run these checks on the candidate checkout before publication:

```sh
node scripts/ci/hosted-build-size-trial.mjs verify
pnpm exec vitest run scripts/ci/__tests__/hosted-build-size-trial.test.mjs
actionlint .github/workflows/hosted-build-size-trial.yml
```

The generator derives the job bodies from the three current workflow files and records their hashes. A source-job edit deliberately makes verification fail until the trial cut is regenerated and reviewed:

```sh
node scripts/ci/hosted-build-size-trial.mjs render > .github/workflows/hosted-build-size-trial.yml
```

Review every generated change. Parity means identical workloads across trial arms; it does not establish production acceptance before the six real jobs execute.

## Resource prerequisite

Paid provisioning requires explicit resource authorization separate from merging the source. Before creating anything, record the approved source SHA, billing limit, trial owner, repository, runner group ID, image, runner size and cleanup responsibility.

Use a dedicated runner group named ci-build-trial-3316, restricted to this repository and this workflow at the approved full commit SHA. Use a single runner configuration with label ci-build-trial-3316-8core, Ubuntu 24.04 x64, 8 cores / 32 GB RAM, maximum one concurrent job, no static IPs and no private networking. Positively read back the repository and workflow restrictions; stop if the organization's plan cannot enforce them. Do not broaden the default runner group or upgrade the plan silently.

An organization administrator can configure this through the existing settings UI without granting a new App permission. If an already authorized API path is used, hosted-runner creation/deletion requires organization Administration write; runner-group changes require organization Self-hosted runners write. Dispatch/cancel requires repository Actions write. This document does not grant those permissions.

At the published Linux x64 8-core rate of $0.022/minute, the three paid job limits total 160 minutes, or $3.52 of planned maximum execution time before taxes. GitHub rounds job time for billing; do not present timeout arithmetic as a billing-system hard cap. A $4 incremental compute authorization covers this bounded plan, not retries or additional jobs. Recheck the current price and exact runner SKU at authorization time. Larger runners are billed even for public repositories and do not consume included standard-runner minutes. Idle configurations incur no minute charge.

Sources: [runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing), [runner access controls](https://docs.github.com/en/actions/how-tos/manage-runners/larger-runners/control-access), [hosted-runner API](https://docs.github.com/en/rest/actions/hosted-runners), [runner-group API](https://docs.github.com/en/rest/actions/self-hosted-runner-groups).

## Six sequential observations

After the workflow is merged and resource authorization is recorded:

1. Freeze source SHA H, verify its workflow/source parity, and read back the dedicated runner group's exact workflow-at-H restriction and maximum concurrency of one.
2. Dispatch one workload at a time at H. Record each returned run ID before doing anything else. Use the order standard/design, large/design, standard/dashboard, large/dashboard, standard/image, large/image. Wait for terminal status and inspect the result before the next dispatch.
3. Each dispatch selects exactly one of the three jobs. Workflow concurrency serializes runs, and the large runner cap provides a second maximum-one bound. Do not queue a batch: GitHub concurrency can replace a pending run.
4. Reject a run whose source, runner class, selection or first attempt differs. A manual rerun has attempt greater than one and executes no workload; it is not an observation. There is no retry watcher for this workflow.
5. Stop on configuration drift, a failed identity/parity check, unexpected publication, inability to read the complete job inventory, or approaching the approved spend bound. Cancel only the owned trial run if it cannot complete within the approved constraints. Do not fix a failed workload by dispatching an extra paid job.

Record a genuine build/test failure or runner shutdown as an attempted workload. A shutdown message alone does not prove external VM reclaim. Decide whether to continue the remaining authorized distinct workloads from the actual failure and budget; never turn a failed observation into an uncounted retry.

Before any dispatch, use the current supported GitHub API/CLI road and confirm it can select the immutable commit; if it requires a branch/tag, use an approved fixed ref, confirm it still equals H immediately before dispatch, and verify the returned run's head SHA before admitting its result.

## Read-only comparison

Collect exactly the six recorded run IDs using an existing repository Actions read credential. The report command only issues bounded GET requests; it does not discover a flattering subset or use retry-watcher artifacts as its denominator:

```sh
node scripts/ci/hosted-build-size-trial.mjs report OWNER/REPO H GROUP_ID ID1,ID2,ID3,ID4,ID5,ID6 > /approved/private/location/trial-comparison.json
```

Supply the read credential through the established GITHUB_TOKEN or GH_TOKEN environment path without printing it. The collector pins GitHub REST API version 2026-03-10, reads attempt-one job inventories and logs, then rereads each run to reject changes during collection. Exactly three jobs per run must be present, with two skipped and one executed. Missing or truncated API/log evidence refuses a complete report. Every counted attempt must contain exactly one initial identity record emitted after source parity and runner-class checks, matching its owned run/head/attempt/cohort/workload/machine. Failure before that admission refuses a complete comparison, rather than being counted as an observed workload failure.

The report includes each job's conclusion, duration, build duration where recorded, shutdown signature and memory observations. The five-second sampler reports system-wide available memory and swap use, not process-tree peak RSS. It runs only during the measured job after checkout, has its own bounded lifetime, and must stop with matching process identity. Gaps over 15 seconds refuse a complete terminal measurement. An admitted job that loses its terminal record stays in the denominator with memory marked unknown. The report names an observed shutdown only when its log contains that signature; otherwise it says missing terminal evidence without inventing a termination cause.

One observation per workload is a minimum feasibility trial. It can show whether all three complete on the proposed class and reveal obvious resource differences; it cannot establish a statistically lower intermittent failure rate. Report all six outcomes and any unknowns before proposing a longer cohort.

## Cleanup and evidence

After the three paid attempts complete, or immediately on a stop condition, remove only the dedicated trial runner configuration and dedicated group. First confirm no owned job is still running; cancel and wait for any such job before deleting its resource. Read back that the trial resources are absent and ordinary groups/routing variables are unchanged. Disposable VM processes, databases and image layers end with their jobs.

Keep the approved resource decision, source SHA, six direct run IDs, complete comparison, actual usage readback and cleanup receipt in private evidence storage. A successful source PR does not complete the issue's real larger-runner trial acceptance.
