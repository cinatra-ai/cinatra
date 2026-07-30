# cinatra#2094 — F9 and F10 from the S7 acceptance E2E

Two findings from `evidence/2094-s7-acceptance/e2e/PROOF.md`, grounded, reproduced
and fixed. **Neither root cause is the one its finding text names**, and both
re-diagnoses are measurements rather than readings.

| | F9 | F10 |
|---|---|---|
| the finding said | *"the OpenAI key cannot be saved from the wizard — `read ECONNRESET`"*, puzzling because `curl` returned 200 | *"the exact-binding failure does not name the provider"* — read as a UI gap |
| what it actually is | the save is hard-gated on a **second** service — the connection service — whose transport failure discards an OpenAI credential the action had already validated live | a **pre-stream 400 guard** answers a fixed generic string and shadows `BoundDefaultProviderUnavailableError` entirely; the client then discards the response body |
| fixed in | `cinatra-ai/openai-connector` | this repo |

**Two PRs, deliberately.** F9's fix is a change to `saveConnection` in the OpenAI
connector; only its wizard-facing *outcome channel* (a `?notice=` code → a warning
toast) lives here. They ship as a connector PR and a core PR, and the core one does
**not** consume the connector one — see *What this lane did NOT prove*.

---

## F9 — the wizard's OpenAI key save, and the second hop

### The transport difference, measured

`saveConnection` (openai-connector `src/actions-core.ts`) performs **two**
network hops, and only the first is the one `curl` reproduces:

1. `listAvailableOpenAIModels` → `fetch https://api.openai.com/v1/models` — **undici**;
2. `syncOpenAIConnectionToNango` → the connection service via `@nangohq/node` — **axios**.

The S7 egress ledger already settles which one failed: inside the
`B-openai-key-save` phase it records `GET /v1/models → 200`
(`evidence/2094-s7-acceptance/e2e/results/openai-arm.json`, `armProviderCalls`),
and the form still landed on `/setup/ai?error=read%20ECONNRESET`. So hop 1
succeeded and the reset came from hop 2 — the hop `curl` never touches. That was
the inference; `drivers/transport-attribution.mjs` makes it a **measurement**:

| wire condition | connection-service hop (real `@nangohq/node`) | OpenAI validation hop (real `fetch`) |
|---|---|---|
| FIN mid-request | `socket hang up` | `fetch failed` (cause `other side closed`) |
| **RST mid-request** | **`read ECONNRESET`** | `fetch failed` (cause `read ECONNRESET`) |
| RST on connect | **`read ECONNRESET`** | `fetch failed` (cause `read ECONNRESET`) |

**The `rst-on-connect` row is run-dependent and is reported as measured.** The
committed matrix is this lane's re-run (stable across 4 consecutive runs on this
machine). An earlier run of the same driver recorded `connect ECONNRESET
127.0.0.1:<port>` / cause `write EPIPE` on that row instead — the connect-time
race between the client completing its handshake and the server resetting decides
which. Nothing load-bearing turns on it: the **RST mid-request** row is
deterministic in every run, and T2a/T2b are asserted over *all* conditions, so
either matrix yields the same attribution.

`results/transport-attribution.json` — **5/5 PASS**. Three things fall out:

* the axios hop reproduces the S7 string **exactly**, and the connector's own
  `getNangoErrorMessage` passes it through verbatim (a transport error carries no
  HTTP `response`, so it falls through to `error.message`) — which regenerates
  `/setup/ai?error=read%20ECONNRESET` **byte-for-byte** from the measured value;
* the undici hop **cannot** produce that string under any condition: the system
  error is always demoted to `cause` behind `TypeError: fetch failed`. Even when
  the underlying errno *is* `ECONNRESET`, `error.message` is not — so the value
  S7 saw could not have come from the OpenAI call;
* therefore F9's own title mis-attributes the failure, which is why two lanes
  looked at the OpenAI fetch and found nothing.

**What is real and what stands in.** Both *clients* are the shipped ones — the
same `@nangohq/node` the nango connector constructs (`new Nango(...)`, axios,
proxy auto-detection off, exactly as `getNangoClient()` does) and the runtime's
own `fetch`. Only the *server* stands in, driven through the wire conditions a
service that is down actually produces. The S7 lane's own remote condition is
**not knowable** from the committed artifacts — that instance and its env are
gone — so the driver reports the condition → message MAPPING and names the
condition that reproduces the observed string, rather than claiming to know which
one that host was in. No credential is used anywhere in the driver.

