# Attribution-record correction — #660 runtime cube/portlet registries (the Truthful Attribution protocol §5)

This note is the forward correction (truthful verification-record spec — the
Truthful Attribution protocol §5) for the attribution record that landed with the
squash merge of PR #713 (`feat(dashboards): runtime cube + portlet registries
with no-rebuild install`, Closes #660), squash commit
`50527894138ae00963ec3ff20a974c8e87099718`.

## What landed

PR #713 is PR-7 of the v0.1.5 hot-installability work: it replaces the static
cube singleton + the install-time `requires-rebuild` refusal with a runtime cube
registry. An installed extension contributes a cube as an ALIAS over a host
FROM-allowlisted base cube (`agent_runs` / `projects` / `teams` /
`organizations`) with a member SUBSET — the host owns ALL SQL and the exact
tenant predicate, so no extension SQL/DDL ever executes. It adds the cube-guard
`register-runtime` verdict, runtime portlet-kind metadata (`rendersAs`,
alias-only onto an existing bundled component), and the reconcile that rebuilds
the cube platform + clears the MCP cube-tools bridge so contributions appear at
runtime with no rebuild; disable/uninstall unregisters via the
capability-teardown hook. The CG-5 install-active+trust serve-gate is ADDITIVE
over the existing drizzle-cube tenant predicate on BOTH transports for BOTH
runtime and bundled cubes, with cross-org denial tested on both and the catalog
surfaces (`/meta` + MCP `discover`) filtered. It touches host `src/` +
`packages/dashboards` + `packages/sdk-dashboard` code, two generated tsconfig
path aliases, and the root `vitest.config.ts` — none of which matches any
high-risk glob in `.github/gate-suite.json` `highRiskPaths`, so the change is
non-high-risk and was correctly machine-armed.

## What was wrong

The #713 squash record carried a complete, valid machine arm
(`Gate-suite: cinatra-core@2026.06.4` + `Accountable: Sandro Groganz
<sandro@cinatra.ai> (@groganz)`) and correct `Assisted-by` records. The change
and its arm were genuine; the merge itself was clean and `main` builds green.

The failure was a **`tree-mismatch`**: at the moment the admin squash executed, a
sibling lane's merge (`8f50f10`, a route-graph-ratchet addition) had just landed
on `main` AFTER the up-to-date verification, so GitHub squashed PR #713 onto
`8f50f10` rather than the `70a3639` base it was verified up-to-date against. The
landed tree therefore included the sibling lane's files and did NOT byte-match the
reviewed-head tree (`5629f96`), so the post-merge attribution gate could not bind
the machine arm to the landed tree and went RED with `[tree-mismatch]`.

The auto-merge of the two changes was clean (disjoint file sets — dashboards/cube
code vs `scripts/audit/route-graph-ratchet*`), so the landed code is correct; only
the tree-binding broke.

## The correction

This forward governance note re-asserts the truthful attribution record for the
landed change. The squash record's arm and `Assisted-by` records stand as the
authoritative attribution for the #660 work; this note records that the
`[tree-mismatch]` was a merge-ordering artifact (a sibling lane landing between the
up-to-date check and the squash), not a defect in the change, its review, or its
machine arm. The lesson — re-verify up-to-date IMMEDIATELY before the admin squash,
under the merge mutex, to avoid a sibling lane re-staling the base — is captured.

`Correction-for` points at the tree-mismatched squash so the gate associates this
record with it.
