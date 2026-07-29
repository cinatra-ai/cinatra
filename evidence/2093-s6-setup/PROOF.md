# cinatra#2093 S6 — `/setup/ai` render proof

Closes the recorded proof gap on PR #2213. The delivering lane wrote **"Visual
proof — not captured, and I am not going to claim otherwise"** and enumerated
five flows a reviewer should drive. This is that walk, driven.

Nothing here is a fixture route and nothing is a re-render of a component in
isolation: every screenshot is the real `/setup/ai` page of a real
`pnpm dev` boot, reached through a real sign-in, against a real Postgres, with
the real server actions and the real readiness saga executing.
`CINATRA_E2E_SETUP_BYPASS` is **deliberately unset** — the setup wizard itself is
the surface under proof, so bypassing it would prove nothing.

> ## Round 2 — the two findings this walk recorded are FIXED, and re-driven
>
> The first walk found two real defects on this PR's own surface (§Findings) and
> recorded them rather than fixing them. **Both are now fixed in this PR**, so
> the affected evidence was **re-driven** on a fresh stack of the same shape:
> `drivers/refresh-f1-f2-walk.mjs`, machine-readable in `refresh-results.json`
> (**12/12 PASS, zero page errors**), with its own egress ledger
> (`stub/egress-refresh.jsonl`).
>
> | | |
> |---|---|
> | re-driven | **F1** the key-save failure state · **flow (d)** the readiness failure and its now-followable fix-forward · **F2** the control that performs the fix · **flow (c)** the receipt — only because its precondition changed (see below) |
> | re-captured | `07-readiness-failure`, `08-anthropic-receipt`; **new** `06c-anthropic-key-save-actionable`, `09-native-mcp-switched` |
> | kept as first captured | flows **(a)**, **(b)** and **(e)** — the provider choice, the entire OpenAI arm, the matcher constraint. Nothing in the F1/F2 fixes touches them, and `stub/egress.jsonl` (their measurement) is untouched. |
> | one out-of-band step **eliminated** | the `mcpMode` flip. It is now performed **from the UI**, so the success arm is reached without it. |
>
> Everything below is the first walk's record; the round-2 deltas are marked
> inline.

## Where the walk ran

| | |
|---|---|
| host | round 1: PR #2213 head `13702058caaf4bed93b382ca3a8dd01beff0c15a`. Round 2: the same branch rebased onto `main` after #2208, carrying the F1/F2 fixes. |
| anthropic-connector | the **paired** PR `cinatra-ai/anthropic-connector#59` head `d90ee7c` — ABI v2 + `probeNativeSkills`. The dev lock is untouched (it advances by auto-bump after that PR merges); only this lane's `extensions/` checkout was moved to the lockstep head, because the host PR's saga calls a surface member that exists only there. |
| openai-connector | at its committed **required-lock** pin `255a44b` (pre-#72) |
| gemini-connector | at its committed **dev-lock** pin `673fc96` (still the v1 block) — i.e. the exact transitional state the PR's v1-retirement ratchet describes |
| database | a **fresh** Postgres 18 provisioned for this lane; Better Auth schema via `pnpm auth:migrate`, then 73 core migrations applied by the boot chain |
| instance state | genuinely **pre-setup**: the operator account was created through the real "Create the first account" form and auto-promoted to admin; the wizard reads `key:true, name:false, connections:false, ai:false` |
| browser | isolated Chromium profile (not the shared MCP browser), 1440×1200 @2x, full-page captures |

Gemini's connector is **installed and active** on this instance (the boot log
registers it alongside openai/anthropic), which is what makes flow (a) meaningful:
Gemini is absent from the wizard because `wizardEligible: false`, not because the
connector is missing.

## Verdicts