### Why this is a product defect and not a lane artifact

`nango.isConfigured()` is TRUE whenever `NANGO_SECRET_KEY` is in the environment —
nango-connector's `getNangoSettings()` prefers env over the stored row — which is
the state of a fresh instance **before** the wizard's own Connections step has run.
So on the happy path of a fresh install the key save reaches hop 2 and dies there.

The incoherence is sharper than "it fails". When the connection service is merely
**absent**, the same save **succeeds**: the `if (apiKey && nango.isConfigured())`
guard skips the sync and the credential persists to the DB store — the shipped,
deliberate tolerance. A configured-but-**unreachable** service was therefore
treated as strictly *worse* than none at all, with no way forward and a bare
transport string pointing at the wrong service.

### The fix, and the invariant it preserves

The property that has to hold is **not** "the DB write is prevented" — it is
"**no UNVERIFIED credential is REACHABLE**". The read path
(`getConfiguredOpenAIConnection` → `getConfiguredOpenAIAPIKey`) is gated on the
**local pointer**, which is the "verified + committed" signal and is written only
on a readback match. So on any sync failure the fix:

1. clears the **local pointer** (`nango.clearConnectionRecords("openai")`) — a
   local store write, so it still works when the remote service is unreachable,
   and it *is* the whole read gate. **If that clear fails, the save is REFUSED**
   (the pre-fix posture, kept for exactly this case: a pointer left from an
   earlier rotation could otherwise still resolve an unverified credential);
2. best-effort deletes the remote connection — an unreachable service cannot be
   reached to clean up, and the orphan left behind is unreferenced and
   unreachable, which is the honest outcome, not a hole;
3. persists the live-validated credential and reports the degradation as a
   **distinct outcome** — never the plain success one: the save redirects to the
   success target plus `?notice=openai-connection-service-not-synced`, which the
   admin surface maps to a new warning-tone banner
   (`savedWithoutConnectionService`) and the wizard renders through a new
   codes-only `notice` flash channel, alongside a warning notification.

The wording of that report is bounded by what is actually **known**: the copy
"did not complete" and the remote state "could not be confirmed". It does **not**
claim the remote credential is gone — an import can commit server-side and only
then have its response torn, and step 2 is best-effort. What *is* known is that no
**verified pointer** remains, so nothing unverified can resolve. Step 2 is also
**time-bounded** (5 s), so a connection service that accepts and never answers
cannot stall the un-bricked save behind tidying.

`updateOpenAIConnection` stamps `lastValidatedAt`, so the resulting row is a
**ready** connection. That is not an assumption: it is exactly the state S7's own
`seed-provider-credential.mjs` produced out-of-band, and S7 then completed OpenAI
readiness on it (B3a–B3c PASS). The fix lets the **form** reach that state instead
of requiring a seed.

### Red → green

`openai-connector/src/__tests__/actions-core-ordering.test.ts`, driving the real
`saveConnection` with the measured `read ECONNRESET` failure:

| | pre-fix | post-fix |
|---|---|---|
| unreachable service → save | `?error=read ECONNRESET`, **no DB write** (RED) | `?notice=…` success redirect, pointer cleared, credential persisted, warning raised |
| readback mismatch → save | error redirect, no DB write (RED) | same degrade — pointer cleared, credential persisted |
| pointer clear itself fails | n/a | **error redirect, nothing saved** (fail-closed) |
| cleanup never settles | n/a | save still completes on the 5 s bound (fake-timer test) |
| invalid key | no sync, no write | unchanged |
| happy path | validate → sync → write | unchanged, same ordering |

All three F9 arms were confirmed **failing against the pre-fix `actions-core.ts`**
and passing after. The RED was re-observed in this lane against the CURRENT
`origin/main` of the connector (`37b8a98`, twelve commits past the base the fix was
first written on), by overwriting the worktree file with `git show
origin/main:src/actions-core.ts` and re-running — the index kept the fix, so
nothing was stashed. The pre-fix redirect it printed is the S7 landing URL
verbatim:

```
- "redirectUrl": "/setup/ai?stay=1&notice=openai-connection-service-not-synced"
+ "redirectUrl": "/setup/ai?error=read%20ECONNRESET"
```

