# cinatra#2094 S7 — **fix verification** for F7 and F11

Appendix to [`../PROOF.md`](../PROOF.md). That document recorded the failures; this
one records the fix and re-drives the two arms that failed, on a real stack, with
the same committed drivers.

**Read the F11 section before trusting the finding as written.** F11's recorded
mechanism does not survive isolation, and the honest correction is below rather
than a fix for a defect that is not there. A real, adjacent silent no-delivery
*is* there, and is fixed and live-proven.

## Where this ran

| | |
|---|---|
| base | the LIVE arms below ran on `origin/main` @ `20b51de6c` (the S7 evidence commit `c5924994a` is an ancestor); the branch is now rebased onto `e5fa33161`, which carries the #2243 hotfix for main's own red |
| instance | the SAME lane instance the S7 round used — real Postgres 18 on a lane-unique port, 160 tables, 28 catalog skills, real operator account, real extension universe (`anthropic-connector` @ `e0a6c09`, the recorded F12 off-pin exception) |
| provider boundary | **NOT STUBBED.** Real `api.anthropic.com` / `api.openai.com` with the org keys; the `node --import` preload only OBSERVES and records |
| browser | the lane's own persistent Chromium profile, never the shared MCP browser |
| live-API hygiene | 26/26 lane-uploaded skills reclaimed, 151 versions deleted, 0 indeterminate — `results/live-api-cleanup.json` |

---

## F7 — the mechanism, isolated

The S7 round called its own hypothesis *"consistent with, not isolated"* and named
the alternatives it had not ruled out. It is now isolated, and it is **two**
independent defects stacked, which is why the error listed skills that measurably
*did* have sync rows alongside skills that did not.

### F7-1 · the chat request never sees the registered sync map

`results/F7-resolver-isolation.txt` — a temporary in-process probe, driven on the
LIVE failing turn, reverted afterwards. In **one process, one run**:

```
[F7-PROBE][boot]    installed; resolverAfter=TableBackedAnthropicSkillSyncMap
[F7-PROBE][request] resolver=UnsyncedAnthropicSkillMap  ids=[...the 5 assistant skills...]
```

Next.js compiles `instrumentation` and the route handlers as **separate bundler
compilations**, each with its own module cache. `anthropic-skill-sync-map.ts` held
the active map in a plain module-level `let`, so the boot registration landed in a
*different instance of the module* than the one `/chat` resolves through — and
every Anthropic delivery fell back to the fail-loud default. That is why the throw
named all five skills, including the two whose rows the S7 diagnostic could see.

Surviving `next build` never argued against this: a production build has the same
instrumentation/route split.

**Fix:** anchor the holder on a namespaced+versioned `Symbol.for(...)` key on
`globalThis` — the idiom this codebase already uses, for exactly this reason, in
`extension-mcp-registry`, `extension-ui-registry` and
`extension-capabilities-registry` (which is why the same turn *did* resolve its
connector-registered provider adapter while failing to see this map). The
registration flag in the host service is anchored the same way so "registered" is
a per-PROCESS fact matching the per-process holder it writes to.

### F7-2 · three of the assistant's five skills were never uploaded at all

Measured on the instance, before any change:

| skill | on disk | DB bundle head | sync row |
|---|---|---|---|
| `chat-assistant-core` | SKILL.md + 5 `references/*` | **router only (1 file)** | **0** |
| `chat-extension-authoring` | SKILL.md + 7 `references/*` | **router only (1 file)** | **0** |
| `chat-automation-authoring` | SKILL.md + 4 `references/*` | **router only (1 file)** | **0** |
| `company-research` | SKILL.md only | router only (1 file) — correct | 1 |
| `blog-content` | SKILL.md only | router only (1 file) — correct | 1 |

The correlation is exact, and `skill_bundle_heads.revision_id` equalled
`skills.active_revision_id` for all five — the signature of
`seedBundleHeadFromLifecycleRevision`, the pre-S1 re-baseline seed. A pre-S1
lifecycle revision stores **only the router body**, so seeding from it mints a
**bundle-of-ONE** manifest. That manifest is authority-owned, so every later
capture classified the skill as an `authorityOwnedDivergence` and never advanced
the head — permanently. The router then provably dead-ends against its own
manifest, and S2's fail-closed one-hop lint (#2089) **refuses** the skill as an
upload candidate. Hence: 22 skills uploaded, and a wizard that reported success.

**Fix:** three parts, all narrow.
1. the seed is **skipped for a multi-file disk bundle** — but only for a skill the
   DISK owns, so no NEW instance is pinned by it while a custom/personal skill
   still always gets its re-baseline;
2. an instance **already pinned** by the pre-guard seed **heals**: capture advances
   a head that is *provably* the defective seed's while disk ships more. This is
   the part Codex blocked, twice, and it is now rebuilt on durable row provenance
   plus a compare-and-swap over every mutable input — the full ledger and the
   final shape are in the Codex section at the end;
3. the readiness saga **refuses to report success over a refused skill**. Before,
   `captureDiagnostics` was discarded at that seam — the masquerading success this
   mode exists to stop.

### F7 — RED, then GREEN, same drivers, same stack

| | before the fix | after the fix |
|---|---|---|
| driver result | `results/RED2-anthropic-assistant-run.json` | `results/GREEN-anthropic-assistant-run.json` |
| `/chat` turn | `AnthropicSkillNotSyncedError`, **0 provider calls** (2/2 attempts) | **no such error**; the turn **reaches the provider** |
| wizard arm | — | `results/GREEN-anthropic-arm.json` — **17/17 PASS** |
| `syncedSkillCount` on the receipt | 22 | **28** |
| bundle heads for the 3 multi-file skills | router-only, authority-owned | **`bundle:` heads with 6 / 5 / 8 files** |
| sync rows for the assistant's 5 skills | 2 / 5 | **5 / 5** |
| `container.skills` on the wire | never sent | **5 refs, both halves, ≤ 8** |

The wire record is the load-bearing artifact
(`ledgers/egress-fix-verification.jsonl`):

```
GREEN-A-assistant-run  POST /v1/messages  model=claude-sonnet-4-6
  hasContainer=true  containerSkillCount=5
  {skill_id: skill_01JMiLBAJcDqBMvyCiFmDWHu, version: 1785396741437807, type: custom}
  {skill_id: skill_013wNAbmZvJkQBJD1wANGbnf, version: 1785395816589350, type: custom}
  {skill_id: skill_016ujT2Rm93WzKGSuHdBbQAV, version: 1785395815440830, type: custom}
  {skill_id: skill_01CgwY5Ws2oaLDbwncF1tiM5, version: 1785396746367045, type: custom}
  {skill_id: skill_01Pdw2hSeNrihiSz4YpCAs6n, version: 1785396721076684, type: custom}
```

**The Anthropic turn still does not COMPLETE, and the reason is not skill
delivery.** The request above is answered `400 invalid_request_error: "Error while
communicating with MCP server"` — Anthropic's hosted-MCP relay failing to reach
this instance. That is a public-ingress property of the lane laptop, not of the
code under change: this machine's single Tailscale Funnel :443 slot was already
serving a sibling lane, so the lane instance could only be published on
`:8443`, and Anthropic's relay never issued a request against it (no `POST
/api/mcp` reached the server — only the reachability probe's `HEAD`, 405). The
funnel was removed afterwards; the sibling's was never touched.

So, stated exactly: **`container.skills` delivery ≤ 8 on the first post-wizard turn
is PROVEN on the wire against the real API**; a completed Anthropic answer is
**NOT** proven here, and is blocked by lane ingress rather than by F7.

---

## F11 — the recorded mechanism does not survive isolation

F11 says: *on the wizard's default model (gpt-5.5) the OpenAI path SKIPS the shell
tool entirely, so skill delivery silently doesn't happen.* Grounded against the
code and re-measured on the wire, **the premise is false**, in two steps:

1. `gpt-5.5` is **shell-COMPATIBLE**. `OPENAI_SHELL_INCOMPATIBLE_MODEL_IDS` is
   exactly `{gpt-5, gpt-5-mini}`, and the retired gate's own committed unit test
   asserted `gpt-5.5 → true`. The default model never tripped the degrade.
2. The absent `type:"shell"` on the wire is **the contract, not a failure**.
   Exec-plane S2's singular-native-shell rule (#1707) emits a hosted shell ONLY for
   an execution-authorized request; a skills-without-execution turn — which every
   `/chat` turn is — mounts the same bundle as the restricted **named
   `skill_file_read` function tool**. A hosted shell on a chat turn would be a
   privilege escalation, not the goal.

The S7 driver asserted a literal `shell` type and its fingerprint collapsed every
function tool to the string `"function"`, so a **delivered** skill tool was read as
**no delivery**. Both are fixed here: the observer now records each tool's `name`,
and `R2` asserts the real contract. The wire, on the shipped default:

```
GREEN2-B-assistant-run  POST /v1/responses 200  model=gpt-5.5
  tools=[{type:mcp}, {type:function, name:"skill_file_read"}, {type:web_search}]
```

`results/GREEN-openai-assistant-run.json` — **6/6 PASS**, including **R1: a real
assistant turn completed on openai** (S7 recorded 3/3 errors), and R2/R2b:
tool-mount delivery, boundary-observed, within the cap.

### The real silent no-delivery, which IS a defect, and IS fixed

The forbidden outcome the finding is reaching for exists one model over. On
`gpt-5` / `gpt-5-mini` the **caller-side** gates — the chat runner's
`shell-skill-gate.ts` and the llm-bridge route — skipped the delivery seam
**entirely**, shipping the turn with ZERO skills behind a `console.warn`. Reachable
from the wizard's own free-text model input and from a legacy persisted
`defaultModel: "gpt-5"`.

Those gates were also **unnecessary**: the adapter already degrades such a request
to `skill_file_read`, so the `400 Tool 'shell' is not supported with gpt-5` they
defended against (#47) cannot reach the wire. Gating at the caller only destroyed
delivery. Both gates are retired; the capability leaf stays the single source of
truth for the ADAPTER's choice, and the module says so.

Proven live on exactly that configuration — the instance's OpenAI `defaultModel`
set to `gpt-5-mini`, then restored:

```
GREEN-B5MINI-assistant-run  POST /v1/responses 200  model=gpt-5-mini
  tools=[{type:mcp}, {type:function, name:"skill_file_read"}, {type:web_search}]
