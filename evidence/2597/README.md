# Live UAT — PR #2602 (#2597): the approvals detail page supplies the access scope

Battery A of lane DOUBLE-UAT-236. This is the live browser proof the PR body lists
under "Not covered here" ("a render pass on the running approvals detail page is
the natural follow-up before close").

**Result: 5 of 6 checks PASS, 1 FAIL.** The FAIL is a real, twice-reproduced defect
in this PR's own scope-persistence seam — see check 4. It is recorded here, not
fixed by this lane.

## How this was run

One dev boot carried BOTH unmerged sibling PRs, so a single instance could pay off
two owed UATs:

- throwaway local integration branch `uat/236-local` = `origin/main` (aa83d887)
  + merge of `lane/2597-approval-scope` (8749476f) + merge of `batch/ui-233` (2c56966f).
  Never pushed; deleted on completion.
- **Both merges were clean — no conflicts.** The two PRs' file sets are fully
  disjoint (verified: `git diff --name-only` of each against main shares zero
  paths). #2599 touches `src/lib/approvals/sources/*` while #2602 touches
  `src/lib/approvals/{actions,decision-helpers,agent-decision-actions}` and the
  `[id]` route — adjacent, but no shared file.
- Next dev server on port 3121, workers=1, one browser.
- Dedicated database `uat236` on the verify Postgres (127.0.0.1:5634), templated
  from a fully-migrated instance DB then migrated to the integration branch head
  (`core__0091`, "No migrations to run"). Dropped on completion.
- Extensions synced pinned: `scripts/ci/sync-dev-extensions.mjs --pinned`
  → "OK: 111/111 extension repos cloned into extensions/".
- `CINATRA_ENCRYPTION_KEY` is 32 bytes (asserted). It is the SOURCE instance's key,
  carried across deliberately: the DB is a template copy of a real instance, so its
  stored publish-destination credentials are sealed with that key. A freshly
  generated key made them undecryptable ("Unsupported state or unable to
  authenticate data") and blocked publish.
- **`CINATRA_E2E_SETUP_BYPASS=true`** — stated per the batch-225 precedent. Both
  surfaces under test are post-setup, so the bypass does not touch either contract.
- Sessions are real: Better Auth sign-up + sign-in through the app's own
  `/api/auth/*`, then `organization/set-active`. No admin-bypass shortcut.

## Fixture provenance (stated honestly)

The chat-created path is **not** reachable credential-free (it needs a live LLM), so
requests were seeded through the primitive that path calls —
`agent_creation_request_propose` — under a non-admin author actor, which is the seam
the repo's own tests use. The proposal payload is a REAL shipped AgentSpec Flow
(`extensions/cinatra-ai/lint-policy-agent/cinatra/oas.json`, renamed), because a
hand-written stub OAS is refused by the publish pipeline (no StartNode/EndNode) and
would have masked the seam under test.

Reviewer: `uat236-admin@local.test` (the org's sole platform admin).
Author: `uat236-author@local.test` (non-admin). Team scope target:
`UAT236 Reviewers` (`uat236-team-732076ac`).

## Checklist

| # | Check | Result | Capture |
|---|---|---|---|
| 1 | The scope step renders on the running detail page — the shared `AccessCombobox` in `installMode`, offering only the real install targets (Organization + Team; no owner/workspace/admin rows) | **PASS** | `A1-scope-step-renders.png`, `A1b-accesscombobox-open-installmode.png` |
| 2 | Submit is gated on a resolved scope: with the scope context unresolved, "Approve & publish" is `disabled` and NO `accessTargetLevel`/`accessTargetId` hidden fields are rendered at all | **PASS** | `A2-submit-disabled-no-scope.png` |
| 3 | Choose a team scope → approve → lands `?status=approved`, and the access write is visible in the DB | **PASS** | `A3-approve-team-scope-status-approved.png` |
| 4 | The same approve when the proposal's package scope differs from the instance namespace: publishes, then **loses the chosen scope** — `?error=scope-not-applied`, no access row written | **FAIL** | `A4-FAIL-scope-not-applied.png` |
| 5 | Force-submit with the client validation stripped (hidden target fields removed, button re-enabled) → server refuses `?error=scope-required` and writes NOTHING | **PASS** | `A5-forcesubmit-scope-required.png` |
| 6 | Reject path lands `?status=rejected` and never demands a scope | **PASS** | `A6-reject-no-scope-demanded.png` |

### Check 3 — the access write, verified in the DB

Request `945f9578-…` (proposed as `@lane-2502-item-e-1786283098809/uat236-nsmatch-805150`)
approved at team scope:

```
cinatra.extension_access_policy
resource_kind  | resource_id                          | runExecuteVisibility
agent_template | 343f9c57-4a6f-49ba-af0d-de5e0c8d7046 | ["team:uat236-team-732076ac"]
```

`runDataVisibility` and `runListVisibility` carry the same `team:` target, and
`installed_by_user_id` is the approving admin. This is the `setExtensionInstallAccess`
row the PR promises, written through the shared install path.

### Check 5 — nothing written, proven byte-identical

Request `6f929198-…`, `md5(row::text)` before and after the refused force-submit:

```
before  07a60f38c87a67db02efa33b7205dc22
after   07a60f38c87a67db02efa33b7205dc22
```

`agent_templates` stayed at 38 rows and `extension_access_policy` at 23 across the
refusal. The request stayed at `proposed`. The refusal fires before the audited
primitive, exactly as the PR claims.

## Check 4 — the FAIL, in detail

**Symptom.** A valid approve with a valid scope chosen publishes the agent and then
silently fails to apply the reviewer's scope. The page lands on
`?error=scope-not-applied`; `extension_access_policy` gets no row; the agent is left
at its restrictive default.

**Root cause.** `decideAgentCreationRequest` persists the scope using
`result.structuredContent.agentTemplateId`. The primitive resolves that id with

```
readAgentTemplateByPackageName(cur.packageName)   // cur = the agent_creation_request row
```

— the **proposed** package name. But publish rewrites the scope to the instance
namespace, so the created `agent_templates` row is stored under a different name and
the lookup misses:

```
request.package_name            @uat236/uat236-approve-ok-261494
publish_result.packageName      @lane-2502-item-e-1786283098809/uat236-approve-ok-261494
agent_templates.package_name    @lane-2502-item-e-1786283098809/uat236-approve-ok-261494
```

`agentTemplateId` is therefore `null` → `template_unresolved` → `scope-not-applied`.

**Why this is not a fixture artifact.** The propose schema documents `packageName`
only as `"@scope/name. Must NOT collide with an existing agent_template."` — the chat
author picks it freely, and the instance-namespace rewrite at publish is normal
behavior. Any proposal whose scope is not already the instance namespace hits this.
The controlled pair above proves the conditioning exactly: the namespace-MATCHING
proposal (check 3) wrote its access row; the two non-matching ones did not.

**Reproduced twice, deterministically** (requests `ab1b9128-…` and `667567b5-…`), both
landing `?error=scope-not-applied` with the agent published and no access row.

**Server log:**

```
[agent-approval decide] refused: transient template_unresolved
  The agent was published, but its record could not be resolved to apply the
  access scope. Retry, or set access on the extension's Permissions.
```

**Codex round** (read-only, stdin) on this finding returned: *genuine product defect,
not a fixture artifact; the lookup should key on `publishResult.packageName` (or the
publish path should return the template id directly); **merge blocker** — fail-closed
limits the security impact but a valid approval deterministically loses the reviewer's
scope after an irreversible publish.* It also flagged that the refusal is classified
`transient` and tells the admin to retry, but the request is already `published` while
the Retry-publish affordance only accepts `approved` — so the offered route out does
not exist on this row; and that the seam's tests mock `agentTemplateId` and so never
exercise the publish-time namespace rewrite.

Not fixed here — this lane records live findings, it does not change PR code.

## Note on check 2

The picker arrives with a default already selected (the shared install-picker's
`defaultValue`), so on a normal load the submit is enabled because a scope genuinely
IS chosen — that is the intended parity with the install dialogs, not a gap. The
required-ness gate was therefore proven at the state where no scope is resolved, by
holding the `loadApprovalInstallScopeContext` server action unresolved: the button is
`disabled`, the combobox is not yet mounted, and no hidden target fields exist.
Check 5 proves the server half of the same contract independently.