### Three defects found while re-verifying the adopted fix

**1 — the budget timer leaked.** The bounded cleanup race never cleared its timer
when the cleanup won, so a 5 s handle stayed pending on the server after every
degraded save. Cleared in a `finally`.

**2 — the LOCAL pointer clear was UNBOUNDED (codex round 2).** The fix bounded the
*remote* cleanup but awaited `nango.clearConnectionRecords("openai")` with no
budget. It is a local store write, but it is still an await on a host port, and a
wedged config store would have hung the very save this change exists to un-brick.
Both awaits now go through one `withBudget` helper. The two callers differ in what
a timeout MEANS, deliberately: for the pointer clear a timeout **rejects and fails
closed** (identical to a throw — the save is refused), and only the best-effort
remote cleanup opts into tolerating it with its own `.catch()`.

**3 — attacker-influenced text reached a log and a persisted notification (codex
round 2).** The reason surfaced to the operator is the connection service's own
error, and `getNangoErrorMessage` **prefers** `error.response.data.error.message` —
server-supplied text. A misconfigured or hostile connection service that echoes the
submitted credential back in a validation error would have written the API key into
`console.warn` and into a stored notification body. `sanitizeConnectionServiceFailure`
now scrubs it: the exact in-flight key by literal match first (format-agnostic),
then a generic `sk-`/`rk-` pattern, then whitespace-collapse and a 300-char cap,
degrading to a fixed generic if nothing survives. Pinned by a test that drives a
sync error containing the real key and asserts it appears in neither sink while the
rest of the reason survives. **Honest limit:** this is redaction of the known
credential, not a universal secret detector — a *different* secret in the service's
error, or an encoded/fragmented rendering of this one, is not caught. Codex named
that limit and agreed it does not undermine the fix; the pre-F9 code put the same
unsanitized string in the URL, so this is strictly narrower than what shipped.

**Codex verdicts.** Round 1: `NOT MERGE-SAFE` on (2) and (3). Round 2, after both
fixes: `MERGE-SAFE`, confirming the timeout fails closed and that `Promise.race`
attaches a handler to the loser so a late rejection cannot go unhandled.

### The admin surface had the same silent-success hole

The degraded save redirects to whatever `redirectTo` the submitting form sent. Two
host surfaces send one:

* the setup wizard → `/setup/ai` — covered by the new `notice` flash channel;
* the **LLM admin modal** → `/configuration/llm?modal=openai`, and it posts to the
  **plain** `saveOpenAIConnectionAction`, *not* the schema-config `runWrite` path
  that maps the outcome to the `savedWithoutConnectionService` banner.

So on the admin modal a partial save landed on a page whose flash island watches
only `?saved=`, rendering as a **clean success** with the warning visible solely in
the notification centre — the precise failure mode this outcome channel exists to
prevent. `src/app/configuration/llm/apis-page.tsx` now mounts the same `notice`
entry, and the code + message live in one core module
(`src/lib/openai-partial-save-notice.ts`) consumed by both surfaces. Confirmed RED:
reverting `apis-page.tsx` to `origin/main` fails the two new admin-surface
assertions.

---

## F10 — the exact-binding failure never reached the code that names the provider

### Root cause

`POST /api/assistants/chat` rejects a turn **before the durable stream exists**:

```ts
const hasProvider = await hasConfiguredLlmRuntime();
if (!hasProvider) return Response.json({ error: "No LLM provider configured." }, { status: 400 });
```

Under the shipped **exact** binding, `resolveImplicitGlobalProviderOrder()` walks
**only** the stored provider (`policy !== "ordered"` ⇒ `[storedProvider]`). So the
S7 block-C arrangement — stored default `anthropic`, Anthropic credential removed,
a valid OpenAI credential left in place — fails at *this* guard. The producer's
`resolveBoundDefaultAdapter()`, and with it
`BoundDefaultProviderUnavailableError` — the class written for the sole purpose of
naming the provider — is **never reached**. The guard emitted precisely the
"useless generic" that error exists to replace.

The client then finished the job:

```ts
if (!response.ok) throw new Error("Chat request failed.");
```