```

`results/GREEN-openai-gpt5mini-assistant-run.json` — **6/6 PASS**, turn answered.
Before the fix this configuration delivered nothing at all and said nothing.

And a delivery that produces **no vehicle at all** is now **LOUD**: the runtime
refuses the turn with an error naming the provider and model, rather than
answering as a skill-less assistant while claiming to be the configured one.

### F9, re-measured

`results/GREEN-openai-arm.json` — **11/11 PASS**, including **B2a: the key was
validated and saved THROUGH THE FORM**. The `read ECONNRESET` F9 recorded did not
reproduce on this run. Nothing here diagnoses it; it is reported as
not-reproduced, not as fixed.

---

## Coverage added

| test | pins |
|---|---|
| `packages/llm/src/__tests__/anthropic-skill-sync-map-process-singleton.test.ts` | the map holder is a per-PROCESS singleton — a fresh module instance sees an already-installed map |
| `src/lib/__tests__/skill-bundle-router-only-seed-heal.test.ts` | the ownership-gated seed guard, every branch of the heal's provenance classifier, the emitted head-guard SQL, and a drift pin on the inlined custom/personal predicate |
| `src/lib/__tests__/integration/skill-bundle-store.integration.test.ts` (+9 cases) | the heal on a REAL Postgres, including a two-transaction READ COMMITTED race in both directions |
| `src/lib/__tests__/setup-readiness-strict-sync-refusals.test.ts` | the wizard refuses to report success over a refused skill, naming each one |
| `src/lib/assistant-runtime/__tests__/skill-delivery-not-model-gated.test.ts` | the delivery seam runs for EVERY model incl. `gpt-5`/`gpt-5-mini`; a no-vehicle delivery refuses the turn; a system-context-only delivery is still a valid delivery |

Two existing fixtures (`execution-provenance-turn`, `scripted-widget-turn`) stubbed
skill delivery as returning nothing — a shape the real adapter never produces for a
turn whose contract resolved skills. Under the new loud refusal that stub aborted
those turns before their own subject. Both stubs now return the vehicle the real
OpenAI adapter returns.

## Not claimed

* a **completed** Anthropic answer (blocked by lane ingress — see above);
* any diagnosis of F9's ECONNRESET;
* **F8** (no durable per-run delivery record on the chat surface) is untouched and
  still open — #2240. Delivery here is asserted from the **wire**, exactly as the
  S7 round did.

## Pre-existing red on main — RESOLVED by the rebase

The first round of this branch was based on `origin/main` @ `20b51de6c`, which was
already failing its own **Typecheck and unit tests** check (the #2236/#2235
exec-plane voucher wiring, and a writer-inventory test reading a route #2229 had
deleted). This branch is now rebased onto `e5fa33161`, which carries the #2243
hotfix for both. The scopes below are green with nothing excluded.

---

## Codex — six rounds, ending **MERGE-SAFE**

Converged with Codex read-only over STDIN, one round per revision of the diff.
Round 1 (`gpt-5.1-codex-max`) produced the two blockers this round exists to fix;
rounds 2–6 (`gpt-5.6-sol`) reviewed the fix and each found something the round
before had not. Every finding was adopted except the three in round 5, which were
rebutted with evidence and the rebuttals accepted in round 6.

Codex cleared, and continued to clear, the two things this lane most wanted
challenged: retiring the F11 caller-side gates cannot reintroduce #47 (*"both
OpenAI `generate()` and `stream()` pass tools through `translateTools`, which
emits native shell only when `sandboxTool && shellCapable`"*), and the loud
refusal is *"appropriately scoped to OpenAI/Anthropic with resolved skills."*

| round | finding | outcome |
|---|---|---|
| 1 | **B1** — the heal keyed on manifest CARDINALITY, which cannot tell the defective seed from a DELIBERATE custom/personal bundle-of-one | ADOPTED → durable row provenance |
| 1 | **B2** — the head guard was a correlated `NOT EXISTS` over `skill_revision_files`, not race-free under READ COMMITTED; zero manifest rows read as "router-only" | ADOPTED → target-row CAS; exact-count classifier |
| 1 | #3 reset/registration divergence, #4 overclaiming comments | ADOPTED in round 1 |
| 2 | the classifier read the MUTABLE `skills.active_revision_id`, which a lifecycle "pure state re-record" moves without touching the head — state the head CAS cannot protect | ADOPTED → condition removed; classification rests on rows the CAS covers |
| 3 | **B1 re-opened**: `core__0029` seeded a NULL-stamped `migration` revision for exactly the pre-S1 CUSTOM/PERSONAL skills, so one reaches the seed with the same row shape a derived one does; disk residue then makes it look multi-file | ADOPTED → condition 0 (ownership) |
| 3 | "append-only inputs cannot change" is an overclaim — new manifest PATHS can be INSERTed under an existing revision | ADOPTED as a correction to the CLAIM (no shipped writer appends to a legacy lifecycle revision) |
| 3 | `changed` over-reports under two concurrent identical captures | ADOPTED as a contract correction — it is a reporting bucket, not an authority fact |
| 4 | the multi-file seed SKIP applied to custom/personal skills too, so a FIRST capture with residue on disk installed a disk-derived head with no head to guard against — no race involved | ADOPTED → the skip is itself gated on ownership |
| 4 | the ownership read is MUTABLE and `compileAndRegisterAgentSkillsViaPg` flips `payload` with a bare `UPDATE` that writes no revision and no head, which a head-only CAS misses | ADOPTED → the CAS locks and re-checks the classified payload in the same statement |
| 5 | B4b "not closed" (payload writer commits SECOND) | **REBUTTED** — that is the serial order `[heal, CLI]`; the heal was correct at its serialization point. Accepted in round 6 |
| 5 | B4a "not closed" (lifecycle revision with no durable content blob) | **REBUTTED** — verbatim `origin/main` behaviour, deliberate and documented. Accepted in round 6 |
| 5 | CLI-created custom rows bypass the seed | **REBUTTED** — verbatim `origin/main` behaviour, and the writer COMPILES from disk, so there is no DB content to be authoritative. Accepted in round 6 |

Round 6 verdict, verbatim: *"I see no remaining REGRESSION FROM MAIN introduced by
this diff. The payload-only CLI writer and missing-content lifecycle rows are
surrounding-design concerns suitable for follow-up issues, not blockers for this
targeted fix."* → **MERGE-SAFE**.

### The heal, as it now stands

The head is replaced only when ALL of these hold, and only when the on-disk bundle
ships more than one file:

| # | condition | why it is durable |
|---|---|---|
| 0 | the skill is NOT custom/personal | the canonical marker set (`packageId LIKE 'custom:%'` / `isCustomSkill` / `isPersonal`) — the same predicate `core__0029`'s backfill used to decide who gets a lifecycle revision. Decides WHOSE authority is at stake. Fail-closed on an unparseable payload |
| 1 | the head is authority-owned (no `bundle:` prefix) | a derived head takes the ordinary path |
| 2 | a `skill_revisions` row + a `skills` row exist | inner joins; no row ⇒ no heal |
| 3 | that revision's `bundle_digest` IS NULL | `skill_revisions` is append-only, so the column can only be set at INSERT — and the lifecycle write stamps it for EVERY write that records a file set. A manifest under a NULL-stamped revision cannot have come from the lifecycle path |
| 4 | its `source` is not `'rollback'` | a rollback legitimately carries a NULL digest when restoring a pre-S1 target; it is a deliberate authority decision |
| 5 | its manifest is EXACTLY one row, and that row is `SKILL.md` | zero rows is an unresolvable head, not a seed |

Conditions 1–5 identify the WRITER of that manifest by elimination: only the
lifecycle write (excluded by 3), the rollback (excluded by 4) and this seed ever
write manifest rows under a non-`bundle:` revision id, and `core__0084` ships no
backfill. Condition 0 then establishes that healing it is the right thing to do.

The write is a compare-and-swap over BOTH mutable inputs — the head row's own
`(revision_id, bundle_digest)`, and the classified `skills.payload`, locked and
re-checked with `FOR UPDATE` in the same statement. Lock order is
`skills` → `skill_bundle_heads`, matching the lifecycle write and the rollback CTE.

### Proof of the heal (real PostgreSQL 18.4)

`src/lib/__tests__/integration/skill-bundle-store.integration.test.ts` — **20/20**,
run with `CINATRA_DB_INTEGRATION_TESTS=1` against a real server:

* **heals** a head produced by the REAL seed path, and is idempotent on re-capture;
* **does not heal**: a post-S1 deliberate custom/personal bundle-of-one; a PRE-S1
  `core__0029` custom/personal skill whose first capture already sees disk residue;
  a rollback head; a zero-manifest head; a head naming no lifecycle revision;
* **still heals** after a lifecycle pure-state-re-record moves `active_revision_id`;
* **CAS vs a real transaction race** — T2 (lifecycle) `BEGIN` + head/manifest write;
  T1 issues the guarded upsert and BLOCKS on the row lock; T2 `COMMIT`; T1 wakes →
  the CAS writes **0 rows** and the lifecycle head survives;
* **the retired subquery guard CLOBBERS** under the identical interleaving — codex
  B2 reproduced on the real server, then closed;
* **the payload CAS** refuses when the skill enters the custom class underneath it.

`src/lib/__tests__/skill-bundle-router-only-seed-heal.test.ts` — **25/25**, no DB:
the emitted SQL shapes (including a structural pin that no guard resolves its
CONFLICT with a subquery), every classification branch, and a drift test pinning
the inlined custom/personal predicate to the canonical one in `packages/skills`.

### Green, on the rebased base

| scope | result |
|---|---|
| `@cinatra-ai/llm` | 526 passed, 1 skipped |
| `src/lib` + `src/app/api/llm-bridge` + `src/app/api/chat` | 9272 passed, 22 skipped, **0 failed** |
| `skill-bundle-store` integration (real DB) | 20 passed |
| typecheck (`tsgo`), eslint, `postgres-sync-inventory --check`, file-size + route-graph + schema-migration + skill-packaging gates | clean |

### Not re-driven this round

The full live wizard + provider re-drive above was NOT repeated: the live GREEN
already exists on the same logical change, and what changed since is heal SAFETY,
which is proven on a real database rather than on a real provider. Everything under
"Not claimed" still stands.

---

# POST-MERGE RE-RUN — the two arms, driven again on `main` after #2254 / #2246 / #2249 landed

Everything above this line is the pre-merge record and is unchanged. This section
is a **new run**, on **post-merge `main`**, of exactly the two arms the S7 round
recorded as failed. It uses the SAME committed drivers, a fresh instance, and the
real provider APIs.

**Headline, stated before the detail so it cannot be missed.**

* **OpenAI — the assistant run is GREEN: 6/6.** A real turn completed on the
  shipped default model with tool-mount delivery on the wire, boundary-observed,
  and nothing on the wire exceeding the cap (the ≤ 8 itself is contract-enforced
  before delivery, not counted on the wire — see R2b). The OpenAI **wizard** arm around it is **11/12**: **F9
  reproduced** — the key still cannot be saved through the form.
* **Anthropic — FAILED.** On a fresh instance whose catalog was registered
  through `registerColocatedWorkspaceSkills` → `registerExtensionSkill` →
  `upsertSkill` — the writer the dev boot scan uses, and the same one a
  production-reachable lazy resolver uses (scope note below); the same way S6, S7
  and the pre-merge fix-verification instance were all built — the readiness saga
  **refuses to complete at all** (6 skills refused by the packaging gate), so no receipt is
  issued and the post-wizard turn cannot be driven as one. Driven anyway as a
  diagnostic, the turn still throws `AnthropicSkillNotSyncedError`. The evidence
  is consistent with **F7-1 fixed** and **F7-2 NOT fixed for an instance
  registered through that writer** — both of F7-2's guards are gated off there.
  Mechanism below. The separate `syncInstalledSkillsToDatabase` install path was
  **not exercised** by this run and nothing here is claimed about it.
* **The ingress gate the prior round never reached is now CONFIGURED and
  EXERCISED.** The funnel is on the standard :443 slot, the endpoint answers from
  the public internet, the instance's public MCP base URL is set, and the MCP
  transport **served 4 requests during the boot in which the OpenAI turn
  completed, and 0 in the two boots where no model-inference turn ran**. Reading
  those four as the provider relay calling back is an **inference** (basis below),
  not a captured request identity. It was Anthropic's *turn* that never got that
  far, not the ingress.

## Where this ran

| | |
|---|---|
| base | `origin/main` @ **`fa0503c72`** — contains #2254 (`eff336119`, F7/F11), #2246 (`e646347d8`, F10 + F9-core) and #2249 (`cab30ca89`, suite wiring). `main` advanced to `6cf22be5a` *after* the run began; the run is pinned at `fa0503c72` |
| runtime | **production**: `next build` (`BUILD_EXIT=0`) + `next start`. Not a dev boot — but see "Lane deviations" for how the schema and catalog were bootstrapped |
| database | a **fresh** lane Postgres **18.4** on a lane-unique port; Better Auth schema via `pnpm auth:migrate`, then **73 core migrations EXECUTED** — each one's `### MIGRATION … (UP) ###` line is committed in `results/POSTMERGE-core-migrations-executed.txt`, which the ledger-fake path does not emit — → **160 tables**, **28 catalog skills** |
| instance state | genuinely pre-setup: zero provider/consent/sync rows. The operator account was created through the real sign-up form and auto-promoted to `admin` |
| extension universe | **111/111** repos at the SHAs in the committed locks (`sync-dev-extensions --pinned`, exit 0), with the SAME single recorded exception as S6/S7: `anthropic-connector` at `e0a6c09`, **off-pin** (finding **F12** — the lock still pins `9783123`, on which readiness cannot start) |
| provider boundary | **NOT STUBBED.** Real `api.anthropic.com` / `api.openai.com` with the org keys; the `node --import` preload only OBSERVES |
| ingress | Tailscale Funnel on the **standard :443**, **path-scoped to `/api/mcp` only**; `connector_config:mcp_server.publicBaseUrl` set BEFORE boot. Full record: `results/POSTMERGE-mcp-ingress.txt` |
| live-API hygiene | **22/22** lane-uploaded skills reclaimed, **46** versions deleted, **0** indeterminate — `results/POSTMERGE-live-api-cleanup.json` |
| provenance | re-measured in `results/POSTMERGE-lane-setup-manifest.txt` |