| # | flow | verdict | what the page actually showed |
|---|---|---|---|
| a1 | both wizard-eligible providers render | **PASS** | `setup-provider-openai`, `setup-provider-anthropic` |
| a2 | Gemini is NOT offered | **PASS** | no `setup-provider-gemini` node in the DOM (with the Gemini connector active) |
| a3 | no Gemini affordance in the choice section | **PASS** | read off the rendered text |
| a4 | a disabled card says why | **PASS (vacuous, stated)** | both connectors are active here, so no disabled card exists to render. The disabled copy is therefore **not** proven by this walk. |
| b1 | OpenAI form renders under the choice | **PASS** | key + project + organization + service-tier + default-model, unchanged |
| b2 | key validated + saved | **PASS** | the "OpenAI connection saved" alert, after the connector's live `GET /v1/models` validation |
| b3 | readiness saga completes on OpenAI | **PASS** | receipt panel |
| b4 | **ZERO Anthropic egress on the OpenAI path** | **PASS** | measured, not asserted — see the ledger below |
| b5 | Continue offered once the receipt is valid | **PASS** | Continue link renders |
| e1 | matcher constraint surfaces on Anthropic | **PASS** | *"Skill auto-matching requires OpenAI… Everything else — the assistant, agents, skill generation — runs on Anthropic. Skills can still be attached to agents manually."* |
| e2 | Anthropic key form + egress advisory | **PASS** | `setup-anthropic-api-key` + the "What finishing setup on Anthropic will do" advisory |
| d0 | Anthropic key **save** through the wizard form | round 1 **NOT DRIVEN** → round 2 **PASS** | round 1: it threw and the throw was not caught (F1). Round 2 re-drives the same click against the same unconfigured connection service and gets the in-page actionable state — see the round-2 verdicts below |
| d1 | readiness failure renders actionably | **PASS** | `AI setup did not complete (native-skills-probe)` + the fix-forward naming the MCP-mode switch |
| c1 | Anthropic saga reaches a valid receipt | **PASS** | `22 skill(s) uploaded, and Claude accepted a container.skills request` |
| c2 | the probe carried BOTH halves of the reference | **PASS** | `{"skill_id":"skill_lane2093_45","version":"v1","type":"custom"}` |

Machine-readable: `walk-results.json`. One page error was recorded during the
whole walk — the d0 throw itself, quoted in §Findings.

### Round-2 verdicts — the re-driven flows

Machine-readable: `refresh-results.json`. **12/12 PASS, zero page errors.**

| # | flow | verdict | what the page actually showed |
|---|---|---|---|
| f1a | the key save fails → an **in-page actionable state** | **PASS** | *"Could not save the Anthropic API key — Configure the connection service first so Anthropic API requests can authenticate."* rendered at the credential form |
| f1b | that state names the step to complete **first** | **PASS** | *"Finish the Connections step first — the Anthropic key is stored through the connection service, which is not configured yet. Complete Connections, then come back and save the key."* |
| f1c | no unhandled server error | **PASS** | the whole step still renders — provider choice, credential form, readiness section |
| f1d | reported through the wizard's **codes-only** flash | **PASS** | redirected to `?error=setup-provider-save-failed`, then consumed + stripped by the toast island (recorded off the navigation, not the settled URL) |
| d2 | the fix-forward names an **existing** control | **PASS** | *"Use “Switch to native MCP delivery” below…"* — and it no longer says "in its settings" |
| d3 | that control is rendered in the failure state | **PASS** | `setup-enable-native-mcp` |
| f2a | the control flips the **stored** mode | **PASS** | read out of Postgres: `{"mcpMode":"function-tools"}` → `{"mcpMode":"native"}` |
| f2b | the resolved failure is cleared | **PASS** | no `setup-readiness-failure` node after the switch |
| f2c | the switch does **not** fabricate readiness | **PASS** | no receipt panel — readiness is still a probe the operator has to run |
| c1 | the saga reaches a valid receipt with the mode set **from the UI** | **PASS** | receipt panel, probe ref `{"skill_id":"skill_lane2093_23","version":"v1","type":"custom"}` |
| c2 | the probe carried BOTH halves of the reference | **PASS** | same reference |

## Screenshots