The 400's body was discarded unread. That matches the S7 capture exactly
(`screenshots/C1-exact-binding-failure.png`: **"Something went wrong / Chat
request failed."**) and it explains block C's otherwise-odd shape — `serverLine`
empty (no `BoundDefaultProviderUnavailable` was ever logged, because none was
ever thrown) and zero provider calls (the rejection precedes any producer).

Note what this was **not**: the renderer's 300-char generic-substitution guard was
the obvious suspect and is innocent — the exact-binding message is 264 chars and
passes through verbatim, which the drift pin below now keeps true.

### The fix

* `packages/llm/src/registry.ts` gains `describeLlmRuntimeUnavailability()`: the
  provider-naming **reason** (or `null` when a runtime is available), worded by the
  error class itself so there is one wording. `hasConfiguredLlmRuntime()` now
  **delegates** to it for the no-preference case, so the boolean and the reason
  cannot disagree about the same world — parity is structural, not asserted.
* both route guards use it. **The decision and the 400 status are unchanged**;
  only the body's reason changes, plus a machine-readable
  `code: "llm-provider-unavailable"`.
* **the guards MOVED behind authentication and authorization.** They previously ran
  before the session check, which was harmless while the body was a constant.
  Naming the stored provider makes that body privileged configuration, so the
  cookie guard now sits after `getAuthSession`/401 and `authorizeThreadForTurn`/403,
  and the widget guard after the entire dual-token fail-closed sequence. The
  decision reads no request input, so an authorized caller is unaffected. Pinned by
  tests asserting a 401 and a 403 caller see no provider name **and** that the
  availability probe is never even reached for them.
* the chat client renders a server reason only for an **allow-listed** shape —
  HTTP 400 + that `code` + a string `error`. Any other status, any other/missing
  code, a non-string error, HTML, an unparseable or empty body all keep
  `"Chat request failed."`, so an arbitrary 5xx, a proxy error page or a
  stack-bearing JSON can never reach the banner. The admitted reason goes through
  the reducer's own `extractErrorMessage` **already unwrapped** (the normalizer
  applies its 300-char cap *before* its `{error}` unwrap, so handing it the raw body
  bypassed the cap), then whitespace-collapsed and hard-sliced as a backstop for a
  reason that is itself nested JSON.

### Red → green

| test | asserts |
|---|---|
| `src/app/api/assistants/chat/__tests__/route.test.ts` | the 400 body **names** `anthropic`, carries the code, is not the generic, and no producer/turn is started. **Confirmed RED** against the pre-fix generic body |
| …same file | a **401** and a **403** caller get no provider name, and the availability probe is never reached for them |
| `packages/chat/src/__tests__/ag-ui-chat-client.test.ts` | a 6-case refusal matrix (wrong status, no code, other code, non-string error, HTML, empty) all keep the generic; and both oversize bounds hold |
| `src/app/setup/__tests__/setup-flash-notice.test.ts` | the partial-save code is mapped on the **`notice`** param as a **warning**, never on the `error` channel, and the codes-only protocol holds; core's literal matches the connector's; and the **LLM admin surface** mounts the same warning entry (**confirmed RED** against the pre-fix `apis-page.tsx`) |
| `packages/llm/src/__tests__/bound-default-unavailability-naming.test.ts` | the reason is the error class's own wording; `null` when available; both failover policies; **decision parity with `hasConfiguredLlmRuntime` across six arrangements**; the scripted-provider seam intact |
| …same file, drift pin | every provider × policy message stays **≤300 chars** — the renderer's generic-substitution cap — so the name can never silently vanish again |
| `packages/chat/src/__tests__/ag-ui-chat-client.test.ts` | a 400 whose body names the provider throws/renders that reason; a body-less failure keeps the generic |
| `packages/chat/src/renderer/__tests__/ag-ui-interactive.test.tsx` | the **rendered** banner carries `anthropic` verbatim — not "The request failed", not "Something went wrong". A **drift pin, not a red-green**: the renderer was never the defect (it passes a 264-char message through untouched), and this test passes against the pre-fix renderer too. It exists so the wording can never grow past the cap and silently lose the name |

The three suites use the identical message literal, and the `llm` test pins that
literal to `new BoundDefaultProviderUnavailableError(...).message`.

### The S6 AC3 purpose-policy gate — a regression this fix introduced, and closed

