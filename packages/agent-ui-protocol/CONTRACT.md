# The unified assistant-stream contract

**Contract version: `1.0.0`** · Package: `@cinatra-ai/agent-ui-protocol` · Owner: epic #1216, stage S1 (#1217)

This is **the** single, versioned wire that carries every assistant conversation
in Cinatra — first-party `/chat` and every embedded assistant alike. There is
exactly one contract and no per-surface fork. This document is the written spec;
the machine-checkable half lives beside it in `src/` (`contract.ts`,
`handshake.ts`, `renderable-views.ts`, `events.ts`, `conformance.ts`) and is
re-exported from the dedicated tier-neutral entry point
`@cinatra-ai/agent-ui-protocol/stream`. It is a SEPARATE entry from the package
barrel by design: the latency-budgeted routes reach the barrel transitively, so
the contract lives on its own subpath to avoid inflating routes that never use
it (`stream.ts` explains the route-graph-ratchet constraint). The durable
publish/subscribe transport stays in `@cinatra-ai/agent-ui-protocol/server`.

The contract version above is negotiated by the capability handshake
(§4). It is independent of the npm package version — it tracks the **wire**, not
the package release.

---

## 1. Scope — and the named boundary with #1037 P2

This contract owns **the resumable UI-transport semantics and the event
vocabulary** over the durable AG-UI log. It does **not** own thread persistence,
attribution, or the turn↔run linkage. Those belong to **#1037 P2** (the
assistant runtime), which *produces* events into the log this contract streams.

