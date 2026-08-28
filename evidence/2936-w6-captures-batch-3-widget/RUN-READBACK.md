# What the database says, not what this round remembers

Every number is read back out of the round's own throwaway database after the
fact; the raw output is `db-readback.txt`.

## The run every filed record is taken from

| read | value |
| --- | --- |
| run | `01b55935-2a9c-47ce-85cc-b677eef9df56` |
| created | 2026-08-28 08:12:56.635Z |
| `human_present` | **true** |
| `source_type` | `agent_builder` |
| how it was started | one sentence typed into the WIDGET's own composer — *"Please start the agent @cinatra-ai/blog-draft-writer-agent for me."* — through `agent_named_start` |
| recommendation park | created 08:12:57.635Z, **released 08:13:39.566Z** |
| chips offered | 4 — Blog Idea Authoring, Blog Post Matcher, Blog Writing, Brand Voice Matcher |
| chips decided | CONFIRMED · ADJUSTED · **SKIPPED** · CONFIRMED, each on its own control inside the widget |
| skills the run recorded as selected | **3** (`recommended_confirmed`, `user_adjusted`, `recommended_confirmed`) — the skipped one is drawn and not carried |
| where it stands now | `pending_trigger`, `lifecycle_moment=schedule`, `lifecycle_card_kind=trigger_schedule_proposal`, `lifecycle_card_ref=null` |

## The run the review readings are taken from

| read | value |
| --- | --- |
| run | `096e5a56-d42b-46fc-9dd4-8e3da018998b`, created 06:14:50.923Z, `completed` |
| its review gate | `53781825-e912-4aaa-8275-4337f90efe85`, **`pending`**, created 06:39:00.346Z, never resolved |
| review cards drawn in the widget | **0** on the live page after 900 s of polling, **0** after a reload and a fresh widget sign-in |
| `[data-run-review-slot]` elements in the widget | **0** across 260 polled samples |
| HITL gates it asked | two — the agent's own `idea` setup field, and the mid-run `@cinatra-ai/context-selection-agent:context-selector` |

## Every run this round created, and why there is more than one

Seven runs, all from the widget's own composer, all `human_present=true`. Five
were created while this round was finding two environment faults and one wrong
assumption (the skill-id shape); they are left in the readback rather than
hidden, because a round that only shows its last attempt is not a record.

## What is NOT written anywhere

| read | value |
| --- | --- |
| `cinatra.artifact_verification_records` | **0** rows |
| `cinatra.run_recommendation_skips` | **0** rows — the skipped chip is drawn from the offered set and the absent selection, not from a skip row |
| stored turns carrying `recommendation_hold` / `trigger_schedule_proposal` / `artifact_review_gate` | **0** each |
| turns carrying any `dataParts` at all | 7 |

The last two rows matter for plan (B) §6's *"carried by the turn's durable
content"*: the settled row IS there after a reload on this host — that is what
`W13` and `W14` photograph — and it is **projected from the run's own row**, not
restored from a durable part in the turn. The clause's outcome holds; its stated
mechanism does not, on this host as on the other two batch 1 and batch 2 measured.

## The disclosed writes, and what was NOT written

1. **Four organization-owned skill assignments**, through the shipped
   `upsertCustomSkillAssignment`, read back through the shipped reader.
2. **One connector instance row**, through the shipped
   `writeConnectorConfigToDatabase` — the same writer the connector's own
   dev-setup hook and the CMS exchange call. No CMS exists on this lane; its two
   credential fields are inert placeholders.
3. **Two provisioning writes shared with the sibling rounds**: the lane account
   is made an administrator, and it joins the organization the instance's own
   boot stamped every agent template with.
4. **Three packages published** into the lane's own throwaway dev registry.

The connect site was NOT written by a harness: it was minted through the
product's own `/connect/authorize` consent screen, approved on that screen's own
control, redirected to the site's own backend callback and redeemed at the
shipped `POST /api/connect/token`. Two rows exist because the origin pair had to
be corrected mid-round; the abandoned one is bound to an origin nothing points at.

`grep -rniE "insert into|SEEDED_|seedGate|seedTurn|update .* set status"` over
this round's drivers is **EMPTY** — no run, gate, park, record or review task was
inserted and no status was written by hand.

## Provider evidence, and its limits

| read | value |
| --- | --- |
| `POST /api/mcp 200` callbacks from the provider's own servers over the public ingress | **36** |
| `[llm-bridge-run-select]` lines from the agent runtime | 1 |
| scripted-provider lines in the server log | **0** |
| `CINATRA_TEST_LLM_PROVIDER` | **unset**, and absent from the lane's env file |
| ingress refusals during the measured turns | 0 |
| ingress refusals before them, on the cold route | **2**, recorded — the first two widget turns were answered *"Cinatra tools are unavailable: the public MCP URL … is not reachable (no response within 2500ms)"*. The app probes with `HEAD` (`packages/llm/src/mcp-access.ts:80-84`) and a cold funnel answers that in 14.8 s; a `HEAD` probe warms it to 0.36 s, and a five-second pinger held it there for the rest of the round. Disclosed as an ENVIRONMENT action: it probes the ingress and touches nothing of the product. |

**The limit, stated:** `cinatra.llm_usage` does not exist on an instance built
from the public-schema fixture, so there is no per-call token table to quote. The
positive evidence is the thirty-six public-MCP callbacks, the bridge line, the
absent scripted lines, and the model's own prose in the transcripts.