`describeLlmRuntimeUnavailability` is a **new implicit-default resolver**: called
with no argument it walks `resolveImplicitGlobalProviderOrder()` and therefore
takes the operator's stored-default decision, exactly like the
`hasConfiguredLlmRuntime()` call it replaced at both route guards.

`src/lib/__tests__/llm-purpose-policy-inventory.test.ts` (the S6 cinatra#2093 AC3
gate) mechanically re-derives every such site from the source tree and fails if
one is unregistered or if a registered entry has gone stale. Swapping the guard
without teaching the gate the new resolver name **broke it**, and the failure was
observed, not reasoned about:

```
FAIL … > no inventory entry is STALE …
+ [ "assistant-availability-gate: src/app/api/assistants/chat/route.ts no longer resolves a provider at all" ]
```

Two things were wrong at once, and the red only showed the second: the entry read
as stale, **and** — more seriously — the scanner no longer saw the route's two
guard calls at all, so from that point on a new implicit default could have been
added there with no inventory entry and the gate would have stayed green. Fixed by
adding `describeLlmRuntimeUnavailability` to `IMPLICIT_RESOLVERS`, which restores
both halves (green again, and the two call sites are covered by the
`assistant-availability-gate` entry). That entry's `what` is also updated: the
guard no longer merely "refuses a turn when no LLM runtime is configured" — it
names the stored provider.

---

## What this lane did NOT prove

Stated plainly rather than papered over:

* **The browser rung was not re-driven.** S7's block B and block C run against a
  full instance (111 pinned companion repos, 73 real migrations, real provider
  keys, an isolated Chromium). That is a multi-hour staged bring-up, not a
  one-shot lane, and it was not attempted here. F9's fix is proven at the **real
  action boundary** with the **measured** transport failure, and F10's at the
  **real route → real client → real reducer → real banner** boundary; neither is
  proven through a live wizard/`/chat` page in this lane.
* **No S7 driver was re-run**, and no S7 artifact was edited. The block B and
  block C verdicts in `evidence/2094-s7-acceptance/` still record what that run
  measured.
* **The required-extension lock is deliberately NOT re-pinned here.** It pins
  `openai-connector` at `255a44b2`, several commits behind that repo's `main`, so
  bumping it to carry the F9 fix would drag in every intervening connector change
  — the F12-class pin lag, which is a coordinator/owner decision, not a lane's.
  The F9 fix therefore lands in the connector PR; **this repo does not yet
  consume it.**
* **The connector's ESLint could not run locally**: its dev dependencies are not
  installed on this machine and `pnpm install` in that repo 404s on the gatekept
  `@cinatra-ai/*` registry. Its **vitest does** run — **93/93 pass, 13/13 files** —
  after symlinking the one runtime dep its stale `node_modules` lacked (`openai`,
  a declared dependency since `255a44b`, unrelated to this change). The connector's
  own CI is the authority for lint.
* **The connection-service hop is proven on the real client, not through the
  connector's own `syncOpenAIConnectionToNango`.** The driver issues the identical
  request that function issues (`nango.http.post(${serverUrl}/connections, …)`,
  transcribed and diffed against `nango-connector/src/nango.ts
  importNangoConnection`) on the identical client (`new Nango(…)` with
  `http.defaults.proxy = false`, as `getNangoClient()` builds it). Driving the
  connector function itself would need a live Nango settings store, so the last
  inch between "the same client, the same request" and "that function" is
  **argued from a transcription, not measured**.

## Root-repo suite status at the time of writing

`vitest run` at the repo root: **14345 passed, 6 failed / 14 files failed**. None
are in this change's blast radius, and that was **verified rather than asserted**:
every one of our source edits was reverted in the worktree, the same 14 files were
re-run, and they failed identically (`14 failed`, same 6 tests). They are
install-state fallout from the commits this branch rebased onto — e.g.
`@modelcontextprotocol/server` (new in `8484bc25b`) is absent from this
`node_modules`, and `org-write-edge-writer-inventory` reads
`src/app/api/webhooks/wordpress/route.ts`, deleted by `20b51de6c`. Typecheck is the
same story: **9 errors, 0 in any touched path**.

## Files

| path | what |
|---|---|
| `drivers/transport-attribution.mjs` | the two-hop transport attribution, real clients, wire-condition matrix |
| `results/transport-attribution.json` | 5/5 PASS + the measured condition → message mapping (this lane's own re-run) |