| # | state |
|---|---|
| `01-provider-choice` | neither provider picked — the choice + "Pick a provider to continue" |
| `02-openai-form` | OpenAI selected, its connection form below the choice |
| `03-openai-key-saved` | key validated and saved |
| `04-openai-receipt` | OpenAI receipt + Continue |
| `05-anthropic-form-matcher-constraint` | Anthropic selected — key form, egress advisory, **and** the matcher-constraint alert |
| `06a-anthropic-key-save-unhandled-error` | **BEFORE.** The F1 finding as it rendered on round 1 — kept deliberately, because a fix is easier to judge against the symptom it removes. |
| `06b-anthropic-connection-stored` | the step with an Anthropic connection stored |
| `06c-anthropic-key-save-actionable` | **AFTER (round 2).** The same click, the same unconfigured connection service — now the in-page state at the credential form + the codes-only toast. |
| `07-readiness-failure` | **flow (d), re-captured (round 2)** — the `function-tools` diagnosis, the fix-forward, **and the “Switch to native MCP delivery” control**, plus the codes-only wizard toast |
| `08-anthropic-receipt` | **flow (c), re-captured (round 2)** — `22 skill(s) uploaded, and Claude accepted a container.skills request`, then Continue. Re-driven because its precondition changed: the mode was set from the UI, not seeded. |
| `09-native-mcp-switched` | **new (round 2)** — immediately after the switch: the failure is gone, and setup is deliberately still NOT complete (no receipt) because the probe has not been re-run |

## What ran LIVE and what was boundary-stubbed

**Live (real):** the Next.js server actions, the readiness saga and every one of
its ports, the audited default-provider mutation, S5's consent ledger + strict
catalog sync + sync DAO, the connectors' own code paths (including
`probeNativeSkills` deciding on the stored `mcpMode`), Postgres, the rendered UI.

**Stubbed — exactly one thing:** the outbound HTTP boundary to `api.openai.com`
and `api.anthropic.com`, wrapped at `globalThis.fetch` by a `node --import`
preload (`drivers/provider-boundary-stub.mjs`) so it is installed before Next.js
captures fetch. That is the same boundary the connectors' own probe suites stub;
nothing inside the app is faked.

**No live provider round-trip ran — `liveProbeRan = false.`** The sanctioned
single-secret retrieval path for the org Anthropic key is not available to this
lane (no such tool is exposed to it), so no live key could be obtained, and per
the lane's own rails no other key was hunted for. The live `probeNativeSkills`
acceptance round-trip therefore remains exactly where PR #2213 already put it:
**S7's scope**, still unproven.

### The egress ledger — why b4 is a measurement

Every provider-host request is appended to `stub/egress.jsonl` with its phase,
method and path (never headers — the API key rides all of these and this repo is
public). The whole walk produced 28 calls:

```
  2  flow-b-openai-key-save     openai     GET  /v1/models
  2  flow-b-openai-readiness    openai     GET  /v1/models
  1  flow-e-anthropic-select    openai     GET  /v1/models
 22  flow-d-readiness-failure   anthropic  POST /v1/skills
  1  flow-c-anthropic-success   anthropic  POST /v1/messages
```

Two things fall straight out of that table, and neither is a comment:

1. **The OpenAI path performed zero Anthropic egress.** Both OpenAI phases
   contain only `GET /v1/models`. (The single OpenAI call in the
   `flow-e-anthropic-select` phase is the page render refreshing the OpenAI
   connection, not the Anthropic saga.)
2. **The failing probe refused BEFORE any egress.** The `function-tools` run
   uploaded 22 skills and then issued **no** `POST /v1/messages` at all — the
   connector declined in-process rather than sending a request that might have
   "passed" through emulation. That is the MCP Injection Rule the connector PR
   describes, observed rather than asserted.

The success run then needed only the single `POST /v1/messages`: the strict sync
was already reconciled from the failing run, so it correctly uploaded nothing
again and probed a genuinely-synced revision (`disposable: false` in the receipt).

#### The round-2 ledger — `stub/egress-refresh.jsonl`

The re-drive records into its **own** file (`LANE_LEDGER`), so the round-1 ledger
above — the measurement behind the OpenAI-path claim, on flows this round did
not re-drive — stays exactly as it was captured. 23 calls:

