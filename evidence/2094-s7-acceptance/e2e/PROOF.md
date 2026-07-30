# cinatra#2094 S7 — acceptance item **3a**, run

The last outstanding block of the S7 acceptance: the **per-provider post-setup
assistant run on a real full instance**. Two prior lanes recorded it honestly as
**NOT RUN** ([report 1](https://github.com/cinatra-ai/cinatra/issues/2094#issuecomment-5123735104),
report 2 on PR #2233). This is that block, driven.

**The headline is not green, and that is the result — not a shortfall of the
run.** The instance was brought all the way up, the Anthropic readiness saga
completed **live against the real API**, and the post-setup assistant run was
then driven on the real `/chat` surface in both a dev boot and a **production
build**. It does not work: on Anthropic the first turn after a wizard that
reports *"AI setup complete"* fails loud, every time. That is finding **F7**, and
it is the thing item 3a existed to find.

## Where this ran

| | |
|---|---|
| host | `origin/main` @ `61e9e798d21d3cd435f4c49e1aca16abdc34fefb` (= the S7-completion squash #2233) |
| extension universe | **111/111** companion repos cloned at the SHAs pinned in the two committed lock files (`sync-dev-extensions --pinned`, exit 0). **One deliberate exception:** the successful Block A run used `anthropic-connector` at `e0a6c09`, **OFF-PIN** — on the pinned SHA readiness cannot complete at all (**F12**). So the 17/17 below is *not* a verdict about the pinned universe |
| database | a **fresh lane Postgres 18** on a lane-unique port. Better Auth schema via `pnpm auth:migrate`, then **73 core migrations applied for real** — not ledger-faked (see "why not `branch setup`") — 160 tables, 28 skills registered |
| instance state | genuinely **pre-setup**: zero provider/consent/sync rows, zero human users. The operator account was created through the real **"Create the first account"** form and auto-promoted to `admin` |
| browser | **isolated** Chromium profile under the lane's own scratch dir (never the shared MCP browser), 1440×1200 @2x, full-page captures |
| provider boundary | **NOT STUBBED.** Real `api.anthropic.com` and `api.openai.com` with the org keys. The `node --import` preload only **OBSERVES** and records — see below |
| runtime | driven on a **dev boot** AND re-driven on a **`next build` + `next start` production server** |
| provenance | every row above is re-measured in `results/lane-setup-manifest.txt` (migrations, tables, skills, operator role, build exit, both connector SHAs) |

### The preload is an observer, not a stub — and that is the delta from S6

S6 had no provider key, so its preload **answered** provider requests from a
scripted table. This lane has the keys, so
`drivers/egress-observer.mjs` **forwards every provider request to the real host**
and merely records it. Consequences worth stating:

* both arms ran **LIVE**;
* the *"the OpenAI path performs zero Anthropic egress"* claim stays a
  **measurement** — the assertion reads the recorded calls — instead of becoming
  an artifact of the stub's own routing.

Ledger records method + a normalized **provider** label + path + status + a
coarse body **fingerprint** (the raw host is not stored).
**Headers are never recorded**: the `x-api-key` / `Authorization` header rides
every one of these calls and this repo is public.

### Why not `cinatra instance branch setup`

The sanctioned generator was read and deliberately **not** used for the DB: on a
fresh schema it **ledger-FAKES** the core migration chain and then **seeds the new
schema from the source schema's business data** (including `metadata`). This
acceptance needs the opposite on both counts — **real** migrations, and a
genuinely **pre-setup** instance whose provider/readiness rows do not exist yet.
`drivers/make-lane-env.mjs` therefore performs the same env transform
programmatically (source env read by the script, never by hand, no value printed)
with the lane's own DB/Redis/port/queue overrides.

---

## Verdicts

### Block A — ANTHROPIC, the wizard arm: **17/17 PASS, LIVE** (off-pin connector — see F12)

`results/anthropic-arm.json`

| # | check | verdict |
|---|---|---|
| A1a–A1c | both eligible providers offered; **Gemini absent** with its connector active | **PASS** |
| A2a–A2c | Anthropic selected → credential form + matcher constraint; pick persisted | **PASS** |
| A3a | **strict catalog sync uploaded 22 skills LIVE** to the real Skills API | **PASS** |
| A3b | bulk consent recorded (**24** rows) | **PASS** |
| A4a/A4b | a `function-tools` instance fails the native-skills probe **actionably**, and the performable fix-forward control renders | **PASS** |
| A5a/A5b | the **UI control** flips the stored `mcpMode` to `native`; readiness is **not** fabricated by the flip | **PASS** |
| A6a–A6e | the saga reaches a **valid receipt on the real API**, `mode: container-skills`, `syncedSkillCount: 22`, default committed | **PASS** |

The receipt is real, not a stub shape:

```
probe: { accepted: true, mode: "container-skills",
         skillId: "skill_01LHhQqvD5WkX7pGNCCtTNwS",
         version: "1785378533400496", disposable: false }
```

`skill_01LH…` is an Anthropic-minted id. S6's equivalent was `skill_lane2093_45`
— its stub's counter. Corroborated on the wire: **22 × `POST /v1/skills → 200`**
in `A-readiness-run-1`, then exactly **1 × `POST /v1/messages → 200`** in
`A-readiness-run-2` carrying both halves of the reference.

**The failing probe emitted ZERO `/v1/messages`.** The connector declined
in-process rather than sending a request that might have "passed" through
emulation — the MCP Injection Rule, observed on the wire, not asserted.

### Block B — OPENAI: readiness live, **zero Anthropic egress MEASURED**: 11/12

`results/openai-arm.json`

| # | check | verdict |
|---|---|---|
| B1a/B1b | OpenAI form renders; the Anthropic matcher-constraint alert is **absent** | **PASS** |
| B2a | key validated + saved **through the form** | **FAIL → F9** |
| B3a–B3c | readiness completed on OpenAI; receipt rendered; default committed | **PASS** |
| **B4a** | **the entire OpenAI setup arm performed ZERO Anthropic egress** | **PASS (measured)** |
| B4b–B4d | no Anthropic upload, no `container.skills` probe, no sync rows written | **PASS** |

Ledger for the arm: **7 OpenAI calls, 0 Anthropic**.

**What B4a does and does not establish — corrected after review.** An earlier
draft argued it was non-vacuous because the Anthropic arm had just run on this
instance. That argument is **wrong and is withdrawn**: the per-arm reset
(`drivers/reset-ai-step.mjs`) deletes the Anthropic credential, receipt and sync
rows, so at OpenAI-arm time Anthropic was **not** locally configured. B4a
therefore proves exactly what it measures — **the OpenAI readiness path emitted
zero Anthropic calls** — and does **not** prove isolation while Anthropic
remained configured and usable. That stronger property is untested here.

### Block C — exact-binding failure visibility: 6/7

`results/exact-binding-failure.json` · `screenshots/C1-exact-binding-failure.png`

Arranged so a silent failover would be both **possible and detectable**: stored
default = **anthropic**, Anthropic credential **removed**, and a **valid OpenAI
credential deliberately left in place** as a failover target.

| # | check | verdict |
|---|---|---|
| C0a–C0c | the arrangement holds (default anthropic, no Anthropic cred, OpenAI cred present) | **PASS** |
| C1a | the assistant surfaces a **visible failure** instead of answering | **PASS** |
| C1b | the surfaced failure **NAMES the stored provider** | **FAIL → F10** |
| **C2a** | **NO SILENT FAILOVER — zero OpenAI egress while OpenAI was available** | **PASS (measured)** |
| C2b | no assistant answer to the prompt was produced | **PASS** |

The load-bearing property — *no silent hop* — is **measured on the wire**, not
inferred from the message: **0 provider calls of any kind** during the failure.

### The assistant run itself — **did not complete on either provider**

`results/anthropic-assistant-run.json` · `results/openai-assistant-run.json`

| provider | turns in the COMMITTED result | reached the provider | outcome |
|---|---|---|---|
| Anthropic | **2** (prod) | **0** `/v1/messages` | fails before egress — **F7** |
| OpenAI | **3** (prod) | 3 × `POST /v1/responses → 200` | turn still errored; skills **not delivered** — **F11** |

**Attempt-count honesty.** Additional failing turns were driven earlier (8 on the
dev boot, plus a first prod pass), but each run **overwrote** the same results
file, so the committed artifacts substantiate only the **2 prod Anthropic** and
**3 OpenAI** attempts above. Every count in this document is the committed one;
the earlier attempts are reported as observed, not as evidence.

So the acceptance's *"container-delivered injection ≤8"* and *"tool-mount
delivery ≤8"* are **NOT PROVEN**, and the reason is a product defect in each
case, recorded below rather than worked around.

> **A false green was caught in this lane's own driver and is recorded because it
> nearly became the result.** The first prod run reported `answered` on attempt 1
> while the page still read **"Thinking"**: the sentinel `ACKNOWLEDGED` appears in
> the breadcrumb *and* the user's own bubble, and `String.replace` strips only
> the first occurrence. Two guards now close that specific hole — every
> occurrence of the prompt is stripped **and** the turn must no longer be
> "Thinking"; and a turn scored `answered` with **zero recorded provider calls**
> is refused outright as `answered-without-provider-call`. Both are in
> `drivers/assistant-run.mjs`. They are **not** a proof of impossibility: the
> match still scans the whole page, so a stale sentinel from an earlier thread
> plus any current provider call could still satisfy them.

---

## Findings

### F7 · **HIGH / release-blocking** · the Anthropic assistant is unusable after a wizard that reports success

On an instance whose wizard renders *"AI setup complete — 22 skill(s) uploaded,
and Claude accepted a `container.skills` request"*, **the first `/chat` turn on
Anthropic fails loud**:

```
AnthropicSkillNotSyncedError: Anthropic skill delivery requires pre-synced Custom
Skills, but these catalog skill(s) have no Anthropic sync mapping yet:
@cinatra-ai/chat:chat-assistant-core, @cinatra-ai/chat:chat-extension-authoring,
@cinatra-ai/chat:chat-automation-authoring, @cinatra-ai/chat:company-research,
@cinatra-ai/chat:blog-content
```

**Every turn driven failed this way**, on BOTH a dev boot and a production
build, with **zero** provider calls — the refusal is before egress. The committed
result records **2/2** prod attempts (see the honesty note above). The production
build was run specifically to test whether this was a Turbopack
dual-module-instance artifact: it is **not** — the defect survives `next build`
(`BUILD_EXIT=0`, `results/lane-setup-manifest.txt`), and the error text is
committed verbatim in `results/F7-server-error-prod.txt` (3 recorded throws).

The timestamps make the gap exact: the receipt completed at **02:29:39Z**, and
the first `@cinatra-ai/chat:*` sync row was not written until **02:38:44Z** —
*during a failing turn*, by the per-turn lazy sync, nine minutes after setup was
declared complete. **The readiness saga's strict catalog sync does not cover the
skills the Cinatra assistant itself requires.** Of the assistant's 5 required
skills, **3 have no sync row under any key** (`diagnose-sync-key.mjs`).

**A second, sharper defect sits inside the first.** The thrown error lists **all
5** — including the 2 that, when measured, **do** resolve:

```
per-skill lookup under the COMPUTED key:
  chat-assistant-core         rowUnderComputedKey=0  rowUnderAnyKey=0  allow=true
  chat-extension-authoring    rowUnderComputedKey=0  rowUnderAnyKey=0  allow=true
  chat-automation-authoring   rowUnderComputedKey=0  rowUnderAnyKey=0  allow=true
  company-research            rowUnderComputedKey=1  rowUnderAnyKey=1  allow=true
  blog-content                rowUnderComputedKey=1  rowUnderAnyKey=1  allow=true

fingerprint MATCHES (hmac) : true
environment MATCHES        : true
```

Both components of the lookup key match, both rows are `stale=false`, and all
five carry `allowAnthropicUpload = true`.

**The leading hypothesis is that the chat delivery path holds the fail-loud
default `UnsyncedAnthropicSkillMap` rather than the table-backed map** — i.e. the
`anthropic-skill-sync-map` boot phase does not cover the chat request path, so
delivery never consults the sync table. **This is NOT isolated, and is not
claimed as proven.** The diagnostic ran in a *separate process* against direct
SQL; it does not exercise the live resolver. `resolve()` also returns `null` when
the global opt-in reads false in-process, when the per-skill flag read throws, or
when the in-process namespace derivation differs — none of which this lane ruled
out. The honest statement is: **consistent with the chat path retaining the
default resolver; mechanism not isolated.** Isolating it needs an in-process
probe of the live resolver, which this lane did not build.

> **The diagnostic output is NOT committed as a valid artifact.** It was measured
> while the state existed but not written to a file at the time; the file that
> exists (`results/F7-sync-key-diagnosis-POST-TEARDOWN-VACUOUS.txt`) is a
> post-teardown re-run in which every lookup is `0` **because the state was gone**
> — the credential removed by block C, the sync rows cleared by the reset, the
> remote skills reclaimed. It is committed under that name, with a header saying
> so, precisely so it cannot be mistaken for the measurement. The numbers quoted
> above are therefore **observed, not artifact-backed**; only the
> `allowAnthropicUpload = true` half is still re-measurable and still holds.

Reported, not patched — this lane's mandate is the proof.

### F8 · MEDIUM · the chat surface writes **no** durable per-run delivery record

The acceptance asks for the resolved set size and delivery mode *"from the run's
own records/audit — not from logs alone"*. On the chat surface **there is no such
record.** `agent_run_skills_used.delivery_mode` — the only durable per-run
delivery record in the product — is written **exclusively** by the agent-run path
(`src/app/api/llm-bridge/route.ts`). The `/chat` assistant runtime performs its
own delivery (`selectSkillDeliveryAdapter(...).deliver(...)` in
`src/lib/assistant-runtime/runtime.ts`) and persists nothing about it. Its primary evidence is that static write-path review. Corroboration from this
lane: the global count of rows carrying a `delivery_mode` was **0** at the end of
every arm — though since **no turn completed**, that is corroboration, not a
per-turn measurement, and the R8 check says so in its own detail string.

Consequence for this block: the strongest available record is **the wire itself**
(the egress ledger captures the exact request the provider received, including
`container.skills` and both halves of each reference), corroborated by the
`anthropic_skill_sync` mappings. That is stronger than a log line, but it is
**not** the DB audit the acceptance language presumes — so the acceptance wording
and the product disagree, and the product is the one that should move.

### F9 · MEDIUM · the OpenAI key cannot be saved from the wizard — `read ECONNRESET`

Saving the OpenAI key through the real form fails **reproducibly (2/2)**, landing
on `/setup/ai?error=read%20ECONNRESET`, and the wizard then reports *"The openai
credentials were rejected: OpenAI is not connected."* The same key, from the same
host, seconds apart, returns **HTTP 200 three times out of three** from `curl
https://api.openai.com/v1/models`. Empty `OpenAI-Organization` /
`OpenAI-Project` headers were probed as a hypothesis and ruled out (both 200).

**Evidence status:** the committed artifact records **one** form failure
(`results/openai-arm.json` — the B2a detail naming the
`?error=read%20ECONNRESET` landing, plus `credentialPath`). The second form
attempt and the `curl` comparisons were run in-session with **no transcript
captured**, so read "2/2" and "3/3" as observed, not artifact-backed. Not
isolated further. Block B continued from the seeded credential row;
`results/openai-arm.json` records `credentialPath: "seeded-after-form-failure"`
so nothing here claims a form save that did not happen.

### F10 · LOW · the exact-binding failure does not name the provider

With the stored provider unavailable, the operator gets a generic **"Something
went wrong / The request failed"**. The runtime's own contract is that
unavailability is *"a VISIBLE error, not a silent hop"* and
`BoundDefaultProviderUnavailableError` is built to say *which* provider is down
rather than the useless generic. The **visible** and **no-hop** halves both hold
(C1a, C2a); the **naming** half does not reach the UI. The string `anthropic`
appears nowhere in the rendered page.

### F11 · MEDIUM · on OpenAI's default model, skills are silently not delivered at all

The OpenAI turn reached the provider — `POST /v1/responses → 200`,
`model: gpt-5.5`, streaming — and the recorded tool array was:

```
toolTypes: ["mcp", "function", "web_search"]
```

**No shell tool.** `gpt-5.5` trips the model-aware shell degrade
(`shouldDeliverChatShellSkillTools`, issue #47: OpenAI rejects the hosted `shell`
tool for gpt-5-class models), so the turn proceeds with **zero skills
delivered** behind a `console.warn`. The wizard's own resolved default model
therefore **disables skill delivery on OpenAI** — which is why *"tool-mount
delivery ≤8"* cannot be demonstrated on the shipped default. The turn also still
errored for a reason **not isolated** in this lane; no diagnosis is claimed.

### F12 · MEDIUM · the committed dev-lock pins a connector that cannot complete Anthropic readiness

On the **pinned** universe that CI validates — `anthropic-connector` at
`9783123` — the Anthropic readiness saga fails at **`credential-validation`**:
*"The installed anthropic connector exposes no way to validate its credentials."*
That SHA predates `e0a6c09` (PR #59, ABI v2 + the native-skills probe), which is
where `getConfiguredAPIKey` first exists. Captured before anything was changed:
`results/anthropic-arm-PINNED-UNIVERSE.json` (7 PASS / 10 FAIL) and
`screenshots/A0-PINNED-UNIVERSE-credential-validation-failure.png`.

Block A was then re-driven with **only this lane's `extensions/` checkout** moved
to `e0a6c09` — the same deliberate, recorded exception S6 made, for the same
reason. **No lock file was edited.** This is the pin lag the round-1 report
already flagged; F12 records that its blast radius includes *the entire Anthropic
setup path*, not only a catalog ledger entry.

---

## Live-API hygiene

`results/live-api-cleanup.json`

| | |
|---|---|
| lane-uploaded skills | **22** |
| versions deleted | **48** |
| skills reclaimed | **22 / 22** |
| indeterminate | **0** |
| `allReclaimed` | **true** |

Deleted in the documented **versions-then-skill** order — not a courtesy: S7
round 1 proved (C5) the server refuses a skill delete while versions remain.
Reclamation is scored only on a **definitive 404** re-read; a 401/429/5xx scores
indeterminate.

**Allow-listed, never "delete everything".** The authoritative set is this lane's
own `anthropic_skill_sync` rows, captured before any reset cleared them; the
remote list was diffed against it and the **4** non-lane skills present
(`xlsx`, `pptx`, `pdf`, `docx` — Anthropic's built-ins) were **reported and left
untouched**.

## Egress ledger

`ledgers/egress.jsonl` — **59** provider calls, every one real:

```
 22  A-readiness-run-1              anthropic  POST /v1/skills            200
  1  A-readiness-run-2              anthropic  POST /v1/messages          200   <- container.skills, accepted
 26  (boot + turn lazy re-sync)     anthropic  POST /v1/skills/*/versions 200
  7  B-openai-key-save/-readiness   openai     GET  /v1/models            200
  3  B-assistant-run-attempt-1..3   openai     POST /v1/responses         200
```

Two things fall straight out, and neither is a comment: **the entire OpenAI arm
contains zero Anthropic calls**, and **the Anthropic assistant-run attempts
contain zero `/v1/messages`** — the refusal is before egress.

## What ran live and what did not

**Live (real):** the Next.js server actions, the readiness saga and every port,
the audited default-provider mutation, S5's consent ledger + strict catalog sync
+ sync DAO, the connectors' own code paths, the real Anthropic Skills API, the
real OpenAI API, Postgres, the rendered UI, a production build.

**Not driven through the UI (2 steps, both recorded):** the Anthropic credential
save (its writer hard-requires the connection service, which this lane does not
run — the normal pre-setup state, and S6 already drove that arm to its F1 fix),
and the OpenAI credential save after **F9** made the form path fail. Both wrote
exactly the durable row a successful save leaves behind.

**Not claimed at all:** a completed assistant run on either provider; the
resolved-set-size and delivery-mode assertions that depend on it; a diagnosis of
F9's ECONNRESET or of the OpenAI turn's post-egress error.

## Codex round

Converged with Codex (read-only). It returned **MERGE-UNSAFE on the first cut**
and every finding below was applied rather than argued with — several were
overclaims that would have made this document say more than its own artifacts
support:

* **two real driver defects.** `R8` was hard-coded to `true` (an unfalsifiable
  "pass"); it now asserts the count is zero and states its scope. `C2b` checked
  for `ACKNOWLEDGED` while its prompt was *"Say hello."* — it would have PASSED
  had the assistant answered. Block C was **re-driven** after the fix (same
  verdicts, 6/7).
* **attempt counts were unsupported.** Each run overwrote the same results file,
  so "8 dev + 3 prod" and "11/11" were not in the committed evidence. Corrected
  to the committed 2 + 3, with the rest labelled observed.
* **the F7 mechanism was stated as forced when it is not.** Softened to
  "consistent with; not isolated", with the alternative `null` paths named.
* **the F7 diagnostic artifact was vacuous** (post-teardown) — now committed
  under an explicit `POST-TEARDOWN-VACUOUS` name with a header, and the numbers
  it once "supported" are labelled observed.
* **B4a's non-vacuity argument was false** — the reset removes the Anthropic
  credential, so the arm did not prove isolation-while-configured. Withdrawn.
* **the 17/17 was not on the pinned universe** (off-pin connector, F12) — now
  said in the environment table and in the heading itself.
* unbacked environment claims now have `results/lane-setup-manifest.txt`; the
  F7 error text and the cleanup allow-list are committed; the ledger's "host"
  claim, the "unreachable" guard claim and F9's counts were corrected.

Codex also noted the cleanup is sound (22 targets, 48 version deletes, 22 × 404
verified, 0 indeterminate) and the leak gate **passes** (no key value, password,
machine path or private hostname; screenshots OCR-clean; gitleaks clean).

## CI

**56 pass / 3 skipping / 1 CodeQL**, zero product files touched.

CodeQL raised **3 high `js/insufficient-password-hash`** alerts, all on
`drivers/diagnose-sync-key.mjs`, and all **dismissed as false positives**
(alerts 206–208) with the reason recorded on each:

That file re-derives the product's **own** sync-lookup fingerprint
(`deriveApiKeyFingerprint` — HMAC-SHA256 under `BETTER_AUTH_SECRET`, SHA-256
fallback) for the sole purpose of **comparing** it against the value already
stored in `cinatra.anthropic_skill_sync.api_key_fingerprint`, which is how F7's
lookup key was isolated. It stores nothing, authenticates nothing, and guards
nothing. The flagged input is an **API key**, not a user password, and the digest
is an opaque namespace label. Substituting a slow KDF — CodeQL's remedy — would
produce a *different* digest and destroy the only thing the check does: matching
the shipped algorithm byte-for-byte. There is therefore no sanitizer fix that
preserves the diagnostic, which is why this is a dismissal rather than a patch.

## Files

| path | what |
|---|---|
| `drivers/make-lane-env.mjs` | lane env generator (no value ever printed) |
| `drivers/egress-observer.mjs` | pass-through provider observer + ledger |
| `drivers/signup.mjs` | real first-account sign-up |
| `drivers/seed-provider-credential.mjs` | the recorded non-UI credential step (STDIN, never argv) |
| `drivers/reset-ai-step.mjs` | the wizard's row-scoped per-arm reset |
| `drivers/anthropic-arm.mjs` · `drivers/openai-arm.mjs` | the two wizard arms |
| `drivers/assistant-run.mjs` | the post-setup run + both false-green guards |
| `drivers/exact-binding-failure.mjs` | block C |
| `drivers/diagnose-sync-key.mjs` | the F7 lookup-key isolation |
| `drivers/reclaim-uploaded-skills.mjs` | allow-listed live-API reclamation |
| `results/lane-setup-manifest.txt` | re-measured environment provenance (migrations, tables, skills, build exit, both connector SHAs) |
| `results/F7-server-error-prod.txt` | the F7 exception text, verbatim, from the production server |
| `results/F7-sync-key-diagnosis-POST-TEARDOWN-VACUOUS.txt` | **vacuous** post-teardown re-run, labelled so it cannot be mistaken for the measurement |
| `results/lane-uploaded-skills.csv` | the cleanup allow-list's provenance (the lane's own sync rows) |
| `results/*.json` · `screenshots/*.png` · `ledgers/egress.jsonl` | machine-readable verdicts, captures, wire record |

**F6** (`GET /v1/skills` does not paginate) is unchanged by this run and remains
the recorded upstream limitation tracked in **#2237**.
