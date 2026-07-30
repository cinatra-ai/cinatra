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
