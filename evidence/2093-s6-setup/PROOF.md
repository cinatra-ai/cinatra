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

## Where the walk ran

| | |
|---|---|
| host | `cinatra` @ PR #2213 head `13702058caaf4bed93b382ca3a8dd01beff0c15a` |
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
| d0 | Anthropic key **save** through the wizard form | **NOT DRIVEN** | see §Findings — it throws, and the throw is not caught |
| d1 | readiness failure renders actionably | **PASS** | `AI setup did not complete (native-skills-probe)` + the fix-forward naming the MCP-mode switch |
| c1 | Anthropic saga reaches a valid receipt | **PASS** | `22 skill(s) uploaded, and Claude accepted a container.skills request` |
| c2 | the probe carried BOTH halves of the reference | **PASS** | `{"skill_id":"skill_lane2093_45","version":"v1","type":"custom"}` |

Machine-readable: `walk-results.json`. One page error was recorded during the
whole walk — the d0 throw itself, quoted in §Findings.

## Screenshots

| # | state |
|---|---|
| `01-provider-choice` | neither provider picked — the choice + "Pick a provider to continue" |
| `02-openai-form` | OpenAI selected, its connection form below the choice |
| `03-openai-key-saved` | key validated and saved |
| `04-openai-receipt` | OpenAI receipt + Continue |
| `05-anthropic-form-matcher-constraint` | Anthropic selected — key form, egress advisory, **and** the matcher-constraint alert |
| `06a-anthropic-key-save-unhandled-error` | the d0 finding, captured as it renders |
| `06b-anthropic-connection-stored` | the step with an Anthropic connection stored |
| `07-readiness-failure` | **flow (d)** — the `function-tools` fix-forward, plus the codes-only wizard toast |
| `08-anthropic-receipt` | **flow (c)** — `22 skill(s) uploaded, and Claude accepted a container.skills request`, then Continue |

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

### Durable state after the walk

```
connector_config:llm_default_provider          "anthropic"
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

### F2 — `mcpMode` has no affordance anywhere the operator can reach during setup

The saga's success arm requires the Anthropic connection's `mcpMode` to be
`native`; the default is `function-tools`, and the failure message correctly says
*"Switch the Anthropic connector's MCP mode to 'native' in its settings"*. But
every authenticated admin route redirects back into the wizard while setup is
incomplete, so during setup there are no such settings to reach. The fix-forward
is accurate and currently unfollowable from inside the wizard.

## The two out-of-band steps, named

Neither is a simulation of the surface under proof; both are recorded so the
walk cannot be mistaken for more than it is.

1. **The Anthropic connection state was seeded directly**
   (`drivers/seed-anthropic-connection.mjs`) instead of being saved through the
   form, because of F1 — and because, even with Nango up, its import has Nango
   verify the credential against the **real** Anthropic API from inside Nango's
   own container, outside this lane's host-process boundary stub, which no fake
   key survives. What is written is exactly the durable state a successful save
   leaves behind (the DB-fallback credential row the connector reads when no
   Nango pointer exists). Both rows are ordinary plaintext JSON — the
   connector-config seal allow-map covers `nango.secretKey` only.
2. **`mcpMode` was flipped** `function-tools` → `native` through the same
   connector settings row, because of F2.

Everything the PR actually changed — the provider choice, both connection forms,
the matcher constraint, the readiness saga and all of its rendered outcomes — was
driven from the UI.

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