```
 22  refresh-d-readiness-failure  anthropic  POST /v1/skills
  1  refresh-c-anthropic-success  anthropic  POST /v1/messages
```

Two things this ledger says, both of which matter to the fixes:

1. **The F1 phase produced ZERO egress.** The connector refuses on an
   unconfigured connection service *before* any request leaves the process, so
   the state the operator now sees is reached with nothing on the wire.
2. **The failing probe again refused before egress**, and the success run again
   needed exactly one `POST /v1/messages` — i.e. the fix changed how the
   operator gets to `native`, and changed nothing about what the saga does once
   it is there.

### Durable state after the walk

Identical in shape after both rounds (round 2's probe reference is
`skill_lane2093_23`, its own run's first synced revision):

```
connector_config:llm_default_provider          "anthropic"
connector_config:anthropic                     {"mcpMode":"native"}   <- round 2: set FROM THE UI
connector_config:anthropic_skill_sync_enabled  true
connector_config:setup_readiness_last_failure  null
connector_config:setup_readiness_receipt       {"receiptVersion":1,"provider":"anthropic",
                                                "probe":{"accepted":true,"mode":"container-skills",
                                                         "skillId":"skill_lane2093_45","version":"v1",
                                                         "disposable":false},
                                                "syncedSkillCount":22, ...}
cinatra.anthropic_skill_sync                   22 rows
cinatra.skill_upload_consent                   24 rows
```

## Findings

> **Both findings below are FIXED in this PR** (round 2). Each keeps its
> original text — a finding rewritten after the fact stops being a record — with
> a **FIXED** block appended saying what changed and where the proof is.

### F1 — the Anthropic key cannot be saved from the wizard, and the failure is unhandled

**Severity: real, user-visible, on the surface this PR changes.**

`saveAnthropicSetupKeyAction` (`src/app/setup/ai/actions.ts`) calls the
connector's `saveAPISettings` with no error handling. That writer hard-requires a
configured connection service:

```
anthropic-connector/src/index.ts:257
  if (!deps.nango.isConfigured()) {
    throw new Error("Configure the connection service first so Anthropic API requests can authenticate.");
  }
```

On an instance where Nango is not yet configured — which is the *normal*
pre-setup state, and is precisely why the wizard still shows an incomplete
**Connections** step — clicking **Save** on the Anthropic key throws out of the
server action. The operator gets an unhandled server error
(`06a-anthropic-key-save-unhandled-error.png`), not an in-page actionable state.

The OpenAI path does not behave this way: its save tolerates an unconfigured
Nango and, on any real failure, redirects with an error code the wizard's
codes-only toast renders. The two provider arms of the same step are asymmetric.

The narrow fix is to catch it the way the rest of the step already catches things
— redirect with a flash code — so the operator is told to finish **Connections**
first instead of hitting an error page. Recorded here rather than fixed, because
this lane's mandate is the proof, not the change.

> **FIXED (round 2).** `saveAnthropicSetupKeyAction` now catches, records an
> operator-facing failure, and redirects with a flash code — the reporting
> semantics of the OpenAI arm, read off `openai-connector`'s `actions-core`
> rather than assumed. Two deliberate limits:
>
> * **Nothing is swallowed.** Every error class becomes a rendered state; the
>   unconfigured-connection-service class additionally earns a fix-forward
>   naming the **Connections** step, decided from the live nango status rather
>   than by matching the connector's error string. A `NEXT_REDIRECT` thrown by
>   the connector's own writer is re-thrown as the control flow it is.
> * **The credential still goes through the connector's own gated writer.** The
>   host does not grow a second credential path; Anthropic's key genuinely
>   cannot be stored without the connection service, and the fix is to say so
>   actionably rather than to work around it.
>
> A Codex round on this diff also caught that the first cut logged the RAW
> error (`console.error(..., err)`): a provider writer is free to echo the
> credential back in its message or stack, and a server log is durable and often
> shipped off-box, so that would have defeated the sanitizer entirely. The log
> now carries the sanitized text plus the error CLASS, and a test asserts no
> `Error` object ever reaches the sink.
>
> Proof: `06c-anthropic-key-save-actionable.png`; `refresh-results.json` f1a–f1d;
> unit-pinned in `src/app/setup/ai/__tests__/actions.test.ts` (failure arms,
> the success arm, the no-invented-remedy arm, the redirect-is-control-flow arm,
> and both sanitizer obligations — durable state and the log).

### F2 — `mcpMode` has no affordance anywhere the operator can reach during setup

The saga's success arm requires the Anthropic connection's `mcpMode` to be
`native`; the default is `function-tools`, and the failure message correctly says
*"Switch the Anthropic connector's MCP mode to 'native' in its settings"*. But
every authenticated admin route redirects back into the wizard while setup is
incomplete, so during setup there are no such settings to reach. The fix-forward
is accurate and currently unfollowable from inside the wizard.

> **FIXED (round 2) — and the finding turned out to understate the problem.**
>
> Grounding the two candidate fixes showed the second one is not available:
>
> * *Exempt the settings route from the setup redirect.* The wizard's redirect
>   is an allowlist in `src/components/app-shell.tsx` (`isSetupPath`) which
>   already exempts `/configuration/llm/initial-setup`, `/configuration/llm/openai`
>   and `/configuration/apps/openai`, so adding a route is trivial — **but there
>   is no route to add.** The anthropic connector's `cinatra.configSchema`
>   declares no `mcpMode` field (its fields are: the result banner, the
>   connection advisory, the status probe, `apiKey`, `defaultModel`, and the
>   connect/disconnect actions), and the host's legacy `setAnthropicMcpModeAction`
>   is a documented stub that writes nothing. Exempting a route would land the
>   operator on a page that still cannot perform the switch — a fake fix.
> * *An in-failure-state control that performs it.* Preferred if the write were
>   already server-actioned. It is not — see above.
>
> So, per "implement the smallest correct one": the wizard performs it.
> `enableAnthropicNativeSkillDeliveryAction` (admin-gated, same as every action
> in this step) writes the ONE non-secret field through `writeAnthropicMcpMode`,
> deliberately co-located with the `readAnthropicMcpMode` the fingerprint
> already treats as authoritative, writing back every field it read. The
> fix-forward now names that control. The durable fix — an `mcpMode` writer on
> the `llm-provider-surface` ABI, or the field on the connector's own
> configSchema, over an ATOMIC write — is connector-side, beyond this repo, and
> is recorded as follow-up on cinatra#2093. (The lost-update window of a
> read-modify-write is inherited, not introduced: the connector's own
> `saveMcpMode` has the identical shape over the identical row, so routing
> through it would not close it. Closing it needs a CAS connector-config write,
> which does not exist yet.)
>
> **What the action REFUSES to do** — three arms added after a Codex round on
> this diff, each closing a way it could otherwise manufacture the exact state
> the saga exists to prevent:
>
> 1. It re-checks the standing condition **at mutation time** (a
>    `native-skills-probe` failure AND a stored mode of `function-tools`), so a
>    stale form, a double submit or a direct invocation cannot set the mode and
>    wipe the single global failure record while an *unrelated* failure is
>    standing.
> 2. It **clears the readiness receipt first**, and refuses to touch the mode if
>    that clear fails. A fingerprint mismatch leaves a receipt *dormant*, not
>    deleted, and a failing run's own receipt-clear is best-effort — so
>    restoring a mode an older receipt was earned under would **resurrect** it
>    and read as ready on a probe that failed. Clearing before the write means
>    no ordering of crashes leaves mode-changed with a stale receipt.
> 3. It reports a failed mutation through the flash protocol instead of throwing
>    an error page — the same posture F1 fixes.
>
> Proof: `07-readiness-failure.png` (the control, rendered inside the failure),
> `09-native-mcp-switched.png` (after); `refresh-results.json` d2/d3 + f2a–f2c,
> where the flip is read **out of Postgres**, not off the button label — that
> pair is also the render/wiring contract for the control itself (it cannot
> disappear while the walk passes). Unit-pinned in
> `setup-readiness-receipt.test.ts` (round-trip, other settings preserved,
> absent-row, re-invalidation, **and the resurrection hazard itself**) and in
> `actions.test.ts` (receipt cleared before the mode write; fail-closed when it
> cannot be; the stale/unrelated-failure guard; the double-submit guard; the
> admin gate precedes every mutation; no provider committed, no receipt
> written).