## The table, extended

The two columns on the left are the pre-merge record above. The third is this run.

| | before the fix (S7) | after the fix, pre-merge lane instance | **POST-MERGE, fresh instance (same registration writer)** |
|---|---|---|---|
| Anthropic wizard arm | probe fails on `function-tools` (by design) | **17/17 PASS** | **9 PASS / 8 FAIL** — the saga never reaches the probe: it **refuses at `initial-sync`** |
| skills uploaded by the saga | 22 of 28 | **28 of 28** | **22 of 28**; the other **6 REFUSED** by the packaging gate |
| `syncedSkillCount` on the receipt | 22 | 28 | **no receipt is issued at all** |
| heads for the multi-file skills | router-only, authority-owned | `bundle:` heads with 6 / 5 / 8 files (healed) | **router-only, authority-owned — the heal cannot fire** |
| `/chat` turn on Anthropic | `AnthropicSkillNotSyncedError` naming **5** skills, 0 `/v1/messages` | reaches the provider; `container.skills` × 5 on the wire | `AnthropicSkillNotSyncedError` naming **3** skills, **0 `/v1/messages`** (3/3 attempts) |
| `/chat` turn on OpenAI | errored; delivery read as absent | answered; `skill_file_read` on the wire | **answered on attempt 1**; `skill_file_read` on the wire; **6/6 PASS** |
| OpenAI key saved through the form | **FAIL** — `read ECONNRESET` (F9) | PASS — not reproduced | **FAIL — `read ECONNRESET` REPRODUCED** |

---

## Arm 1 — ANTHROPIC: **FAILED**, and where exactly

`results/POSTMERGE-anthropic-arm.json` (9 PASS / 8 FAIL) ·
`results/POSTMERGE-anthropic-assistant-run.json` (1 PASS / 6 FAIL) ·
`screenshots/POSTMERGE-A-initial-sync-refusal.png`

### What the wizard does now, and why that part is CORRECT

A1–A3 pass exactly as before: both providers offered, Gemini absent, the pick
persisted, **22 skills uploaded LIVE** — `ledgers/egress-postmerge.jsonl` records
**22 × `POST /v1/skills → 200`** in phase `A-readiness-run-1`, and 22
`anthropic_skill_sync` rows behind them — plus **24** bulk-consent rows. Then the
saga **stops**, with the loud refusal #2254 added
(`results/POSTMERGE-readiness-last-failure.json`, verbatim):

```
step: initial-sync
The initial skill upload to Anthropic did not complete: 6 skill(s) were REFUSED
by the packaging gate and were not uploaded, so requests that select them would
fail: @cinatra-ai/chat:chat-automation-authoring (router references no bundled
references/create-campaign.md, references/chat-campaign-creation.md,
references/create-trigger.md, references/chat-workflow-authoring.md); @cinatra-
ai/web-resear
```

**That refusal is the fix working.** Pre-#2254 this instance would have reported
*"AI setup complete — 22 skill(s) uploaded"* over the same six refusals. It no
longer masquerades. The driver's A4a/A4b assert the *older* failure shape (the
`native-skills-probe` refusal), so they score FAIL here for the right reason: the
saga never gets that far. A5a and A6a–A6e then fail as consequences — no
`mcpMode` flip control is rendered, no receipt, no committed default. **A5b
PASSES**: nothing fabricated a readiness that did not happen.

### Why the six are refused

`results/POSTMERGE-bundle-head-provenance.txt` — every catalog skill, its bundle
head, that head's manifest size, the head revision's provenance and the payload
class. `results/POSTMERGE-head-shape-histogram.txt` collapses **all 28 rows** (not
a sample) into distinct shapes, and there is exactly **one**:

```
  28   head_manifest_files=1 | source=manual | bundle_digest IS NULL=f | packageId LIKE 'custom:%'=t | head = skills.active_revision_id=t
```

Against that, the disk ships **six** multi-file bundles (router + `references/*`):

```
6  chat-assistant-core        8  chat-extension-authoring   5  chat-automation-authoring
4  blog-writing               4  list-curation              3  web-research
```

**Six multi-file bundles on disk; the product reports exactly six refusals.** The
stored failure message is TRUNCATED by the product, so the committed artifact
names only the first two of the six (`chat-automation-authoring` and a truncated
`@cinatra-ai/web-resear…`) — both of which are in the multi-file set. The
six-to-six identity is therefore a **count match plus two confirmed members**, not
a full name-by-name mapping; the remaining four are not named in any artifact this
run captured.

The mechanism, end to end. Steps 1–2 and 4–5 are read from committed source on
`origin/main`; step 3 and the ordering are the reading those measurements support,
not separately instrumented (see "What is inferred" below). None of it is
introduced by #2254:

1. `registerExtensionSkill` (`packages/skills/src/register-extension-skill.ts`)
   calls `upsertSkill` with the router's **content only**, and mirrors
   `references/**` to disk **afterwards**;
2. every `upsertSkill` lifecycle write records a **bundle of ONE**
   (`packages/skills/src/skill-source.ts` — `bundleFiles: [{path:"SKILL.md", …}]`,
   unconditional whenever content + digest exist) and therefore stamps a
   **non-NULL** `skill_revisions.bundle_digest` at INSERT
   (`buildRevisionBundleQueries` explicitly does **not** write that column, so a
   non-NULL value can only have come from the revision INSERT);
