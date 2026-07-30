# cinatra#2094 S7 — program acceptance record

Epic #2086 (Anthropic custom-skills compliance). S0–S6 have all landed; this is
the recorded acceptance, run against `origin/main` at
`a57a6c4bad8fe353e018540fe3bf9c8508df617a` (the S6 squash, PR #2213) with the
extension universe cloned back at the SHAs pinned in the two lock files
(111 packages).

Machine-readable: `suite-results.json`, `live-results.json`, `migration-results.json`.

## The point of this stage

Every prior stage of the epic honestly deferred one thing to S7: **live
`container.skills` acceptance against the real Anthropic API**. S6's own proof
document says so in as many words — *"No live provider round-trip ran —
`liveProbeRan = false` … the live `probeNativeSkills` acceptance round-trip
therefore remains exactly where PR #2213 already put it: S7's scope, still
unproven."*

That round trip has now run. `drivers/live-skills-api-probe.mjs` made **68 real
requests** to `api.anthropic.com` with the org key across **10 named checks**,
and it found three things the stubbed suites could not.

## Live API conformance — 7 PASS / 3 FAIL

Docs pin: the Skills API as documented for the `skills-2025-10-02` beta, stacked
`code-execution-2025-08-25,skills-2025-10-02,files-api-2025-04-14`,
`anthropic-version: 2023-06-01`. Where docs prose and the wire disagreed, the
**wire** was treated as authoritative and the disagreement recorded.

| # | check | verdict |
|---|---|---|
| C1 | rooted-zip multipart create accepted (`display_title` + a single `files[]` zip rooted at the frontmatter name) | **PASS** |
| C2 | `POST /v1/skills/{id}/versions` mints a new immutable version (multi-file bundle with a routed reference) | **PASS** |
| C3 | `GET /v1/skills` cursor contract vs. the client's `has_more`+`last_id`→`after_id` | **FAIL** |
| C4 | versions-list pagination to exhaustion over a genuinely multi-page history | **FAIL** |
| C5 | skill delete is **refused** while undeleted versions remain | **PASS** |
| C6 | versions-then-skill delete order reclaims the remote skill | **PASS** |
| C7 | `display_title` collision rejected **and** classified by the shipped predicate | **PASS** |
| C8 | `container.skills` per-request cap — 8 accepted, 9 rejected | **PASS** |
| C9 | an unresolvable `container.skills` reference fails **closed** | **PASS** |
| C10 | an upload at/over the 30,000,000-byte gate is rejected by the API | **FAIL** |

Redaction: headers are never captured (the `x-api-key` rides every call), and
every remote `skill_…` id is replaced by a per-run salted digest token, because
this repo is public and a skill id is a workspace-scoped identifier.

### Cleanup, as a conformance check in its own right

Every skill the probe uploaded was deleted before exit, in the documented
versions-then-skill order — **11 skills / 13 versions, `allReclaimed: true`**,
verified by re-reading each id afterwards. The order is not a courtesy: C5
proved the API refuses a skill delete while versions remain.

## Findings

Per the lane brief, a product defect is **reported, not silently patched**. Only
acceptance scaffolding was written.

### F1 — HIGH (latent). Both list walks paginate on a cursor the API never returns

`packages/llm/src/tools/anthropic-custom-skills-client.ts`

The live list envelope is:

```json
{ "data": [ … ], "has_more": true, "next_page": "<opaque cursor>" }
```

There is **no `last_id`**, and the forward cursor is the **`page`** query
parameter. Both list walks —
`FetchAnthropicCustomSkillsGcClient.listSkillVersions` and
`FetchAnthropicCustomSkillsClient.findCustomSkillByDisplayTitle` — advance on
`has_more` + `last_id` → `after_id`. Against the real API that condition is never
satisfiable, so **both loops terminate after page 1.**

Blast radius, stated precisely (and corrected in the Codex round — see below):
both walks request `limit=100`, so a ≤100-version history and a ≤100-custom-skill
workspace behave correctly *today*, assuming the server honors the requested page
size (it honored `limit=1` in C4).

Past 100 versions, the GC deletes only the first page and the subsequent skill
delete is then refused by the server (C5). It does **not** wedge the whole
reclaim: `AnthropicSkillGcEngine` has per-skill failure isolation — the throw is
caught, pushed to `errors`, the local sync rows are deliberately retained so a
later run resumes, and the run returns `ok: false`. The real consequence is a
**non-converging reclaim**: every subsequent GC run re-deletes the same first 100
versions (idempotent 404s), fails the skill delete again, and surfaces the same
error, forever. The remote skill is never reclaimed. That is still precisely the
failure S0's *"paginate `listSkillVersions` to exhaustion before any
`deleteSkill`"* deliverable set out to remove.

Past 100 custom skills, a `display_title` collision rethrows instead of adopting
the existing remote identity, so a lost create response can strand a skill — the
retry-stability property S0 also claimed.

Measured in C3/C4, and pinned deterministically in
`packages/llm/src/__tests__/anthropic-skills-api-wire-conformance.test.ts`: two
narrow tests encode the **correct** contract and are marked `.fails`, so CI stays
green while the defect is documented, and vitest reports an unexpected PASS the
moment the client is fixed (the signal to drop the marker). Per the Codex round,
companion tests asserting the *current* defective behavior were deliberately
removed — they were redundant with the `.fails` pair and would have normalized
the bug into the suite's expectations.

### F2 — LOW. The 30,000,000-byte gate is stricter than the live API

A canonical rooted zip of **30,000,505** archive bytes (30,000,169 uncompressed)
was **accepted** with HTTP 200. `ANTHROPIC_SKILL_MAX_UPLOAD_BYTES` is therefore a
**confirmed client-side false rejection relative to observed server behavior** —
a conservative compatibility mismatch. Severity stays LOW: there is no data-loss
or over-delete risk, and no *documented* supported limit has been contradicted;
the cost is that large-but-valid bundles are refused at sync and preflight. S0
wrote that this constant *"changes only on that evidence"*; C10 is that evidence,
and the change is a product decision, so it was left alone.

### F3–F5 — premises verified (INFO)

- **F3** The 8-per-request `container.skills` ceiling is **stated and enforced by
  the server**: 8 distinct uploaded skills accepted, 9 rejected with an explicit
  server-side validation message naming both the ceiling and the count —
  `container.ContainerParams.skills: List should have at most 8 items after
  validation, not 9`. That message is why this is more than an inference from a
  status code. It remains a single observation on one workspace, not a proof of a
  universal, permanent cap; cinatra's hard cap of 8 matches the ceiling the API
  itself names.
- **F4** An unresolvable `container.skills` reference is **rejected**, so a stale
  local mapping surfaces rather than silently delivering nothing — the same
  fail-closed posture `AnthropicSkillNotSyncedError` enforces locally.
- **F5** `display_title` uniqueness is server-enforced **and** the shipped
  `isDisplayTitleConflict` predicate matches the real 4xx body, so the
  reconciliation path is reachable (which is what makes F1's second half matter).

## Migration regression — org-wide

Two complementary halves, because the pinned universe and the repos' default
branches genuinely disagree, and hiding that would misreport the program.

**Pinned universe** — the project's own shared verdict,
`node scripts/audit/skill-packaging-gate.mjs`, exit 0: 4 host bundles + 111
extension packages, `exceptions: 0`, and **1** `embeddedSkills` ratchet entry
(`@cinatra-ai/media-transcript-agent :: skills/transcribe-media/SKILL.md`).

**Default branches, fetched live from GitHub** —
`drivers/org-migration-regression.mjs`: 111 repos scanned (1 unreachable),
covering **29 agent repos**, 27 `kind:"skill"` repos and 83 non-skill repos.

| measure | count |
|---|---|
| embedded-skill violations outside the fixture allowlist | **0** |
| `kind:"skill"` repos not carrying exactly one bundle | **0** |
| assistant required **injectable** set | **5** (cap 8) |
| assistant required **internal**, excluded from injection *and* upload | **1** (`hitl-prompt-drive-skill`) |

So the single pinned survivor is **pin lag only** — that repo's fold is already
merged on its default branch, and the ledger entry clears when the release-fenced
catalog train advances the pin. Zero embedded skills org-wide on the branches
that exist today.

The raw-`skillIds` census is recorded as **context, not a verdict**: 29
declarations, 10 on the post-resolution delivery wire, 2 in tests, 17 in internal
plumbing that produces or reads id lists. The authority for that invariant is
S4's arch gate (`injection/__tests__/no-bypass-arch.test.ts`), which refuses to
be vacuously green and ran green in the skills suite. An earlier revision of this
driver reported a vacuous `0` here because `git grep -E` is POSIX ERE, where
`\s` matches nothing — corrected to POSIX classes.

## Consent matrix — real Postgres

`anthropic-skill-upload-outbox.integration.test.ts`, **23 passed**, against a
lane-unique `postgres:18` container (port 5741), with no mocked DB on the path
under test: transactional outbox in the same batch as the catalog write; the
crash window (the request row survives, still `pending`, still claimable); the
negative half (a rolled-back transaction leaves no phantom request); the derived
`allowAnthropicUpload` projection; grant / revoke / bulk / lock; and delayed
uninstall GC after the grace window. The readiness saga added **9 passed** on the
same store.

## Regression suites

| suite | files | tests |
|---|---|---|
| `@cinatra-ai/llm` | 48 | **487 passed**, 1 skipped |
| `@cinatra-ai/skills` | 101 (+1 skipped) | **933 passed**, 9 skipped |
| skill lifecycle / readiness / purpose-policy inventory | 23 | **229 passed** |
| new wire-conformance suite | 1 | **5 passed + 2 expected-fail** |

The skills suite is where the S4 invariants live and stay green: the 8-total cap
including the personal delta, the branded-contract single constructor, one-hop
inline expansion with whole-skill drops on budget overflow, and the no-bypass
arch gate.

## What this run does NOT prove

Stated plainly, because a green board is not the same as a proven one.

1. **Browser-level per-provider E2E was not run.** No `pnpm dev` boot was driven
   through a browser in this lane. S6 already drove all five `/setup/ai` render
   flows on a live stack; **S7's delta — the post-setup assistant run showing
   container-delivered injection ≤8 on Anthropic and tool-mount delivery ≤8 on
   OpenAI, plus the exact-binding failure surface — is not covered here.** The
   ≤8 cap and the per-provider mechanism are covered at unit level by the green
   S4 suites, and that is *not* a substitute. No screenshot, egress ledger, or
   verdict is claimed for this block.
2. **No dedicated "one bundle through all three adapters" suite was added.** The
   constituent invariants are green in S4's suites; the single end-to-end
   cross-provider acceptance suite the spec describes was not written.

Both gaps are recorded in `suite-results.json` under `notRun` with the same
wording, so they cannot be read as passes.

## Codex round

The findings and the diff were converged with Codex (`gpt-5.6-sol`, read-only).
It returned four corrections, all applied:

1. **F1's blast radius was materially wrong.** "Wedging the GC run" was
   overstated — Codex flagged that the claim depends on what the engine does with
   the 4xx. Checking `AnthropicSkillGcEngine` showed per-skill failure isolation,
   so the accurate consequence is a **non-converging reclaim that surfaces the
   same error on every run**, not a wedged run. Rewritten.
2. **The companion defect-asserting tests were redundant and normalized the
   bug.** Removed; the two narrow `.fails` tests plus the finding reference now
   carry it alone.
3. **F2's "conservative, not wrong" was too categorical.** Reworded to a
   confirmed client-side false rejection / conservative compatibility mismatch,
   severity unchanged at LOW.
4. **F3 over-claimed from one observation.** Softened, and the server's own
   explicit validation message is now quoted as the actual basis — with the
   single-workspace caveat stated.

Codex also asked that each `.fails` assertion be narrow enough to fail only for
the pagination defect; both were tightened and annotated to that effect.

---

# Round 2 — F1 + F2 fixed, live re-verified, and the cross-provider suite added

Round 1 (everything above) recorded the acceptance and **reported** two defects
rather than patching them. Both are now fixed in this branch and re-driven against
the live API, and one of the two round-1 `notRun` gaps is closed — but the
acceptance **is still not complete**: the re-verification is **9 PASS / 1 FAIL**,
and it surfaced a NEW finding (**F6**) that qualifies how much F1's fix can
deliver. Read §F6 before treating S7 as done.

| round-1 item | round-2 state |
|---|---|
| **F1** both list walks paginate on a cursor the API never returns | **FIXED for the cursor bug** — both walks now key on the real `{data, has_more, next_page}` envelope (forward cursor on the `page` param). Exhaustion is live-proven on the **versions** walk (**R4**, 4 pages, 4 of 4 versions; the pre-fix shape returned 1 of 4). On the **skills-list** walk the cursor is now correct but exhaustion is **unreachable** — the endpoint returns no cursor at all (**F6**, measured by **R3**, which FAILS). |
| **F2** the 30,000,000-byte gate is stricter than the live API | **FIXED** — `ANTHROPIC_SKILL_MAX_UPLOAD_BYTES` 30,000,000 → **31,457,280** (30 MiB). The OLD value is refuted LIVE (**R10**); the NEW value is a docs-based policy reading, not a measured server limit — see §R10. |
| `notRun` #2 — no "one bundle through all three adapters" suite | **CLOSED** — `packages/llm/src/__tests__/cross-provider-router-acceptance.test.ts` (21 tests). |
| `notRun` #1 — browser-level per-provider post-setup E2E | **STILL NOT RUN.** Unchanged and still not claimed. See §Still not run. |

## The live re-verification — 9 PASS / 1 FAIL

`drivers/live-reverify-postfix.mjs` → `live-reverify-results.json`. **105 real
requests** to `api.anthropic.com`; **9 PASS / 1 FAIL**; the driver exits **1**;
cleanup **15 skills / 15 versions, `allReclaimed: true`** in the documented
versions-then-skill order. Round 1's `live-results.json` is **preserved
untouched** — the original 7 PASS / 3 FAIL measurement is the record of the
defects, and this is a second, additive record.

**The acceptance is therefore NOT complete, and this is not a green record.** F1's
fix is fixed and live-proven for the GC/versions walk (R4) and F2's is settled
(R10), but R3 measures a product property that is still unmet because of new
finding **F6**.

> ### A correction worth stating plainly
>
> An earlier revision of this driver reported **10/10**. It got there by
> re-scoping R3 after the multi-page framing could not hold — and the re-scoped
> check happened to select a target on page **one**, which the **pre-fix** client
> would also have satisfied, since it finds a first-page match before reaching any
> pagination logic. A check the bug passes proves nothing, and an upstream
> limitation does not convert an unmet product behaviour into a pass. Codex flagged
> this as goalpost-moving in the round-2 convergence and was right. R3 now measures
> the property directly and records **FAIL**.

**This run is a stronger claim than round 1.** Round 1 deliberately
reimplemented the canonical zip builder and both walks so it could run without
booting the app's module graph — fine for *discovering* a contract, but it proves
nothing about the shipped code. Round 2 imports and drives the **real production
modules** (`FetchAnthropicCustomSkillsClient`, `FetchAnthropicCustomSkillsGcClient`,
`isDisplayTitleConflict`, `buildCanonicalSkillZip`, `checkSkillBoundary`,
`ANTHROPIC_SKILL_MAX_UPLOAD_BYTES`) under `node --import tsx`. R3/R4/R10 are
therefore claims about the code that ships.

| # | check | verdict |
|---|---|---|
| R1 | rooted-zip multipart create through the shipped client | **PASS** |
| R2 | `POST /v1/skills/{id}/versions` mints a new immutable version | **PASS** |
| R3 | collision reconciliation resolves a `display_title` BEYOND the page `GET /v1/skills` serves | **FAIL** — finding **F6** |
| R4 | versions-list pagination to exhaustion over a genuinely multi-page history | **PASS** |
| R5 | skill delete refused while versions remain | **PASS** |
| R6 | versions-then-skill order reclaims the skill | **PASS** |
| R7 | collision rejected **and** classified by the shipped predicate | **PASS** |
| R8 | `container.skills` cap — 8 accepted, 9 rejected | **PASS** |
| R9 | unresolvable reference fails closed | **PASS** |
| R10 | the raised upload gate agrees with the live API | **PASS** |

### R4 — the F1 fix, with a quantified delta

A disposable skill was given **four** versions and walked by the **real GC
client** at an injected page size of 1 — a genuinely multi-page history:

- `versionRequestsMadeByTheWalk: 4`, `versionsReturnedByTheWalk: 4`,
  `sameVersionSet: true`.
- The **pre-fix** cursor shape (`has_more` + `last_id` → `after_id`), replayed
  over the same history, returned **1 of 4**.

That 1-of-4 is the non-converging reclaim in one number: the GC would delete only
what it saw, then be refused the skill delete (R5) on every subsequent run,
forever. The S0 deliverable *"paginate `listSkillVersions` to exhaustion before
any `deleteSkill`"* is restored **on the wire**, not just in a stub.

### R10 — the F2 raise: what is live, and what is only local

One artifact (**30,000,513** archive bytes / **30,000,189** uncompressed), built by the
**real** canonical zip builder:

- the live API **accepted** it (HTTP 200) — the false rejection is real;
- the **shipped** gate now accepts it — the lift reaches the product;
- the shipped gate **still rejects** at/above its own constant — a raise, not a
  removal (`oldGateRejectionDimension: "uncompressed"`).

**Only the first bullet is live.** The other two are in-process
`checkSkillBoundary()` calls, and the at-limit case is a *synthetic* object rather
than an upload — they prove the gate's own arithmetic, not server agreement. The
phrase "live-proven in all three directions" appeared in an earlier revision of
this document and was false; it is corrected here.

**What the evidence bounds, exactly.** Only a LOWER bound: the server's threshold
is strictly greater than the largest artifact it accepted (30,000,513 bytes), so an
evidence-only constant under this module's `>=` semantics would be **30,000,514**.
The shipped **31,457,280** is instead the docs-based *policy* reading of "under
30 MB" (binary MB) — consistent with the measurement but **not derived from it**,
since nothing between the observed floor and 31,457,280 was probed in either
direction. It is chosen so the gate tracks the published contract rather than
whichever artifact size happened to be tested, and it is labelled as a policy
inference on the constant itself. Probing near 31,457,280 is the follow-up that
would upgrade the top of that band from inference to evidence; leaving 30,000,000
was rejected because it preserves a confirmed false rejection.

## F6 — NEW finding, measured by this re-verification (reported, NOT patched)

**`GET /v1/skills` does not paginate.** Measured live with **4 custom skills
present**: `limit=1` returned 1 row and `limit=2` returned 2 rows, and **every**
response carried `has_more:false` with `next_page:null`; an unknown `page` value is
accepted and silently ignored (all rows came back). The endpoint truncates to
`limit` and never offers a second page.

**R3 is the direct proof, not an inference.** The driver collided on a
`display_title` the endpoint provably does not return, and the shipped
reconciliation made its **1** list request, found nothing, and **rethrew** instead
of adopting the existing remote identity (`adoptedTheExistingIdentity: false`,
`rethrewInstead: true`). A **positive control** — the same reconciliation on a
title *inside* the served page — **adopted correctly**, which attributes the
failure to the page ceiling rather than to the reconciliation logic or the
collision classifier.

This is the honest qualification of F1's fix, and the two endpoints differ:

- **versions** endpoint — paginates properly; F1's fix is load-bearing and
  live-proven there (R4).
- **skills-list** endpoint — F1's fix corrects the cursor the client *keys on*,
  but **cannot restore exhaustion**, because the server hands back nothing to
  paginate with.

**Blast radius.** `findCustomSkillByDisplayTitle` requests `limit=100`, so it can
only ever observe the first 100 custom skills. In a workspace holding more than
100, a `display_title` beyond row 100 is invisible, so a lost create response
rethrows instead of adopting the existing remote identity — the retry-stability
property S0 claimed. Severity is bounded by that precondition (>100 custom skills
in one workspace) and by R3's live result: within the page the endpoint does
serve, a real collision **does** adopt correctly.

**Why it is not patched here.** No *complete* client-side fix is evidence-backed,
and every mitigation was probed rather than assumed (all recorded under R3's
`paginationProbe`): the `display_title` filter is **accepted and ignored** (4 of 4
rows returned, `filtered: false`), and `limit=101`/`limit=1000` return HTTP 200 but
cannot be shown to be *honoured* beyond the rows available to measure. Raising the
page size on that basis would be a guess dressed as a fix.

**A partial mitigation does exist, and is recommended rather than silently
applied.** When a no-cursor page comes back FULL (`rows == limit`) with no match,
the walk currently cannot distinguish "absent" from "truncated" — it treats the
page as exhaustive. Reporting that case as TRUNCATED/indeterminate would let a
caller fail loudly instead of minting a duplicate remote identity. That is a
behaviour change to shipped code, outside this lane's authorised F1/F2 scope, so
it is written down here and on the method instead of being slipped in. Any
higher-limit mitigation should be proven against **more than 100 live rows**
before F6 is closed.

The wire suite's paged collision arm is now explicitly labelled as a guarantee
about the **client's** walk shape against the documented scheme, **not** an
observed-live claim, so nothing in the tree reads as proving more than R3 showed.

## Still not run

**Browser-level per-provider post-setup E2E — NOT RUN, unchanged from round 1.**
The S7 delta (a post-setup assistant run showing container-delivered injection ≤8
on the live Anthropic path and tool-mount delivery ≤8 on OpenAI, the exact-binding
failure surface, and the zero-Anthropic-egress ledger for the OpenAI arm) is still
uncovered. No screenshot, egress ledger, or verdict is claimed for it. The ≤8 cap
and the per-provider mechanisms are covered at unit level by the S4 suites and by
the new cross-provider acceptance suite — which is **not** a substitute for a
real browser run, and is labelled stubbed in its own header.
