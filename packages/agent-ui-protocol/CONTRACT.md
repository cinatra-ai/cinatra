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