## The out-of-band steps, named

Round 1 had two. **Round 2 has one** — F2's fix eliminated the other.

1. **The Anthropic connection state was seeded directly**
   (`drivers/seed-anthropic-connection.mjs`) instead of being saved through the
   form. STILL out of band, and for the reason round 1 gave: even with Nango up,
   its import has Nango verify the credential against the **real** Anthropic API
   from inside Nango's own container, outside this lane's host-process boundary
   stub, which no fake key survives. F1 was never about making that arm work —
   it was about what the operator sees when it cannot, and that IS driven
   (`06c`). What is written is exactly the durable state a successful save
   leaves behind (the DB-fallback credential row the connector reads when no
   Nango pointer exists). Both rows are ordinary plaintext JSON — the
   connector-config seal allow-map covers `nango.secretKey` only.
2. ~~**`mcpMode` was flipped** through the connector settings row, because of
   F2.~~ **RETIRED in round 2**: the switch is now performed from the UI by
   clicking the control in the failure state, and the receipt in `08` was earned
   on a mode set that way. The seed script still writes `function-tools` to
   establish the *failing* precondition — that is setting up the failure, not
   performing the fix.

Everything the PR actually changed — the provider choice, both connection forms,
the matcher constraint, the readiness saga and all of its rendered outcomes,
and now both fixes — was driven from the UI.

