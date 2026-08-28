# The round, in order

All times UTC on 2026-08-28, from the drivers' own stamps and the rows they selected.

## Bring-up

| at | what |
| --- | --- |
| 10:01:09 | the lane's own throwaway database is created and the committed `public` schema fixture applied (`scripts/apply-public-schema.mjs`) |
| ~10:05 | the lane's dev registry and the agent-runtime container come up; the runtime answers `{"status":"ok","agents":29,"failed":0,"failed_agents":[],"last_reload_at":null}` and the registry answers `200` |
| ~10:12 | the first dev boot fails to compile a connector page (`Can't resolve '@nangohq/frontend'`) and every `/api/auth/*` route answers 500 — the extension workspace packages had not been installed since the extension closure was cloned. `pnpm install` after `scripts/ci/sync-dev-extensions.mjs --pinned`, a clean `.next`, and the boot answers `/api/auth/get-session` **200**. Recorded as a bring-up fact of this lane, not as a reading of any screen |
| 10:20:34 | the lane account signs up through the shipped Better Auth endpoint; `admin` is APPENDED to its role column and it is inserted as an `owner` member of the organization the boot stamped the agent template with (the two disclosed provisioning writes); the organization is set active |
| 10:21:06 | the instance namespace is set through the app's own `/setup/name` step; the app lands the wizard on `/setup/secrets` and the instance holds an `instance_identity` row |
| 10:21:35 | the public origin is set through the app's own `/configuration/development?tab=tunnel` form and **read back by the app** after a reload |
| 10:22:30–10:23:10 | the model provider is configured through the app's own `/setup/model` step, inside the operator's secret-manager wrapper; the app seals the connection itself and the instance holds the sealed row |
| 10:24:11 | the three run packages are published into the lane's own registry and READ BACK from it: `@cinatra-ai/blog-draft-writer-agent@0.1.4`, `@cinatra-ai/context-selection-agent@0.1.1`, `@cinatra-ai/blog-post-artifact@0.1.4`, each HTTP 200 with the registry's own tarball shasum (`registry-publish.json`) |
| 10:25:57 | four organization-owned skill assignments are written through the shipped `upsertCustomSkillAssignment` and **all four** resolve through the shipped `getAssignedSkillIdsForAgent` |
| 10:26 | the three packages read back `active` in `cinatra.installed_extension` on the first poll — no second boot was needed on this lane |

## The three runs that are faults, not readings

| at | what |
| --- | --- |
| 10:33–10:36 | run `4ac55430-…` — DRIVER fault: the driver selected the recommendation rail step before answering the setup gate, and a selected gate step replaces the run detail, so the gate's fields were not where the driver looked. Left parked; nothing filed |
| 10:46–10:47 | run `c64f197f-…` — driver/timing fault: the shutter fired before the run page's two-column frame had painted and caught the agent's own screen instead. The driver now waits for `[data-run-detail-column]` and the rail step and reloads if they do not arrive. Nothing filed |
| 11:00–11:04 | run `a4016a2f-…` — a complete, correct walk, superseded: its frames were taken by the driver's own shutter before the SHIPPED recorder was wired into it. Nothing filed |

## THE MEASURED RUN — `67d76eb1-5806-4129-a555-e187b78bbf6d`

| at | what |
| --- | --- |
| 11:12:29 | the development toolbar's own indicator control is used (disclosed environment action), and the theme is read BEFORE anything is pressed: `{"dark":false,"stored":null,"osPrefersDark":false}` |
| 11:12:41 | a warm-up (probe) turn is answered with the platform's tools available — **0** ingress refusals |
| 11:12:41 | the person asks for the run in their own words: *"Please run the blog draft writer agent for me."* |
| 11:12:56 | the app's own dispatch creates run `67d76eb1-…` (`source_type=agent_builder`, `human_present=true`), found BY DIFFERENCE against the runs that existed before |
| 11:13:11 | the run parks on the recommendation (`status=pending_input`, `lifecycle_moment=recommendation`, `lifecycle_card_kind=recommendation_hold`); the run page's two-column frame is on screen and the recommendation rail step is the open step |
| 11:13:12 / 11:13:16 | **P1** — the held row as the rail step's own surface, light then dark, the dark one on the app's OWN Toggle theme control |
| 11:13:19 | the held row draws one chip per assigned skill: **4** |
| 11:13:22–11:13:37 | the four chips are decided ON THE RUN PAGE, each on its own affordance: Confirm, Adjust (then Keep), Confirm, Skip |
| 11:13:45 | the run parks at its setup gate (`pending_approval`, gate `setup-67d76eb1-…`, field `idea`) |
| 11:14:00 / 11:14:04 | **P2** — the settled row above the `Agentic Run Progress` box, light and dark. `[data-run-progress-panel]` **1** on the page, **0** roots inside it |
| 11:14:23 | the setup gate is answered through the screen's own **Continue** (the control's own name — this screen's Continue carries no `data-action` anchor, and which one answered is recorded) |
| 11:14:26 | the run reaches the schedule moment (`pending_trigger`, `lifecycle_card_kind=trigger_schedule_proposal`, `lifecycle_card_ref` **null** — batch 1's schedule-card defect, unchanged and not re-recorded here) |
| 11:14:43 / 11:14:47 | **P4** — the settled row beside the rail at the schedule moment, light and dark |
| 11:15:05 | the run page's own scheduling step arms the run on its own `Continue` |
| 11:15:07 | the mid-run gate opens (`wayflow-191dafd6-…`, renderer `@cinatra-ai/context-selection-agent:context-selector`) |
| 11:15:23 | the mid-run gate is answered through the screen's own Continue (`data-action="submit-hitl-screen"`) |
| 11:16:16 | the artifact review gate is minted: `lifecycle-review:2a4391df…`, `pending` |
| 11:16:38 / 11:16:42 | **P3** — the settled row above the review gate, light and dark; `[data-run-review-slot]` **1** reading `review`, `[data-lifecycle-card="artifact_review_gate"]` **1**, **0** roots inside the slot |
| 11:16:47 | the run reaches `completed` |

## After the run

| at | what |
| --- | --- |
| 11:17 | every filed frame is measured: 2880×1800, sha256, and mean luminance decoded from the file in the capture browser's own canvas — every dark frame ≤ 17/255, every light frame ≥ 236/255 |
| 11:18 | the eight records the SHIPPED recorder wrote at the shutter are merged into the canonical index through the shipped `mergeWalkRecords`: **105 → 113**, and the shipped validator accepts all 113. **Zero refusals** |
| 11:18 | `--print-anchor-digest`: recorded == recomputed, `fa31fa2f1e73b545ba42e923636af4e4ac6025d623b6c5fdcc68d32342994d46`, BEFORE the merge and AFTER it — the digest's three inputs are untouched by a record |
| 11:19 | the gates: `chat-hitl-evidence-gate` **0**, `chat-hitl-acceptance-gate` **0**, `chat-hitl-one-card-gate` **0**, `file-size-ratchet` **0** |