| Concern | Owner |
|---|---|
| The one wire: event vocabulary, durable/resumable transport, capability handshake, renderable-view schema | **this contract** (#1217 / epic #1216) |
| Thread model, message persistence, attribution, turn↔run linkage; the producer that emits events into the log | **#1037 P2** |

The AG-UI log (`cinatra:a2a:events:{runId}`, Redis Streams) is the shared
substrate. This contract defines its event envelope and how a UI consumes it;
#1037 P2 fills it. A conformance change on either side is bound by one fixture
corpus and one conformance CI (S6, #1222), which gates both epics.

A **turn** is one AG-UI run in a thread: the events between a `RUN_STARTED` and
its terminal frame (`RUN_FINISHED` / `RUN_ERROR`).

## 2. The surfaces (one vocabulary, three targets)

Every surface is an AG-UI client of one assistant endpoint; the endpoint shape
is identical and only auth parameterization differs (§4).

- **`chat`** — first-party `/chat`.
- **`embedded-view`** — the generic Cinatra-served conversation view (an iframe).
- **`cms-iframe`** — a CMS-hosted embed of that same view (WordPress / Drupal).

The render-parity conformance CI renders the fixture corpus across all three and
fails on divergence.

## 3. Event vocabulary

The turn is carried by the AG-UI event union (`AgUiEvent` in `events.ts`):

`RUN_STARTED` · `RUN_FINISHED` · `RUN_ERROR` · `TEXT_MESSAGE_START` ·
`TEXT_MESSAGE_CONTENT` · `TEXT_MESSAGE_END` · `TOOL_CALL_START` ·
`TOOL_CALL_END` · `STATE_SNAPSHOT` · `INTERRUPT` · `RESUME` · `DATA_PART`.

`INTERRUPT`/`RESUME` carry human-in-the-loop (HITL) approval gates. `DATA_PART`
carries a structured JSON payload and is the extension point for
assistant-specific renderable views (§5). `isAgUiEvent()` (`conformance.ts`) is
the structural validator for a single wire event.

### 3.1 Typed lifecycle interactions on `INTERRUPT` (cinatra#2568)

An `INTERRUPT` may carry an **optional** `interaction` discriminator:

```jsonc
{
  "type": "INTERRUPT",
  "threadId": "…", "runId": "…",
  "schema": {}, "values": {},
  "xRenderer": "@cinatra-ai/lifecycle:recommendation-hold",
  "reviewTaskId": "recommendation:run-start:<runId>",
  "interaction": { "kind": "recommendation_hold", "schemaVersion": 1, "ref": "<opaque>" }
}
```

- **Routing rule.** An interrupt WITH `interaction` is **not a review task**; it
  must not be submitted to the review-task approve path. It routes by `kind` to
  that interaction's own decision actions. An interrupt WITHOUT it keeps exactly
  the pre-existing behaviour.
- **Which kinds.** Only interactions whose carriage is `interrupt` in the
  lifecycle-card registry (`renderable-views/lifecycle-cards.ts`) — today
  `recommendation_hold`, where the run is genuinely BLOCKED on the answer.
  Everything else is a `DATA_PART` renderable view (§5.1).
- **Refs only.** The payload is an opaque server-minted `ref` and nothing else —
  no state, no ids, no candidate data. The card resolves the authoritative state
  server-side against the reader.
- **Handshake-compatible.** The field is additive and optional, so every
  previously-published event stays valid, `isAgUiEvent()` accepts both shapes,
  and the contract version does **not** move (§8). A client that does not know
  the field ignores it and renders its generic interrupt fallback; because the
  payload carries no decision affordance, an unaware client can draw nothing
  harmful from it. Validate with `readLifecycleInterruptInteraction()` — never
  by hand-reading the keys.
- **Not replayed blindly.** A run can re-enter its held state, so its log may
  carry several hold announcements of which at most one is live. The run's SSE
  route synthesizes the CURRENT interaction from live state at stream open and
  drops log frames the live state does not confirm.

### 3.2 Slot identity on `DATA_PART` (cinatra#2827)

A `DATA_PART` may carry an **optional** `toolCallId` — the id of the tool call
the part was produced by:

```jsonc
{
  "type": "DATA_PART",
  "toolCallId": "call_7f3a",
  "data": { "viewType": "artifact_review_gate", "schemaVersion": 1, "ref": "<opaque>" }
}
```

- **It is on the EVENT, not in `data`.** A renderable-view payload is validated
  by a `.strict()` schema whose whole point is "the wire payload is a ref, never
  content" (§5.1); a producer may not add a field to it. The slot says *where in
  the turn the part was produced*, which is transport information about the
  event — exactly like `partIndex` beside it — so it rides there and the payload
  stays byte-identical to what a strict parser already accepts.
- **What a consumer does with it.** A renderable view carrying one belongs in
  the ordered trace **at that call's own position** rather than appended after
  the turn, so the card a person is asked to act on sits at the step that
  produced it. A consumer that does not know the field — or that receives an id
  matching no tool call it holds — keeps **exactly** the previous behaviour and
  renders the view as a turn-level adjunct. The field adds a position; it never
  gates a render.
- **Handshake-compatible.** Additive and optional: every previously-published
  event stays valid, `isAgUiEvent()` accepts both shapes, and the contract
  version does **not** move (§8).
- **Not an authorization.** Like every other id on this wire it is an opaque
  correlation string. Forging one buys a card drawn at the wrong step of the
  forger's own turn and nothing more, because what a lifecycle card may show is
  re-authorized server-side from its ref on every resolve.

## 4. Durable, resumable transport

The wire is **Server-Sent Events over the durable Redis-Streams AG-UI log**. It
is proven by the existing run-stream route `GET /api/agents/runs/{runId}/stream`;
this contract generalizes that shape to the assistant endpoint. Descriptor:
`ASSISTANT_STREAM_TRANSPORT` in `contract.ts`.

- **Durable append.** Producers `XADD` each event to `cinatra:a2a:events:{runId}`
  (`MAXLEN ~ 1000`). Every event is retained for the run's replay window, not
  merely fanned out to live subscribers.
- **`id:` frames.** Each SSE event frame carries `id: <redis-stream-entry-id>`.
  Entry IDs are `<unix-ms>-<seq>` — never contain U+0000/U+000A/U+000D, so they
  are always valid SSE `id:` values per the WHATWG SSE spec.
- **Resume via `Last-Event-ID`.** A reconnecting client sends the last id it saw
  as the `Last-Event-ID` request header (the browser `EventSource` does this
  automatically). The server resumes from **exactly the un-replayed suffix** — no
  events lost across a transient drop. Parse the header with
  `normalizeResumeCursor()` / `isValidStreamCursor()` (a cursor is
  `<digits>-<digits>`; a malformed value is treated as absent).
- **Full replay.** A fresh subscriber that needs the whole history (e.g. a run
  already `pending_approval` on first connect) resumes from the
  `REPLAY_FROM_START_CURSOR` sentinel (`0-0`).
- **Bounded retention — resume is exactly-once WITHIN the replay window.** The
  durable log is not infinite: it is capped at `MAXLEN ~ 1000` (older entries are
  evicted once a run exceeds it) and the stream key is given a TTL (~1 h) after a
  terminal frame. Resume is lossless **only while the cursor is still inside that
  window**. A `Last-Event-ID` older than the earliest retained entry (a very long
  disconnect on a very long run, or a reconnect after the terminal TTL expired) is
  a **stale cursor**: the server cannot prove the suffix is complete, so the
  client MUST NOT treat a resumed tail as authoritative. The client re-seeds from
  the DB-backed REST snapshot (the same first-paint seed the run-detail route
  serves) and then tails from now — it never silently drops the un-retained gap.
  "No events lost" is therefore scoped to the retention window, not claimed
  unconditionally.
- **Terminal frames.** After a `RUN_FINISHED` or `RUN_ERROR` the server closes
  the stream (`TERMINAL_EVENT_TYPES`).
- **Transport errors are not run errors.** A dropped connection closes silently
  and is logged server-side; it does **not** synthesize a `RUN_ERROR` frame. The
  browser reconnects with its cached `Last-Event-ID`. `RUN_ERROR` means the run
  itself failed.
- **Keepalive.** The server emits SSE comments (`: keepalive`) to hold idle
  connections open.

## 5. Capability handshake

The single capability + version negotiation for every surface, replacing the
bespoke `GET /api/agents/{slug}/capabilities` negotiation. Types + negotiation:
`handshake.ts`.

The server advertises `AssistantStreamCapabilities`:

- `contract` / `supportedContracts` — the contract version(s) it speaks.
- `resumable: true` — the durable-log resume of §4 is intrinsic; advertised so a
  client can assert it.
- `transport: "sse"`.
- `auth` — the modes the surface accepts: `session` (first-party `/chat`, cookie
  session) or `token-broker` (every embedded surface, a short-lived same-origin
  `cit_`/`cwu_` token; the browser never holds a long-lived key).
- `renderableViews` — the renderable-view `viewType`s (§5.1) the surface **may**
  emit. **Advisory**: a client renders the ones it knows and falls back safely
  for the rest; an absent entry never gates rendering.

The client negotiates with `negotiateContract()`, which picks the highest
mutually-supported version and **fails closed** when there is none
(`{ ok: false, reason: "no_mutual_contract" }`) — no optimistic default, no
legacy fallback; the surface does not mount on an incompatibility.

`negotiateStreamContract(clientHello, serverCaps)` is the full handshake: it
composes the version negotiation with an **auth-mode assertion** and a
**required-view assertion**, each fail-closed, and returns the FIRST failure so
the surface can render one precise reason. Two deliberate properties:

- **Auth is declarative, never downgraded.** The client states in its
  `StreamClientHello` the single mode it will present; the handshake asserts the
  server accepts it (`auth_mode_unsupported` otherwise) and never selects a
  weaker mode. The server route still enforces the mode for real — the handshake
  does not replace enforcement.
- **`requiredViews` is a fail-closed pre-check, not a filter.** A view the client
  *requires* but the server cannot emit fails the handshake
  (`required_view_unsupported`). Views the client merely *supports* are NOT
  listed — the server never filters the shared durable log by client capability;
  the client renders the views it knows and falls back on the rest (§5.1).

**No bespoke names survive.** The retired negotiation advertised a
`contractVersion` string, a frozen SSE frame list
(`["text","changes","error","done"]`), and per-behavior boolean flags
(`supportsChangesFrame`, `supportsMarkdown`, …). **None** of those names appear
in this contract: version is `contract` (semver, negotiated), and capability is
expressed as the extensible `renderableViews` list, not a frozen frame set. A
unit test asserts the built advertisement carries none of the retired keys.

### 5.1 Renderable-view schema & extension points

Assistant-specific views (the CMS change-diff, artifact previews, …) travel as
**typed `DATA_PART` payloads** discriminated by a namespaced `viewType`
(`renderable-views.ts`). This is the schema seam **S4 (#1220)** fills, and it is
designed so S4 registers a view **without forking the contract**:

- A view payload extends `RenderableViewBase` (`{ viewType: string }`).
- Registered payload **types** live in the open `RenderableViewRegistry`
  interface. A stage registers a view by **declaration-merging** a keyed entry —
  no new top-level event, no change to this module:

  ```ts
  export type ContentChangeProposalView = RenderableViewBase & {
    viewType: "content_change_proposal";
    fields: Array<{ field: string; before: string; after: string }>;
    nodeId?: string;
    postId?: string;
    rich: boolean;
    // Correlation ids (S4, Option A — owner decision 2026-07-10 on #1220):
    // the producing agent already saved the change as a draft DURING the run
    // through the CMS MCP integration (#1214); accept performs NO server
    // write — it refreshes the editor in place to that saved draft. These ids
    // tie the card (and the S5 refresh intent) to the already-written draft
    // without re-deriving it. Opaque correlation strings, never authorization.
    proposalId?: string;
    changeSetId?: string;
  };
  declare module "@cinatra-ai/agent-ui-protocol" {
    interface RenderableViewRegistry {
      content_change_proposal: ContentChangeProposalView;
    }
  }
  ```

- Consumers use `isRenderableViewDataPart(event)` to detect a renderable-view
  `DATA_PART`, and `isRenderableViewOfType(data, "content_change_proposal")` to
  narrow to the registered payload type at a call site.
- **Unknown views are safe.** A `DATA_PART` whose `viewType` is not (yet)
  registered is still recognized as a renderable view, but matches no registered
  type — so the renderer shows its safe fallback and never crashes. This is the
  "unknown `DATA_PART` payloads" case in the render-parity checklist.

**The registered inventory (S4 survey result).** The epic's full
assistant-specific-view inventory splits into two classes — per its own "no
bespoke frames" criterion:

- **Registered `DATA_PART` renderable views** (versioned schemas in
  `renderable-views/`, one renderer component each):
  `content_change_proposal` (the change-diff), `artifact_preview`,
  `citation_group`, `change_history`.
- **Mapped onto existing top-level events — NOT re-registered as views**:
  tool-call progress/result cards, inline agent-run cards, HITL interrupt
  forms, thinking groups, and streaming/partial states fold from
  `TEXT_MESSAGE_*` / `TOOL_CALL_*` / `INTERRUPT`/`RESUME` / structural
  `DATA_PART`s in the renderer's event-to-UI reducer; error states are
  `RUN_ERROR`; capabilities and recoverable-auth / capability-denied states
  ride the capability handshake (§3).

Adding a view later stays a registry augmentation (schema + component); the
mapped class never grows a bespoke frame.

The change-diff is the primary S4 porting target: it moves from the bespoke
`changes` SSE frame (`{ fields, nodeId, postId }`, applied by a full page
reload) to a `content_change_proposal` renderable view **refreshed in place**
(Option A, owner decision 2026-07-10: the agent already saved the draft during
the run through the CMS MCP integration under OBO; accepting performs no
server write — the editor refreshes to the saved draft, correlated by
`proposalId` / `changeSetId`). The **renderer component** keyed by `viewType`
and the display-only applied/refresh affordance are S4's concern; the
editor-patch consumer (the refresh executor in the CMS widgets) is S5's
(#1221) — this contract owns only the payload-type seam.

### 5.2 Tool-manifest report (cinatra#3487)

A read-only report of the tools that the chat composer and the run window would
hand to the model, so that a test can compare the two without reading the DOM.
This section is the spec only. The route does not exist yet; a later product
change adds it with its own tests.

**Route.** `GET /api/assistants/chat/tool-manifest`, beside the capability
route `src/app/api/assistants/chat/capabilities/route.ts`. GET only; there is
no write method. One request returns BOTH reports, the composer's and the run
window's, assembled from one set of reads (see "One snapshot"). There is no
single-road mode.

**Auth.** The same as the session branch of the capability route's GET:
`getAuthSession()`, and no `session.user.id` gives
`401 { "error": "Unauthorized" }`. The report names instance-specific tools, so
it is never served to the broker-auth embed: a `cit_` bearer gives the same 401,
fail-closed, with no fall back to the cookie session (the auth-confusion guard
of the capability route). A widget manifest is out of scope.

**Parameters.** Exactly three query parameters, all required, each given once:

- `threadId` — the composer's thread.
- `runId` — the run whose page shows the window.
- `surface` — one of `RUN_WINDOW_SURFACES`
  (`packages/agents/src/run-window-conversation-store.ts`): `run-page`,
  `step-by-step`, `schedule`, `armed-trigger`, `review`. The run's window with a
  review screen active is `surface=review`.

The surface is echoed and selects nothing (ruling of 2026-09-14 on
cinatra#3487: the screen context is additive, never a restriction). The route
has no allow-list, filter or mode parameter.

**The inputs of each road.** Each report is assembled from the inputs that its
road hands to `runAssistantTurn` (`src/lib/assistant-runtime/runtime.ts`) today,
read the way that road reads them, with the config
`buildCinatraAssistantRuntimeConfig()`
(`src/lib/assistant-runtime/cinatra-assistant-config.ts`) that both roads use
(cinatra#3487 item 5):

- Composer — the cookie branch of `POST /api/assistants/chat` with no
  `assistant` selector (`runChatTurn`, `src/app/api/chat/runner.ts`): the
  session's user; `requireActorContext()`; `platformRole` from
  `isPlatformAdmin(session)`; `sessionOrgId` from the session's
  `activeOrganizationId`; `sessionId` = `threadId`, after
  `authorizeThreadForTurn` (`src/lib/assistant-runtime/ag-ui-stream-route.ts`)
  admits the thread. A thread with no row is assembled as a new thread (no
  assignment scope); the route never claims or writes it.
- Window — `runWindowTurn` (`src/lib/lifecycle/run-window-turn.ts`): the actor
  that `requireRunWindowAccess(runId, "read")` resolves;
  `resolveUserContextForUserId(actor.userId, { activeOrganizationId:
  actor.orgId, platformRole: actor.platformRole })` for `actorContext`,
  `platformRole` and `sessionOrgId`; NO `sessionId`, because `runWindowTurn`
  passes none (the runtime then mints a per-turn id, which has no thread scope).

The lent-action grant and the run frame are not inputs of the report: they
change only the self-MCP reference's headers and the system text, which the
report excludes. If a later change gives the window a `sessionId`, this list
changes with it in the same change.

**One snapshot.** Within one request the route does each read once for each
distinct input value, and both roads use that one result: the provider adapter
(resolved as `runAssistantTurn` resolves it), the skill registration state, the
external MCP tools (`resolveChatExternalMcpTools(provider, { surface: "chat" })`
in `packages/llm/src/registry.ts`), the self-MCP catalog state (one read for
each distinct subject user, organization and platform role), the injected skill
set (one read for each distinct `sessionId` value, absent included), and the
skill delivery (one call for each distinct list of catalog skill ids). A state
change between the two roads' reads therefore cannot occur when their inputs are
equal; when the inputs differ, the reports may differ, and that difference is
real.

**One source.** The product change extracts the tool assembly of
`runAssistantTurn` (conversation-only check, injected skill set, skill
delivery, self-MCP reference, external MCP tools, skill tools, `web_search`,
then `isAllowedByList` from `src/lib/assistant-runtime/ports.ts`) into one
function that `runAssistantTurn` and this route both call. The route never keeps
a second list of tools.

**Read only.** The extracted function only reads. It inserts, updates and
deletes nothing, mints no actor token and no lent-action grant, sends no stream
event, persists no delivery record, and makes no network call to a model
provider or to an MCP endpoint. Its write steps stay in `runAssistantTurn`,
before and after the call: the skill registration
(`ensureAssistantSkillsRegistered`: `ensureInstalledSkillsRegistered` and
`retireSupersededChatSkillsOnce` in
`packages/skills/src/extension-skill-resolver.ts`), the token mint, the grant
(`issueTurnLentActionGrant`), the reachability probe
(`checkPublicMcpReachability`) and the delivery record. The function takes the
token issuer as a port; the route passes an issuer that returns an inert fixed
value and never mints. Because the route does not register skills, it first
reads whether this process has already registered every id of
`runtimeConfig.skillIds` (the per-process `registrationMemo`, through a new
read-only accessor) and has settled the retirement; if not, it answers
`503 skills_not_registered` and never a manifest that the next turn could
change. Unit E proves this with a test that runs the route against recording
ports and stores and asserts zero writes, zero mints and zero provider or MCP
calls.

**Declared, not reachable.** The report is the pre-dispatch manifest: the tools
that the turn would hand to `stream()` if it passed every later check. It runs
no reachability probe and mints nothing, so a turn can still stop where the
report answers 200 (an unreachable public MCP URL, a failed token mint). The
item 7 test compares the two declared manifests; it does not claim that a turn
reached a provider. Tools that the LLM layer adds or translates inside
`stream()` per provider are not part of the report; both roads call the same
`stream()` with the same arguments shape.

**Response.** `200`, `Cache-Control: no-store`, JSON:

```json
{
  "manifestVersion": 1,
  "composer": {
    "threadId": "...",
    "conversationOnly": false,
    "tools": [
      { "ref": { "type": "mcp", "serverLabel": "..." }, "schemaHash": "hmac-sha256:<hex>" },
      { "ref": { "type": "web_search" }, "schemaHash": "hmac-sha256:<hex>" }
    ],
    "manifestHash": "hmac-sha256:<hex>"
  },
  "window": {
    "runId": "...",
    "surface": "review",
    "conversationOnly": false,
    "tools": [],
    "manifestHash": "hmac-sha256:<hex>"
  }
}
```

- `conversationOnly` — `true` when the resolved provider takes no tools; then
  `tools` is `[]`.
- `tools` — one entry for each tool of the assembled array, in its order, after
  the allow-list filter. `ref` is an `LlmToolReference`
  (`packages/sdk-extensions/src/llm-provider-adapter-contract.ts`). No other
  field of a tool is returned.
- `schemaHash` — HMAC (keyed SHA-256) of the canonical JSON of the tool's projection
  (below), lowercase hex.
- `manifestHash` — HMAC (keyed SHA-256) of the canonical JSON of
  `{ "conversationOnly": ..., "tools": [...] }` of that report, lowercase hex.
- The HMAC key is 32 random bytes made for this one response. It is never
  returned, logged or stored. Hashes therefore compare only within one
  response, and a hash cannot be used to guess a text offline.

**Projection.** Each tool contributes exactly these fields and nothing else.
An absent or `undefined` optional field is written as `null`, except where a
default is named:

- function (`type` absent or `"function"`): `type: "function"`, `name`,
  `description`, `parameters`.
- `mcp`: `type`, `serverLabel`, `serverUrl`, `serverDescription`,
  `allowedTools`, `approval` (absent = `"auto_execute"`), `transport`
  (absent = `"unknown"`). Never `headers` or `authorization`.
- `shell`: `type`, `skills` (each `name`, `description`, `path`, in order),
  `stagedSkills` (each `skillId`, `slug`, `description`, in order).
- `container_skills`: `type`, `skills` (each `skillId`, `version`,
  `catalogSkillId`, in order).
- `sandbox_execution`: `type`, `toolName`, `description`, `stagedSkills` (as for
  `shell`).
- `web_search`: `type`.

`execute`, `resolveFiles`, `onRead` and every other function are never read. A
kind that is not in this list is a `503 assembly_failed`, so a new union member
cannot pass unhashed.

**Canonical JSON.** RFC 8785 (JSON Canonicalization Scheme) over the
projection: object keys sorted by UTF-16 code units at every depth, arrays in
order, no white space, strings escaped as RFC 8785 states and not normalized,
numbers in the ECMAScript form (`-0` is `0`). Inside `parameters` an object
member whose value is `undefined` is left out (as `JSON.stringify` does). A
non-finite number, a `bigint`, a function or a symbol anywhere in the projection
is a `503 tool_unserializable`. The repository has no general RFC 8785
function today (the `canonical` helpers in `packages/agents` are private, and
the `canonical*Json` helpers of `packages/execution-plane` serialize only their
own types); unit E adds one with the RFC's test vectors.

**Errors.** Each error body is `{ "error": "<code>" }` and nothing else: no
message, URL, stack or provider text. The cause is logged on the server. An
error on either road fails the whole request; the route never returns one
report alone or a shorter list.

- `401 Unauthorized` — no session, or a `cit_` bearer.
- `400 invalid_request` — a missing, empty or repeated parameter, any other
  parameter, a `threadId` or `runId` longer than 200 characters or with a
  character outside printable ASCII (0x21-0x7E), or a `surface` that is not in
  `RUN_WINDOW_SURFACES`. These checks read no store, so they say nothing about
  whether a run exists.
- `403 Forbidden` — `authorizeThreadForTurn` refuses the thread (the status and
  error that the chat route returns for it).
- `404 not_found` — `requireRunWindowAccess(runId, "read")` refuses: a run that
  does not exist, a run the caller may not read and a caller with no bound turn
  actor give the same answer, so the route is not an oracle for run ids.
- `503 actor_unavailable` — `requireActorContext()` or
  `resolveUserContextForUserId` fails for a valid session (for example the
  grants and teams cannot be read).
- `503 provider_unavailable` — no provider adapter resolves, or
  `BoundDefaultProviderUnavailableError`.
- `503 skills_not_registered` — see "Read only".
- `503 skills_not_synced` — the skill delivery throws its skill-not-synced
  error (`packages/llm/src/errors.ts`: a catalog skill has no synced
  provider copy).
- `503 skill_delivery_refused` — the skill delivery throws its skill-cap error
  (same file), or the delivery produced no vehicle (the case where the turn
  refuses).
- `503 tools_unavailable` — the self-MCP reference cannot be assembled (no
  public MCP URL is configured).
- `503 catalog_unavailable` — the self-MCP catalog state cannot be read.
- `503 external_tools_unavailable` — `resolveChatExternalMcpTools` throws.
- `503 tool_unserializable` — see "Canonical JSON".
- `503 assembly_failed` — any other failure of the assembly.

**Item 7.** The conformance test sends one request and asserts that
`composer.manifestHash` equals `window.manifestHash` (and that the `tools`
lists are equal). The two reports use the inputs of the real roads, so a
difference between the roads, such as the window's missing `sessionId`, shows
as a difference here and fails the test.

**It draws nothing.** The route has no screen, no component and no drawn
element; no design spec covers it. The DOM never reads it; tests read it. It is
not part of the stream wire, and it does not change
`ASSISTANT_STREAM_CONTRACT_VERSION` (§8).

## 6. Conformance

`conformance.ts` + `conformance-fixtures.ts` give S6 (#1222) its static
foundation now, before the live producer (#1037 P2) exists:

- `isAgUiEvent()` — per-type structural validation of one wire event.
- `analyzeEventLog()` — turn-shape diagnostics over a whole log (validity,
  opens-with-`RUN_STARTED`, closes-on-terminal, completeness). A streaming
  prefix reports valid-but-incomplete — the "resumed/partial stream" case.
- `CONFORMANCE_CORPUS` — a typed seed corpus, one log per renderable class and
  edge case (full turn with a renderable view, HITL interrupt/resume, run error,
  streaming partial, unknown/unregistered view). Because each corpus is a typed
  `readonly AgUiEvent[]`, a breaking change to any event shape fails the
  typecheck here.

**Static-fixture conformance can begin against this contract today.** Live
producer-conformance (a real assistant emitting these events end-to-end) is
gated on #1037 P2 and is added to the corpus as live-run captures when it lands.

## 7. Migration — what the surfaces retire (S2/S5)

This contract is additive and is the single source of truth. The surfaces adopt
it and delete their forks in later stages:

- **S2 (#1218)** migrates `/chat` onto this wire and deletes the bespoke
  `chat-stream-events` vocabulary.
- **S5 (#1221)** rewrites the WordPress/Drupal shells to embed the Cinatra-served
  view and deletes the relay route, the frozen `text`/`changes`/`error`/`done`
  frames, and the `/capabilities` v1/v2 negotiation.

Until then, the retired surfaces keep working; nothing in this stage changes
their runtime behavior.

## 8. Versioning policy

`ASSISTANT_STREAM_CONTRACT_VERSION` is semver. A backward-compatible addition (a
new optional event field, a new renderable `viewType`) is a **minor** bump and
does not require a handshake change — clients ignore unknown fields and fall back
on unknown views. A breaking change to an existing event's required shape is a
**major** bump and MUST be added to `supportedContracts` alongside the prior
version for a negotiated transition. Adding a renderable view is **never** a
contract fork — it is a registry augmentation (§5.1).