3. `seedBundleHeadFromLifecycleRevision` finds that manifest already present and
   takes its *"already has a manifest → point the head at it"* branch, so the head
   is **authority-owned with one file**;
4. `captureSkillBundleFromDisk` then classifies every later capture as an
   `authorityOwnedDivergence` and **never advances the head**;
5. S2's fail-closed one-hop lint (#2089) **refuses** each such skill as an upload
   candidate, and #2254's new honesty rule turns that into a **failed setup**.

**Both of #2254's guards are gated off on this instance, by construction:**

| guard | condition it needs | what all 28 rows show |
|---|---|---|
| multi-file **seed skip** | payload is **not** custom/personal | every extension skill registers with `packageId = "custom:<pkg-slug>"` → the predicate says custom → **skip never applies** |
| provenance-gated **heal** | condition 0 not custom/personal **and** condition 3 `bundle_digest IS NULL` | custom **and** digest non-NULL → **two independent misses** |

The heal was built for an instance already damaged by the pre-guard bundle-of-one
seed — heads whose revision carries a NULL digest. An instance registered through
the dev-watcher path never enters that state: it is damaged one step earlier, by
the registration write itself. So the pre-merge GREEN above is not reproducible on
a fresh instance built the way that instance was built, and this run says so
rather than reporting the earlier result again.

**Scope of that statement — corrected twice during review, and it widens rather
than narrows.** `registerColocatedWorkspaceSkills` has **five** direct call sites
in this tree:

* `src/lib/extensions-dev-watcher.ts` × 3 (lines 120, 386, 416) — the dev boot
  scan, which is what registered THIS instance's 28 skills;
* `packages/skills/src/extension-skill-resolver.ts` × 2 (lines 563, 645) — the
  lazy resolvers. The second is reached from `src/lib/assistant-runtime/runtime.ts`
  via `ensureAssistantSkillsRegistered`, which is CALLED on every native-MCP chat
  turn. It is memoized per already-registered skill id, so it does not reach the
  underlying writer on every turn — but it does reach it whenever a required
  skill is not already registered, which is a production path.

So the bundle-of-one lifecycle write is **not a dev-only artefact**: the same
writer is on a production-reachable path. What this run did NOT exercise is the
separate `syncInstalledSkillsToDatabase` install path; whether that one records
the same revision shape is **untested here**, and no claim is made about it.

### The chat turn — driven anyway, as a diagnostic

With no receipt the wizard commits no default provider, so to learn anything at
all about the turn this lane wrote two metadata rows by hand
(`connector_config:llm_default_provider = anthropic`,
`connector_config:anthropic = {"mcpMode":"native"}`) and restarted the server.
**This is an explicitly non-UI diagnostic step and changes no verdict: arm 1 is
FAILED at the wizard.**

3/3 attempts errored with **0 `/v1/messages`** — the refusal happens before the
model-inference call. Stated precisely, because the ledger is not empty for those
phases: the per-turn lazy re-sync DID emit **17** `POST /v1/skills/<id>/versions →
200` across attempts 1–2, so the claim is **zero model-inference calls**, not zero
Anthropic egress. `results/POSTMERGE-F7-server-error-prod.txt`, captured verbatim
from the production server log:

```
AnthropicSkillNotSyncedError: … these catalog skill(s) have no Anthropic sync
mapping yet: @cinatra-ai/chat:chat-assistant-core,
@cinatra-ai/chat:chat-extension-authoring,
@cinatra-ai/chat:chat-automation-authoring
```

**Three names, not five.** The S7 round's identical error named all five,
including `company-research` and `blog-content`, whose sync rows measurably
existed — the symptom of F7-1, the chat request holding the fail-loud default
resolver. Those two are now **absent from the error**, on an instance where they
*are* synced and the other three are not. That is **consistent with F7-1 being
fixed**, and it leaves F7-2 as the defect the error now names. It does not by
itself exclude other latent defects on that path; no turn got far enough to
exercise them.

---

## Arm 2 — OPENAI: the assistant run is **GREEN**

`results/POSTMERGE-openai-arm.json` (11 PASS / 1 FAIL — the wizard arm) ·
`results/POSTMERGE-openai-assistant-run.json` (**6 PASS / 0 FAIL** — the run) ·
`screenshots/POSTMERGE-B-chat-turn-answered.png`

| # | check | verdict |
|---|---|---|
| **R1** | a REAL assistant turn **completed** on openai | **PASS — answered on attempt 1** |
| **R2** | delivery was **TOOL-MOUNT**: a NAMED skill tool on the wire | **PASS** |
| **R2b** | the mounted vehicle carries **no more than 8** skills | **PASS as the driver scores it — but the cap is NOT MEASURED on the wire**; see below |
| R3 | no `container.skills` on the OpenAI path | **PASS** |
| R7 | **ZERO Anthropic egress**, measured from the ledger | **PASS** |
| R8 | the chat surface writes no durable per-run delivery record | **PASS** (finding **F8**, #2240, still open) |

**R2b is not a wire measurement of the cap.** A hosted native shell would carry its
skill listing inline and be countable; the named `skill_file_read` function tool is
a SINGLE vehicle serving the whole set, so `shellSkillCount` is `null` on the wire.
R2b therefore records that a vehicle is mounted and that nothing on the wire
exceeds the cap — the ≤ 8 itself rests on the injection contract enforcing it
BEFORE delivery, which this run did not independently measure.

**A defect in the committed driver, found by this run and NOT patched here.**
`results/POSTMERGE-openai-assistant-run.json` is internally contradictory: `R1`
records that the turn completed, while `R8`'s detail string asserts *"no turn
completed in this arm"*. That string is a **static template** in
`drivers/assistant-run.mjs`, written for the S7 round where no turn ever
completed, and it is emitted unconditionally. The R8 **assertion** is unaffected
(it asserts the row count is zero, and the count was zero); only its prose is
stale. The artifact is left byte-as-recorded rather than edited, and the defect is
recorded here.

The wire record, on the **shipped default model**
(`ledgers/egress-postmerge.jsonl`):

```
POSTMERGE-openai-assistant-run-attempt-1  openai  POST /v1/responses  200
  model=gpt-5.5  stream=true
  tools=[{type:mcp}, {type:function, name:"skill_file_read"}, {type:web_search}]
```

`toolNames` — the extended observer field #2254 added — is what makes "was a skill
tool mounted?" a **measurement**. The S7 round's fingerprint collapsed every
function tool to the bare string `"function"` and so read a delivered skill tool
as no delivery; this run records the name, and the name is there.

One turn, one provider call, answered. No retry loop was needed.

### F9 REPRODUCED — the OpenAI key still cannot be saved from the form

`B2a` **FAIL**: the form save lands on `/setup/ai?error=read%20ECONNRESET`. The
pre-merge fix-verification run recorded F9 as *not reproduced*; on this fresh
post-merge instance it **reproduces**. `B2b` passes — the attempt **does** reach
the live OpenAI validation boundary (2 × `GET /v1/models` recorded in that phase),
so the request is made and the connection is reset, rather than never leaving. The
arm then continues from the seeded credential row and records `credentialPath`
accordingly; nothing here claims a form save that did not happen. No diagnosis is
offered, and nothing here attributes the reset to the product rather than to this
network path — this is a re-observation, not an isolation.

---

## The ingress gate — CONFIGURED and EXERCISED, and exactly how far

Full record: `results/POSTMERGE-mcp-ingress.txt`. In short:

* the machine's :443 funnel slot carried a **dead** handler (`/` → `127.0.0.1:3000`,
  nothing listening, no Next.js process on the machine). It was **not** taken over.
  A second, **path-scoped** handler was added for `/api/mcp` only, on the same
  standard :443 origin, leaving `/` byte-identical;
* public reachability measured from the internet-facing origin: `HEAD → 405`,
  `POST → 401 {"error":"unauthorized"}` — the request reaches the Cinatra MCP
  transport, not a proxy error page;
* `connector_config:mcp_server.publicBaseUrl` was written **before** the server
  booted, so no cached null could survive into the run. Without that row
  `getPublicMcpServerUrl()` returns null and every chat attach site omits the
  hosted MCP tool entirely;
* **what was measured** (`results/POSTMERGE-mcp-requests-served.txt`):
  `[mcp-run-ctx] served-by=` is emitted once per request served by the MCP
  transport — **0** in the Anthropic wizard boot, **0** in the Anthropic
  assistant-run boot, **4** in the boot in which the single OpenAI turn completed,
  a turn whose wire record carries `{type:"mcp"}`;
* **what is inferred from it**: that those 4 requests are the hosted-MCP provider
  relay calling back through the public funnel origin. The basis is that the
  public origin is the only MCP URL any provider was given, and that the two boots
  with no completed turn served zero. This run captured **no per-request access
  log**, so the attribution is the strongest available reading of the counts, not
  a recorded request identity.
* teardown: the handler was removed and `tailscale serve status --json` is
  **byte-identical** to the state captured before the run (verified by `diff`).

**Not claimed:** that *Anthropic's* relay reached this instance. The Anthropic turn never
issued a `/v1/messages` call, so Anthropic's model plane was never handed the URL
(the only Anthropic egress in those boots is the skill-sync `/v1/skills/*` traffic,
which carries no MCP block). That half is blocked
by skill delivery, not by ingress.

---

## Live-API hygiene

`results/POSTMERGE-live-api-cleanup.json` — allow-listed to this lane's own
`cinatra.anthropic_skill_sync` rows, captured to a CSV before the per-arm reset
cleared them, and diffed against the remote list. Anthropic's four built-ins
(`xlsx`, `pptx`, `pdf`, `docx`) were reported and **left untouched**.

| | |
|---|---|
| lane-uploaded skills | **22** |
| versions deleted | **46** (documented versions-then-skill order) |
| skills reclaimed | **22 / 22**, each scored only on a definitive 404 |
| indeterminate | **0** |