## Reproducing

```sh
# lane-unique services
docker run -d --name s6-2093-pg    -p 127.0.0.1:5648:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres -e POSTGRES_HOST_AUTH_METHOD=trust postgres:18-alpine
docker run -d --name s6-2093-redis -p 127.0.0.1:6598:6379 redis:8-alpine

# .env.local per the committed .env.example conventions, pointed at those ports,
# PORT=3293, a lane-unique BULLMQ_QUEUE_NAME, an unreachable NANGO_SERVER_URL
# (a freshly provisioned instance has no Nango), CINATRA_SKIP_DEV_PREFLIGHT=1.
pnpm auth:migrate

# the real dev boot + the boundary stub (same flags `pnpm dev` sets, plus --import)
LANE_STUB_DIR=$PWD/evidence/2093-s6-setup/stub \
NODE_OPTIONS="--disable-warning=DEP0169 --max-old-space-size=8192 \
  --import file://$PWD/evidence/2093-s6-setup/drivers/provider-boundary-stub.mjs" \
  node scripts/dev-server.mjs

node evidence/2093-s6-setup/drivers/signup.mjs          # real first-account form
node evidence/2093-s6-setup/drivers/reset-setup-state.mjs
LANE_MCP_NATIVE=1 node evidence/2093-s6-setup/drivers/setup-ai-walk.mjs
```

### Round 2 — the F1/F2 re-drive

Same stack; boot with `LANE_LEDGER` so the re-drive records into its own ledger
instead of appending onto round 1's:

```sh
LANE_LEDGER=egress-refresh.jsonl \
LANE_STUB_DIR=$PWD/evidence/2093-s6-setup/stub \
NODE_OPTIONS="--disable-warning=DEP0169 --max-old-space-size=8192 \
  --import file://$PWD/evidence/2093-s6-setup/drivers/provider-boundary-stub.mjs" \
  node scripts/dev-server.mjs

node evidence/2093-s6-setup/drivers/reset-setup-state.mjs
node evidence/2093-s6-setup/drivers/refresh-f1-f2-walk.mjs
```

The refresh driver needs no `LANE_MCP_NATIVE`: setting the mode is now part of
the walk, performed by clicking the control the failure state renders.