## Lane deviations, named — including the ones NOT eliminated

Stated so a reader can discount the verdict themselves rather than take the label
on trust.

1. **`anthropic-connector` off-pin** at `e0a6c09` while the lock pins `9783123`
   (finding **F12**; the same exception S6 and S7 recorded, because readiness
   cannot start on the pinned SHA). Arm 1 fails *before* the connector is reached
   — at the catalog packaging gate — but this run did not re-drive the arm on the
   pinned SHA, so it is not eliminated by measurement.
2. **Node `v22.23.0`**, while CI and the runtime image use **Node 24**. The repo
   declares no `engines` field or `.nvmrc`, so nothing enforced 24 here. The
   failing path is a SQL row shape produced by an unconditional object literal in
   committed source, which a runtime minor cannot vary — but this run did **not**
   re-drive the arms on Node 24, so it is recorded as an un-eliminated deviation
   rather than as ruled out.
3. **Bootstrap order**: the schema, the 73 migrations and the 28-skill catalog
   were created by ONE dev boot; every arm then ran against `next build` +
   `next start`. The dev extension watcher is what registered the skills. That
   writer is shared with a production-reachable lazy resolver (see "Scope of that
   statement"), so the finding is not confined to dev — but the separate
   `syncInstalledSkillsToDatabase` install path was **not** exercised. Every prior
   round in this evidence tree (S6, S7, the pre-merge fix verification)
   bootstrapped the same way, so the comparison between rounds is like-for-like.
4. **Four non-UI steps**, each recorded above and below.

## Steps NOT driven through the UI, each recorded

1. the **Anthropic credential** row (`drivers/seed-provider-credential.mjs`) — the
   same deliberate exception S6 and S7 recorded: the connector's key writer
   hard-requires the connection service, which this lane does not run;
2. the **OpenAI credential** row, after the form save failed (**F9**);
3. `connector_config:mcp_server.publicBaseUrl` — instance ingress configuration,
   written pre-boot so the cache could not serve a stale null;
4. `connector_config:llm_default_provider` + `connector_config:anthropic.mcpMode`
   — written **only** to make the Anthropic chat turn drivable as a diagnostic
   after the wizard refused to issue a receipt. Arm 1's verdict is unchanged by it.

## What is inferred, not measured

* the six refused skills are the six multi-file disk bundles: a **count match**
  plus **two confirmed members**; the product truncates its own message, so four
  names are absent from every artifact here;
* the writer of each one-file revision, and the ORDER in which the seed and
  capture branches ran: read from committed source plus the end-state rows, not
  from per-write instrumentation. No probe was placed inside the running
  registration path;
* that the 4 MCP requests came from the provider relay (basis stated above);
* the OpenAI **≤ 8** half of R2b: the wire carries a single named vehicle with no
  inline skill listing (`shellSkillCount = null`), so the cap is taken from the
  injection contract that enforces it before delivery, not counted on the wire;
* **that F7-1 is fixed**, and that the wizard's refusal is *"the fix working"*:
  both read the post-#2254 behaviour against the S7 round's recorded behaviour on
  a DIFFERENT instance. No pre-#2254 build was re-driven on THIS instance, so
  neither is a controlled before/after on the same state;
* that the fail-closed one-hop lint is the *exclusive* cause of the six refusals —
  the product's own message names that reason, and no competing reason was
  observed, but no alternative was independently excluded.

## Not claimed by this run

* a completed Anthropic answer, or `container.skills` ≤ 8 on the wire — **neither
  is proven here**, and the named blocker is F7-2, not ingress;
* anything about the separate `syncInstalledSkillsToDatabase` install path: it was
  not exercised, so arm 1's finding is scoped to the
  `registerColocatedWorkspaceSkills` → `registerExtensionSkill` → `upsertSkill`
  writer this run drove (which is itself production-reachable — see above);
* that Anthropic's hosted-MCP relay can reach this instance;
* any diagnosis of F9's `ECONNRESET`, or any attribution of it to the product;
* any statement about the **pinned** `anthropic-connector` (**F12** stands);
* **F8** (#2240) is untouched: delivery is asserted from the **wire**, as before.

## Follow-up filed

**#2265** — the two pre-existing authority gaps named in #2254's own body: the
payload-only CLI writer (`compileAndRegisterAgentSkillsViaPg`), and a lifecycle
revision whose `content_digest` resolves to no durable blob. Both put a
custom-classed skill under a DERIVED bundle head. The third family member this
run found — `registerExtensionSkill` → `upsertSkill` recording a bundle-of-ONE
lifecycle revision, the mechanism behind arm 1's failure — is cited there as
field evidence but is **explicitly out of scope of #2265**: it belongs to this
issue, #2094 / F7-2.

## Codex round — ten rounds, ending **SOUND**

Converged with Codex read-only over STDIN, one round per revision of this
document. Every finding was adopted; none was rebutted. The verdicts are captured
in the lane's own files, not summarised from memory.

| round | finding | outcome |
|---|---|---|
| 1 | "OpenAI arm GREEN" contradicted the arm's own 11/12; "A5/A6 fail" contradicted `A5b PASS`; several claims (28-row identity, six-to-six mapping, 73 migrations executed, 22 uploaded LIVE) had no attached artifact | ADOPTED — claims split, artifacts attached |
| 2 | the OpenAI results file contradicts itself (`R1` completed vs `R8`'s "no turn completed"); the ingress artifact still said "measured" where the main text said "inferred"; `R2b`'s ≤ 8 rests on a `null` wire count | ADOPTED — driver-text defect recorded, artifact re-scoped, R2b re-labelled |
| 3 | `R2b` still scored as if measured; the ingress artifact still said "establishes"/"CLOSED"; "F7-1 is fixed" and "the refusal is the fix working" were themselves inferences and were not listed as such | ADOPTED |
| 4 | the document generalised to "a fresh install" while naming the production registration path as unexercised | ADOPTED — scoped to the writer actually driven |
| 5 | the "exactly one caller" claim was false | ADOPTED — and it WIDENED the finding: the writer is production-reachable |
| 6 | the call-site count was still wrong (five, not three), and "every native-MCP chat turn" ignored memoization | ADOPTED with exact `file:line` list |
| 7 | **"0 provider calls" / "before egress" is false** — the ledger records 17 `/v1/skills/*/versions` calls during those attempts. The supported claim is 0 `/v1/messages` | ADOPTED — every such phrase re-scoped to the model-inference call |
| 8–9 | the same phrasing survived in the ingress artifact and in the requests-served captions | ADOPTED |
| 10 | — | **SOUND** |

Round 10, verbatim: *"The arm results, provider ledger, bundle-head provenance,
source predicates, ingress-count semantics, cleanup record, and stated limitations
are mutually consistent; no soundness-breaking overclaim remains."*


---

# POST-MERGE RE-RUN #2 — the ANTHROPIC arm, driven again on `main` after **#2285** landed

Everything above this line is unchanged. This section is a **new run**, on
`origin/main` @ **`8c70af9ec`** — the squash of **#2285**, the fix for the defect
the POST-MERGE section above measured and #2274 filed. It re-drives the Anthropic
arm that section recorded as **FAILED**, on a fresh instance, against the real
Anthropic API.

**Drivers used.** The committed drivers, with three changes recorded rather than
glossed: two defect fixes in `drivers/assistant-run.mjs` (a column name that had
never existed, and a stale hard-coded sentence — both detailed below), and one
**new** driver, `drivers/bundle-authority-set-equality.mjs`, for #2274 AC1, which
asks for a property no committed driver measured. `drivers/anthropic-arm.mjs` is
byte-unchanged from the version #2285 shipped.

**Headline, stated before the detail.**

* **The Anthropic arm is GREEN.** Wizard **18 PASS / 0 FAIL**; the readiness saga
  refuses **ZERO** skills at `initial-sync`; **28 of 28** skills upload; a receipt
  is issued with `syncedSkillCount: 28`; the first post-wizard `/chat` turn
  **answers on attempt 1**, delivering **5** `container.skills` references on the
  wire — **≤ 8**, both halves present, **5/5** resolving to real sync mappings.
  Assistant run **7 PASS / 0 FAIL**. The whole run's production server log
  contains **zero** occurrences of `AnthropicSkillNotSyncedError`, against 3/3
  attempts throwing it in the round above.
* **The two lane deviations the POST-MERGE round could not eliminate are gone.**
  `anthropic-connector` ran **ON its committed pin** (`9855687`, checkout ==
  lock) — the **F12 exception was NOT taken**; and the runtime was **Node 24**,
  matching CI and the runtime image.
* **AC1 is measured as SET EQUALITY, not as a file count.** For **all 28** catalog
  skills the head manifest's sorted `(path, content_digest)` set **equals** the
  set computed from the on-disk bundle, against **both** the materialized mirror
  capture reads **and** the `extensions/` source the writer snapshots. The prior
  round's `28 × head_manifest_files=1` histogram is now `22 × 1` plus
  `3, 4, 4, 5, 6, 8`, every row `set_equal=true`, **0** derived heads.
* **Two full runs were driven, and both are committed.** Run 1 exposed a caveat —
  two remote skills an earlier round had left in the shared org workspace were
  **adopted** rather than created. Run 2 was driven after this lane's reclaim
  emptied the workspace; its upload path is **28 × `POST /v1/skills → 200` with no
  `400` and no list call**. Run 2 is the primary record; run 1 is kept committed
  so the elimination is checkable. Full account:
  `results/AC3-two-runs-and-why.txt`.

## Where this ran

| | |
|---|---|
| base | `origin/main` @ **`8c70af9ec`** = the **#2285** squash. Also contains #2254 (`eff336119`), #2246 (`e646347d8`), #2249 (`cab30ca89`) and **#2242** (`2ed4f254c`, the connector re-pin). No rebase; the run is pinned at that commit |
| runtime | **production**: `next build` (`BUILD_EXIT=0`) + `next start` on a lane-unique port |
| database | a **fresh** lane Postgres **18.4**; Better Auth schema via `pnpm auth:migrate`, then **73 core migrations EXECUTED** — every `### MIGRATION … (UP) ###` line committed in `results/AC3-core-migrations-executed.txt`, which the ledger-fake path does not emit → **160 tables**, **28 catalog skills** |
| instance state | genuinely pre-setup: zero provider/consent/sync rows. The operator account was created through the real sign-up form and auto-promoted to `admin` |
| extension universe | **111/111** repos at the committed pins (`sync-dev-extensions --pinned`, exit 0), **with no exception**. `anthropic-connector` checkout `9855687…` **==** the dev-lock pin `9855687…` — **F12 is cured, and this run is the first to exercise the arm on the pinned universe** |
| node | **v24.18.0** — matches CI and the runtime image |
| provider boundary | **NOT STUBBED.** Real `api.anthropic.com` with the org key; the `node --import` preload only OBSERVES |
| ingress | Tailscale Funnel on the **standard :443**, **path-scoped to `/api/mcp` only**; `connector_config:mcp_server.publicBaseUrl` written BEFORE boot. `results/AC3-mcp-ingress.txt`; teardown byte-diff `results/AC3-mcp-ingress-teardown.txt` |
| live-API hygiene | **28/28** reclaimed in EACH run, **0** indeterminate, Anthropic's four built-ins reported and left untouched |
| provenance | `results/AC3-lane-setup-manifest.txt` |

## The table, extended a second time

| | before the fix (S7) | pre-merge lane instance | POST-MERGE (pre-#2285) | **POST-#2285, fresh instance** |
|---|---|---|---|---|
| Anthropic wizard arm | probe fails on `function-tools` | 17/17 PASS | **9 PASS / 8 FAIL** — refused at `initial-sync` | **18 PASS / 0 FAIL** |
| skills refused by the packaging gate | 6 (unreported) | 0 (healed) | **6, reported** | **0** |
| skills uploaded by the saga | 22 of 28 | 28 of 28 | 22 of 28 | **28 of 28** |
| `syncedSkillCount` on the receipt | 22 | 28 | **no receipt at all** | **28** |
| heads for the six multi-file skills | router-only, authority-owned | `bundle:` heads (healed) | **router-only, frozen** | **authority-owned, manifest == disk (set-equal)** |
| `/chat` turn on Anthropic | `AnthropicSkillNotSyncedError`, 0 `/v1/messages` | reached the provider, turn did not complete | `AnthropicSkillNotSyncedError`, 0 `/v1/messages` (3/3) | **answered on attempt 1**; `container.skills` × **5** on the wire |
| `anthropic-connector` | off-pin (F12) | off-pin (F12) | off-pin (F12) | **ON-PIN — no exception** |
| node | 22 | 22 | 22 | **24 (matches CI)** |

---

## AC1 — the head describes the REAL bundle, by set equality

`results/AC3-bundle-authority-set-equality.json` · `results/AC3-head-shape-histogram.txt`
· driver `drivers/bundle-authority-set-equality.mjs`.

#2274 AC1 is explicit that rejecting `head_manifest_files = 1` is *necessary but
not sufficient* — it would pass a head shipping two of five files. So this
compares **digests**, per skill:

```
catalog skills                               : 28
(path,digest) SET EQUAL vs canonical mirror  : 28/28
(path,digest) SET EQUAL vs extensions/ source: 28/28
multi-file disk bundles                      : 6
```

Two disk sides are compared because the writer and the capture read **different**
directories and both have to agree: the materialized mirror under
`data/skill-store/…` that `captureSkillBundleFromDisk` reads and the packaging
gate lints, and the `extensions/<vendor>/<pkg>/skills/<slug>/` source the
registration writer snapshots.

The histogram, over **all 28 rows**, not a sample:

```
 22  head_manifest_files=1 | disk_files=1 | set_equal=true | packageId LIKE 'custom:%'=true | derived_head=false
  2  head_manifest_files=4 | disk_files=4 | set_equal=true | ...
  1  head_manifest_files=6 | disk_files=6 | set_equal=true | ...
  1  head_manifest_files=5 | disk_files=5 | set_equal=true | ...
  1  head_manifest_files=8 | disk_files=8 | set_equal=true | ...
  1  head_manifest_files=3 | disk_files=3 | set_equal=true | ...
```

Compare the POST-MERGE round's single shape, `28 × head_manifest_files=1`. The six
multi-file bundles are now **named**, not counted: `chat-extension-authoring` (8),
`chat-assistant-core` (6), `chat-automation-authoring` (5), `blog-writing` (4),
`list-curation` (4), `web-research` (3). The POST-MERGE section's "the six
refusals ARE the six multi-file bundles" was labelled INFERRED — a count match
plus two confirmed members. It is now a per-skill identity.

**What the probe is, exactly.** Plain node re-implementing the walk
`readSkillDirectoryAsBundleFiles` performs (recurse from the router's directory,
skip symlinks and `.git`/`node_modules`, POSIX relative path,
`content_digest = sha256(raw bytes)` — the equality the table's own CHECK
constraint enforces). It is a **replica**, not the product function, because the
driver has no bundler/alias resolution.

**What this does and does not establish — corrected after codex review.**

* MEASURED: the END-STATE equality above, and that **0** of the 28 heads carry the
  derived `bundle:` prefix while all 28 head revision ids are **distinct**.
* NOT measured, and therefore not claimed: *which statement wrote each head*, or
  that a capture ever ran and no-op'd. That is execution history; no probe was
  placed inside the running registration path. #2274 AC7 asks which option was
  taken — the diff #2285 shipped is **option A (writer-owned)**, read from
  committed source, and the end state here is **consistent with** it: authority-
  owned heads whose manifests equal the disk. That is a source-read plus an
  end-state measurement, not a trace.
* The packaging gate refusing zero (below) is an **independent, product-side**
  corroboration of a **different, weaker** property: that every router's one-hop
  references resolve inside its stored manifest. It is exactly the property that
  was false before — routers pointing at `references/*` a bundle-of-one never
  shipped — but it is **not** a proof of digest equality, and an earlier draft of
  this section wrongly called it a stronger one.

## AC2 — ZERO refusals at `initial-sync`, enforced by the product

`results/AC3-readiness-receipt.txt` · `results/AC3-anthropic-arm.json`

This is not asserted by the driver. `src/lib/setup-readiness-ports.ts` **throws**
at `initial-sync` whenever `captureDiagnostics.refusedForDanglingReferences` is
non-empty — the #2254 honesty rule that turned this instance class red in the
first place. This run reached the **`native-skills-probe`** on readiness run 1 and
a **receipt** on readiness run 2, both strictly *after* `initial-sync`, so that
array was **empty on both runs**. The reported synced count equals the catalog
count: `syncedSkillCount: 28`, `cinatra.skills` = 28, `anthropic_skill_sync` = 28.

The S2 one-hop lint (#2089) is **unchanged and still fail-closed**. It stopped
refusing because the bundle it lints is now correct, not because the gate moved.

## AC3 — the arm

### The wizard: 18 PASS / 0 FAIL

`results/AC3-anthropic-arm.json` · `screenshots-ac3/`

| # | check | verdict |
|---|---|---|
| A1a–A1c | both eligible providers offered; **Gemini absent** | PASS |
| A2a–A2c | Anthropic form + matcher constraint; pick persisted | PASS |
| A3a | strict catalog sync uploaded skills LIVE — **28 sync rows** | PASS |
| A3b | bulk consent recorded — **24 rows** | PASS |
| A4a | a `function-tools` instance fails the **native-skills probe** actionably | PASS |
| **A4a-step** | **the refusal is the PROBE, not an earlier packaging refusal at `initial-sync`** | **PASS — `step=native-skills-probe`** |
| A4b | the performable fix-forward control renders | PASS |
| A5a/A5b | the UI control flips the stored `mcpMode` to `native`; readiness is not fabricated | PASS |
| A6a–A6e | valid receipt on the real API, `mode: container-skills`, `syncedSkillCount: 28`, default committed | PASS |

The receipt, verbatim:

```
{"receiptVersion":1,"provider":"anthropic","completedAt":"2026-07-31T03:09:22.400Z",
 "fingerprint":"665c8c373cbe0862.de1f504c2a2c2b14",
 "probe":{"accepted":true,"mode":"container-skills",
          "skillId":"skill_01XwvexDY9D6rqKckB2jSNrd","version":"1785467317144363",
          "disposable":false},
 "syncedSkillCount":28}
```

**A4a-step is #2274 AC4, and this is the run it was built for.** #2285 added it so
a FAIL would be *diagnostic* rather than shape-blind: it asserts the saga got
**past** `initial-sync` and reached the probe. On pre-#2285 `main` it would score
FAIL naming `step=initial-sync`. Here it PASSES, naming the step. The A4a
expectation itself was deliberately **kept** — a `function-tools` instance
*should* fail the native-skills probe — and A5's fix-forward flip then exercises
the success arm, exactly as #2274 AC4 required.

### The post-wizard assistant run: 7 PASS / 0 FAIL

`results/AC3-anthropic-assistant-run.json` ·
`screenshots-ac3/AC3-A-attempt-1-answered.png`

| # | check | verdict |
|---|---|---|
| **R1** | a REAL assistant turn **completed** on anthropic | **PASS — answered on attempt 1** |
| **R2** | delivery was **CONTAINER**-based (`container.skills` on the wire) | **PASS — 5 refs** |
| **R3** | the injected set on the wire is **≤ 8** | **PASS — `containerSkillCount=5`** |
| R4 | every reference carries BOTH halves (`skill_id` + `version`, `type:custom`) | PASS |
| R5 | each delivered reference resolves to a real `anthropic_skill_sync` mapping | **PASS — 5/5 mapped** |
| R6 | container mechanism ONLY — no function-tool skill fallback | PASS |
| R8 | **`agent_run_skills_used` rows carrying a `delivery_mode` = 0 at end of arm** | PASS — **F8 (#2240) still open** |

The wire record (`ledgers/egress-ac3.jsonl`):

```
AC3-anthropic-assistant-run-attempt-1  anthropic  POST /v1/messages  200  model=claude-sonnet-4-6
  hasContainer=true  containerSkillCount=5
  {skill_id: skill_01X2bC6ufCgAqgymmS7Vuk4Y, version: 1785467323866571, type: custom}
  {skill_id: skill_015PR88YtAfF7Nyie9FwG7fp, version: 1785467326648942, type: custom}
  {skill_id: skill_018BmCGAbFHriU3GLAAYo6HT, version: 1785467322052810, type: custom}
  {skill_id: skill_01NamPHEiZq1Rv1MT1zBLuhW, version: 1785467340064700, type: custom}
  {skill_id: skill_01FofiitU8UHUMRSoAGVyEGz, version: 1785467320784789, type: custom}
  toolTypes = ["code_execution_20250825","web_search_20250305","mcp_toolset"]
```

**R3 is a WIRE measurement of the cap**, unlike the OpenAI arm's R2b: the Anthropic
path enumerates its skills inline in `container.skills`, so the count is read off
the request the provider was handed, not taken from the injection contract.

**R8, scoped exactly.** What is measured is a single global count:
`agent_run_skills_used` rows with a non-null `delivery_mode` = **0** at the end of
the arm, on a run in which a turn DID complete. It does not establish that no
durable record of the delivery exists anywhere in the product in any form; F8's
primary evidence remains the static write-path review recorded above, and #2240
stays open.

### `AnthropicSkillNotSyncedError` did not occur

`results/AC3-no-skill-sync-error.txt` — counted over the **whole** production
server log for this run (310 lines, boot → signup → both readiness runs → the chat
turn), not over the one successful attempt:

```
occurrences of 'AnthropicSkillNotSyncedError' : 0
occurrences of 'no Anthropic sync mapping'    : 0
occurrences of the #1699 ingress refusal      : 0
```

Scope: an absence over this server's own stdout/stderr for this run. It is not a
proof that the error is unreachable — only that it did not fire here, where the
two prior rounds fired it on every attempt.

### The whole upload path on the wire

`ledgers/egress-ac3.jsonl` — **30** provider calls, every one real:

```
 28  A-readiness-run-1                      anthropic  POST /v1/skills     200
  1  A-readiness-run-2                      anthropic  POST /v1/messages   200   <- container.skills probe, accepted
  1  AC3-anthropic-assistant-run-attempt-1  anthropic  POST /v1/messages   200   <- the turn, container.skills x5
```

**What that supports, at exactly its strength.** 28 create calls, all `200`; **no
`400`** and **no `GET /v1/skills`** anywhere — and the only reason the client
issues that GET is to reconcile a create conflict
(`packages/llm/src/tools/anthropic-custom-skills-client.ts`), so **no skill was
adopted; all 28 remote identities were created by this run.** Corroborated by the
reclaim: the workspace held only Anthropic's 4 built-ins immediately before run 2
(`results-ac3-run1/AC3R1-live-api-cleanup.json`, `remoteSkillsRemainingTotal: 4`),
and at reclaim time it held those 4 plus exactly the 28 rows in this run's sync
table.

**What it does NOT support:** the BYTE CONTENT of what was uploaded. The observer
deliberately records no request body, and a multipart upload fingerprints as
`{nonString:true}`, so nothing here measures that the zip Anthropic received was
built from the 52 manifest rows. An earlier draft said "created from this run's
own packaged bundle"; the supported half is **created, not adopted**.

**Also measured: no `/v1/skills/*/versions` call at all** — the per-turn lazy
re-sync the S7 and POST-MERGE rounds leaned on issued nothing. Reading that as
"there was nothing to catch up on" is an **inference** from the absence, not a
verification of remote bytes.

## AC5 — idempotent under re-registration

`results/AC3-idempotent-reregistration.txt`

Three registration passes ran against one database: the dev boot's watcher scan,
the production server's boot registration, and `ensureAssistantSkillsRegistered`
on the native-MCP chat turn. Row counts after pass 1 and after pass 3 are
identical: `revisions=28 files=52 heads=28 skills=28`.

**Aggregate counts alone would not prove this** — a replacement preserves a count,
as codex pointed out. They are load-bearing here because of three structural facts
read from committed source:

* `skill_revisions` is **append-only at the database level**
  (`trg_skill_revisions_append_only`, BEFORE UPDATE OR DELETE —
  `migrations/core/core__0029_skill-lifecycle.mjs:67`), so 28 → 28 means the SAME
  28 rows and **zero** revisions minted by passes 2 and 3;
* `skill_revision_files` is append-only the same way, so 52 → 52 means the same 52
  manifest rows and **zero** manifest rows written by passes 2–3;
* a **derived** head writes its manifest under a `bundle:<digest>` revision id,
  which would ADD rows to that append-only table. None were added — so no derived
  manifest was ever written *at any point*, not merely at the end.

With 28 append-only revisions across 28 skills and 28 **distinct**, non-derived
head revision ids, each skill has exactly one candidate revision its head can
point at. There is nothing for a head to have moved to and back from.

**Still not measured:** `skill_bundle_heads` is a mutable pointer table with no
append-only trigger, and this lane did not snapshot `(skill_id, revision_id)`
row-by-row after each pass. The paragraph above closes that by elimination, not by
a per-row before/after diff. **Scope:** the `llm-bridge` route call site and
`syncInstalledSkillsToDatabase` were not exercised.

## The ingress gate

`results/AC3-mcp-ingress.txt` · `results/AC3-mcp-requests-served.txt`

`[mcp-run-ctx] served-by=` is emitted once per request **served** by the MCP
transport. Counted from this run's production log, in order:

```
after the whole Anthropic WIZARD arm (both readiness runs)            : 0
after 3 public unauthenticated HEAD + 1 public unauthenticated POST   : 0
after the ONE completed /chat turn                                    : 6
```

**What is measured:** those three counts, and that the public origin answers
`HEAD → 405` / `POST → 401` with the Cinatra MCP transport's own error body rather
than a proxy error page.

**What is INFERRED, and codex was right to push on this.** That the six are the
hosted-MCP relay calling back — *and that they are authenticated at all*. Four
specific unauthenticated requests not incrementing the counter shows those four
did not count; it does not prove the six that followed were authenticated, and no
per-request identity, actor or access log was captured. The basis for the reading
is that the public origin is the only MCP URL any provider was handed, that the
whole wizard arm produced zero, and that the delta lands exactly on the single
turn whose wire record carries an `mcp_toolset`. That is a coincidence argument,
not a recorded identity.

Teardown is byte-diffed: `results/AC3-mcp-ingress-teardown.txt` shows `diff`
against the pre-run capture with **no differences**. The machine's pre-existing
`:443 /` handler was never touched.

## Two driver defects, found by this run and FIXED here

Both are in `drivers/assistant-run.mjs`; both are evidence-driver bugs (this
branch touches no product file).

1. **`R5` queried a column that has never existed.** It read
   `cinatra.anthropic_skill_sync.remote_skill_id`; the remote id lives in
   `anthropic_skill_id`. The statement is only reached when a **completed**
   Anthropic turn puts `container.skills` refs on the wire — which no prior round
   achieved (S7's turns threw before egress; the pre-merge GREEN never completed,
   so `refIds` was empty and the loop never ran —
   `GREEN-anthropic-assistant-run.json` records `R5 FAIL 0/0 mapped`). **This run
   is the first to reach it, and it threw**, taking the driver down after R1–R4
   had already scored. Fixed; R5 now reads **5/5 mapped**.
2. **`R8`'s detail string was a static template asserting "no turn completed in
   this arm".** The POST-MERGE round already recorded that as a defect — its
   OpenAI artifact said `R1: answered` and `R8: no turn completed` in the same
   file — and left it. With a turn now completing the sentence is false, so it is
   made conditional. The **assertion** is unchanged: the count must be zero.

## Two runs, and the caveat the second one eliminates

`results/AC3-two-runs-and-why.txt` — the full account. In short:

**Run 1** (`results-ac3-run1/`, `screenshots-ac3-run1/`,
`ledgers/egress-ac3-run1.jsonl`) scored **18/18** on the wizard and **7/7** on the
assistant run — those are the driver's own verdicts and they stand — but its wire
showed `26 × POST /v1/skills → 200` plus **`2 × POST /v1/skills → 400`**, each 400
immediately followed by `GET /v1/skills → 200`. That is the create-time
**display-title collision reconciliation** in
`packages/llm/src/tools/anthropic-custom-skills-client.ts`: on a 400/409 whose
body says the title is taken, the client lists custom skills and **adopts** the
existing remote identity and its `latest_version` rather than minting a duplicate.

The two adopted rows were `list-curation` → `skill_016S7…` (remote `created_at`
**2026-07-30T07:17:03Z**) and `web-research` → `skill_01FML…` (**07:17:04Z**) —
both inside the **pre-merge fix-verification** round's own ledger window
(07:07:28Z–07:56:30Z), a round that uploaded 28 and reclaimed 26.

**So run 1's honest upload account is 26 CREATED + 2 ADOPTED, not 28 uploaded.**
The cleanup table's "lane-uploaded skills = 28" for run 1 is the reclaimer's field
name for *the lane's own sync rows*, and two of those 28 were remote identities
this lane did not create. For those two, run 1 recorded no
`POST /v1/skills/<id>/versions`, so it did not push its own bundle bytes, and
whether the adopted remote content equalled run 1's bundle is **NOT verified**.

**What that does and does not touch.** It does not change the packaging-gate
result (zero refusals, measured before any upload) and it does not touch the
delivered set — all five references run 1's completed turn delivered were skills
run 1 itself created. It DOES mean run 1 cannot support a claim that all six
multi-file bundles were uploaded from this instance's own heads: for two of them
the remote content is unverified. That is the whole reason run 2 exists.

**Run 2 eliminates it by measurement.** Driven on a new fresh instance after the
reclaim had emptied the workspace of every non-built-in custom skill, its upload
path is `28 × POST /v1/skills → 200` with **no 400 and no list call** — every
remote identity created, none adopted. Run 1 stays committed so that elimination
can be checked rather than taken on trust.

### An adjacent observation, recorded and NOT filed by this lane

The reconciliation's own comment states *"the ONLY reason our stable,
per-catalog-skill `display_title` is already taken is a prior create by THIS skill
whose response was lost before the row persisted."* Run 1 is a counter-example:
the title was taken by a **different instance** sharing the org workspace, and the
adopt path takes the existing identity **without comparing remote content to the
local bundle**. On a shared workspace that can bind a catalog skill to stale remote
bytes silently. It is **out of scope of #2274** and of every S7 acceptance item; it
did not change either run's verdict; this lane files nothing and records it for the
coordinator to route.

## Run 1's third assistant run — a failure, recorded rather than dropped

`results-ac3-run1/AC3R1-funnel-coldstart-refusal.txt` ·
`screenshots-ac3-run1/AC3b-A-attempt-{1,2,3}-error.png`

Between run 1's two answered turns this lane drove a third assistant run that
failed **3/3 with zero provider calls**. It is **not** a skill-delivery failure and
**not** `AnthropicSkillNotSyncedError`. The production server refused the turn
before any provider call, with the #1699 ingress-reachability guard:

```
[assistant-runtime] public MCP URL https://<lane-funnel-origin>/api/mcp is unreachable
(no response within 2500ms) — refusing to run the turn without Cinatra tools (#1699)
```

Measured mechanism: `packages/llm/src/mcp-access.ts` probes with a HEAD under a
2500 ms budget, and this lane's Funnel path has a cold start well past it —
`HEAD 1 (cold): 405 in 6.514s`, then `0.544s`, `0.272s` warm. The driver's attempts
are minutes apart, so each re-paid the cold start. Warming the path with
unauthenticated HEADs immediately before the run made the turn answer on attempt 1.
The product's behaviour under a slow ingress is **correct** — it refuses loudly
rather than answering as a tool-less assistant — and nothing here claims the
2500 ms budget is right or wrong for a real deployment. The AC3b run's own results
JSON was overwritten by the next run at the same `LANE_RESULTS` path, so its
verdicts are reported as **observed**; what is artifact-backed is the server-log
refusal and the three screenshots.

## Lane deviations, named — including the ones NOT eliminated

1. **`CINATRA_E2E_SETUP_BYPASS=true`**, carried through byte-for-byte from the
   source env by `drivers/make-lane-env.mjs` (as in every prior round in this
   tree). It makes `isSetupWizardComplete()` return true, so the app shell does not
   redirect `/chat` to `/setup` while this lane's Connections step is incomplete
   (no Nango). It writes nothing: the AI step, its readiness saga, its receipt and
   its committed default provider are all real. **Not eliminated** — without it
   `/chat` is unreachable on this lane.
2. **Four steps not driven through the UI**, listed below.
3. **Bootstrap order**: schema, the 73 migrations and the 28-skill catalog were
   created by ONE dev boot; every arm then ran against `next build` + `next start`.
   Every prior round in this tree bootstrapped the same way, so the comparison is
   like-for-like. `syncInstalledSkillsToDatabase` was **not** exercised.
4. **The OpenAI arm was not re-driven this round.** #2274 scopes F9 out
   explicitly; the POST-MERGE section's OpenAI record stands unchanged, including
   **F9 reproduced**.
5. **The funnel warm-up.** Run 2's turn was preceded by three unauthenticated
   public HEADs to warm the ingress path. Without them the #1699 guard can refuse
   the turn (run 1's AC3b). This is a lane accommodation to a slow public path, and
   it is recorded rather than hidden.

### Steps NOT driven through the UI

1. the **Anthropic credential** row (`drivers/seed-provider-credential.mjs`) — the
   same deliberate exception S6, S7 and both post-merge rounds recorded: the
   connector's key writer hard-requires the connection service, which this lane
   does not run;
2. `connector_config:mcp_server.publicBaseUrl` — instance ingress configuration,
   written pre-boot so no cached null could survive;
3. the funnel handler add/remove (`tailscale serve`), byte-diffed;
4. the pre-run funnel warm-up HEADs.

## What is inferred, not measured

* that the six `served-by` requests came from Anthropic's relay — **and that they
  were authenticated at all**;
* that no `/v1/skills/*/versions` call means there was nothing to catch up on;
* that the AC1 probe's walk matches `readSkillDirectoryAsBundleFiles` exactly — it
  is a documented **replica**;
* *which statement* installed each head, and that a capture ran and no-op'd: end
  state plus a source read of #2285's diff, never a trace;
* run 1's two adopted remote skills being the pre-merge round's un-reclaimed
  residue: a `created_at` inside that round's ledger window plus its 28-uploaded /
  26-reclaimed gap. Run 2 does not depend on this reading.

## Not claimed by this run

* the **byte content** of any upload — no request body is recorded;
* anything about the **OpenAI** arm — not re-driven; **F9** stands as recorded;
* anything about `syncInstalledSkillsToDatabase` or the `llm-bridge` route
  registration call site — neither exercised;
* that Anthropic's relay reached this instance (see above);
* **F8** (#2240) untouched — delivery is asserted from the **wire**, as before;
* **F6** (`GET /v1/skills` pagination, #2237) unchanged;
* AC6's deleted-upstream-reference (stale-file) case — covered by #2285's own
  integration suite, not re-driven live here.

## Live-API hygiene

| | run 1 | run 2 |
|---|---|---|
| lane sync rows in the allow-list | 28 (**26 created + 2 adopted**) | 28 (all created) |
| versions deleted | 28 | 28 |
| skills reclaimed | **28 / 28** | **28 / 28** |
| indeterminate | **0** | **0** |
| remote custom skills remaining | 4 | **4** |

The 4 remaining are Anthropic's built-ins (`xlsx`, `pptx`, `pdf`, `docx`),
reported and left untouched. Reclamation is scored only on a definitive 404
re-read. The org workspace ends this lane **cleaner than it began**: run 1's
allow-list included the two skills a prior round had left behind, so those were
reclaimed too.

## Verdict against the acceptance

| item | verdict |
|---|---|
| **#2274 AC1** — heads describe the real bundles, by SET EQUALITY | **MET** — 28/28 against both disk sides (end state; provenance is a source read) |
| **#2274 AC2** — zero refusals at `initial-sync`, synced count == catalog count | **MET** — product-enforced; 28 == 28 |
| **#2274 AC3** — the Anthropic arm re-driven on a fresh instance and passing | **MET** — 18/18 + 7/7, receipt issued, first turn reaches `/v1/messages`, zero `AnthropicSkillNotSyncedError` in the whole run's log |
| **#2274 AC4** — the driver tells the two refusal shapes apart | **MET** — `A4a-step` PASS, naming `step=native-skills-probe` |
| **#2274 AC5** — idempotent under re-registration | **MET** — three passes, zero revision/manifest writes (append-only + counts + distinct non-derived heads) |
| **S7 item 3a, Anthropic arm** — post-setup assistant run on a real full instance | **MET** — completed turn, container delivery, `container.skills` = 5 ≤ 8 measured on the wire |
| **F12** — the pinned connector cannot complete readiness | **NOT REPRODUCED** — this run is ON-PIN and completes |
| **F7 / F7-2** | **not reproduced on this instance class**, on the writer path that produced it |
| **F8** (#2240), **F6** (#2237), **F9** | untouched, still open |

## Codex round — two rounds, ending **SOUND**

Converged with Codex read-only over STDIN (focused prompts; the first attempt with
the whole document + every artifact inline hung, so it was split). Verdicts
captured to files, never tail-piped. **Every finding was adopted; none was
rebutted.**

| # | round-1 finding | outcome |
|---|---|---|
| 1 | "SAME committed drivers" contradicted the later admission that `assistant-run.mjs` changed and a new driver was added | ADOPTED — a "Drivers used" paragraph now leads the section |
| 2 | zero packaging refusals was presented as a *stronger* proof of digest equality; the lint checks dangling references, not bundle contents | ADOPTED — re-labelled as an independent corroboration of a **different, weaker** property |
| 3 | end-state set equality + absent `bundle:` heads do not establish writer provenance or that capture no-op'd | ADOPTED — provenance is now stated as a source read of #2285's diff plus an end-state measurement, never a trace |
| 4 | 28 successful POSTs prove neither payload contents nor "created from this run's own packaged bundle" | ADOPTED — narrowed to **created, not adopted**; the observer records no request body, and a multipart upload fingerprints `{nonString:true}` |
| 5 | "nothing to catch up on" is a causal inference from an absence | ADOPTED — labelled |
| 6 | AC5 is not proven by equal aggregate counts: a replacement preserves a count | ADOPTED — rebuilt on the **append-only triggers** (`trg_skill_revisions_append_only`, `trg_skill_revision_files_append_only`) plus 28 distinct non-derived head revision ids, with the mutable-head gap named |
| 7 | run 1 is mischaracterized — the supported account is 26 created + 2 adopted, not 28 uploaded | ADOPTED — corrected in the narrative, the hygiene table and the "what it does not touch" paragraph |
| 8 | four unauthenticated probes not counting does not prove the six that followed were authenticated | ADOPTED — **authentication itself** is now listed as inferred, not just relay identity |
| 9 | the whole-run "no `AnthropicSkillNotSyncedError`" claim exceeded the artifacts | ADOPTED — backed by `results/AC3-no-skill-sync-error.txt`, counted over the complete 310-line production log, and scoped |
| 10 | R8's scope was overstated | ADOPTED — limited to the measured non-null `delivery_mode` row count |

Round-2 verdict, verbatim: *"No new material overclaim remains; replica,
provenance, upload-content, ingress, reconciliation, and unexercised-path
limitations are disclosed."* → **SOUND**.
