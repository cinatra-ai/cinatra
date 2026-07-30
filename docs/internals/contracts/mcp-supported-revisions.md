# Supported MCP protocol revisions

Which MCP specification revisions cinatra accepts inbound on `/api/mcp`, which it
offers outbound per client surface, and what it does when it meets a peer on an
older revision — in both directions.

## How to read this document

Every statement below is tagged **CURRENT** or **TARGET**.

- **CURRENT** describes what the code on `main` actually does. Each claim names
  the file (and, for SDK behaviour, the bundled function) it was read from. The
  outbound section was verified against `origin/main` @ `a57a6c4` on 2026-07-29;
  the inbound section was rewritten by the cinatra#2218 **L1** server cutover
  (base `03fe07a`) and names the code that implements it.
- **TARGET** describes the policy cinatra#2218 adopts. **It is not implemented.**

This distinction is the point of the document. **A policy document does not make
an implementation conformant.** A TARGET paragraph is a commitment, not a
description; nothing in this file may be cited as evidence that a surface behaves
a particular way. Only a CURRENT paragraph — and the code it names — is such
evidence. When #2218 lands a surface, its TARGET paragraph is rewritten as
CURRENT with the implementing code named, in the same PR that changes the code.

## The revision vocabulary (upstream SDK behaviour)

This section describes the **upstream `@modelcontextprotocol/*` 2.0 packages**,
not cinatra. It is neither CURRENT nor TARGET for us — it is the vocabulary the
rest of the document is written in. cinatra's own posture starts at
[Inbound](#inbound--apimcp).

Revision identifiers are ISO dates, so lexicographic ordering is chronological.
The SDK splits them into two **eras**, and the boundary is load-bearing:

| Era | Revisions | Negotiated by |
| --- | --- | --- |
| Legacy (2025-era) | `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07` | the `initialize` / `initialized` exchange |
| Modern (2026-era) | `2026-07-28` | the `server/discover` RPC, behind a per-request `_meta` envelope claim |

Two consequences that are easy to get wrong:

- **`2026-07-28` cannot be reached through `initialize`.** The upstream SDK keeps
  the two supported-version lists physically separate so that "adding a revision
  here can never leak a modern version string into a 2025-era handshake"
  (`protocolEras.ts`). `initialize` can only ever settle on a legacy revision.
- **An `MCP-Protocol-Version: 2026-07-28` header is not, by itself, the
  negotiation.** A modern request must also carry the `_meta` envelope. A header
  naming a modern revision without the envelope is answered `-32602`; a
  header/body mismatch is answered `-32020`.

## Inbound — `/api/mcp`

### CURRENT

**Inbound posture: row A.** The recorded product ruling on cinatra#2218
(2026-07-29) selected `legacy: 'stateless'` — the accepted inbound set is
`2026-07-28` **plus** all five previously-accepted revisions. Landed by
cinatra#2218 L1.

The endpoint runs the **published** `@modelcontextprotocol/server` **`2.0.0`**
(exact pin in `packages/mcp-server/package.json`; the vendored
`2.0.0-alpha.0` tree at `packages/mcp-server/vendor/` is **retired and deleted**,
together with the never-imported `-node` / `-express` shims). `2.0.0` exact-pins
`@modelcontextprotocol/core@2.0.0` as a required transitive dependency.

**Accepted set (CURRENT):**

```
2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07
```

Six revisions. The five legacy entries are still the SDK default
(`SUPPORTED_PROTOCOL_VERSIONS`, alongside `LATEST_PROTOCOL_VERSION = "2025-11-25"`
and `DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-03-26"`); no cinatra source file
passes `supportedProtocolVersions`. `2026-07-28` is the SDK's single modern
revision (`SUPPORTED_MODERN_PROTOCOL_VERSIONS`).

**How the two eras are served (CURRENT).** `packages/mcp-server/src/inbound-era.ts`
owns the split; `packages/mcp-server/src/index.tsx` (`transportHandler`) calls it.
Both legs are built from the **same** per-request runtime server
(`createMcpRuntimeServer`), so the eras can never advertise a different tool
surface.

| Leg | Built by | Serves |
| --- | --- | --- |
| Legacy (2025-era) | `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })` — `serveLegacyEra()` | the five legacy revisions, per-request stateless, `application/json` framing. `GET` / `DELETE` (2025 session operations) answered `405` / `Method not allowed.` |
| Modern (2026-era) | `createModernEraHandler()` → `createMcpHandler(factory, { legacy: 'reject' })` | `2026-07-28` via `server/discover` behind the `_meta` envelope, plus every modern-path ladder rejection |

Routing is `resolveInboundEra()`, which calls the SDK's **own** exported
`isLegacyRequest(request, parsedBody)` predicate — the same classification step
`createMcpHandler` runs internally — so the split never *decides* an era
differently from the SDK. The `legacy: 'reject'` arm is never reached under row
A: legacy-classified requests are handed to the legacy leg before the handler
sees them.

There is a third outcome, and it is deliberate: when the classifier itself
rejects (it does so only when the request body cannot be read at all)
`resolveInboundEra` returns `"unclassifiable"` and the endpoint answers HTTP
**400** / **`-32700`** `Parse error: the request body could not be read for
protocol-era classification.` It does **not** fall back to either era —
downgrading a classification failure to the legacy leg would let an I/O error
silently decide a protocol downgrade.

**Why row A is not wired as the literal `legacy: 'stateless'` option.** The SDK's
built-in stateless fallback (`createLegacyStatelessFallback` in
`@modelcontextprotocol/server@2.0.0`) constructs its legacy transport with **only**
`sessionIdGenerator: undefined` — **without** `enableJsonResponse` — so every
2025-era response would come back as `text/event-stream` instead of
`application/json`, and the option exposes no way to re-enable JSON framing on
that leg (`responseMode` governs the MODERN leg only). That would change the wire
format for every existing caller, including the in-repo Anthropic
function-tools probe at `src/app/configuration/mcp/llm-access/test/route.ts`,
which POSTs `tools/list` and calls `.json()` on the result. The **accepted set**
is row A's exactly; the **framing** existing callers see is unchanged. This is the
user-land `isLegacyRequest()` composition upstream documents, and which the
`legacy` option's own docs name as the way to keep an existing legacy wiring
serving 2025 traffic beside a strict modern endpoint.

**Where negotiation is enforced (CURRENT).** Three places — cinatra adds no
revision check of its own beyond the era split:

1. **Era classification** — `isLegacyRequest` / `classifyInboundRequest`. A
   request carrying a well-formed `_meta` envelope claim naming a modern
   revision is modern; everything else (claim-less POSTs including `initialize`,
   body-less `GET`/`DELETE`, all-legacy batches, posted responses, non-JSON
   bodies) is legacy. Three classes are **modern despite carrying no valid
   envelope**, because the modern path owns their answer: an envelope-less modern
   `MCP-Protocol-Version` header, a header/body revision mismatch, and a
   **claim-less modern-header NOTIFICATION** — the last is accepted with `202`
   and dropped, and requires neither `_meta` nor `Mcp-Method`.
2. **Legacy header validation** — `WebStandardStreamableHTTPServerTransport.validateProtocolVersion(req)`.
   An `MCP-Protocol-Version` header naming a revision outside the five is
   rejected HTTP **400** / **`-32000`**, message
   `Bad Request: Unsupported protocol version: <v> (supported versions: <list>)`.
   An **absent** header is accepted (falls back to
   `DEFAULT_NEGOTIATED_PROTOCOL_VERSION`, `2025-03-26`).
3. **Legacy handshake negotiation** — the `initialize` handler echoes the
   requested `params.protocolVersion` when it is in the set, otherwise answers
   the **head of the list** (`2025-11-25`). An unknown or future revision is
   **not** an error here — it is silently down-negotiated.

**Modern-path rejections (CURRENT), all HTTP 400.** Measured against
`server@2.0.0`; covered by
`packages/mcp-server/src/__tests__/supported-revisions-inbound.test.ts`:

| Condition | Answer |
| --- | --- |
| `MCP-Protocol-Version: 2026-07-28` with **no** `_meta` envelope | `-32602`, naming the missing envelope key(s) |
| Envelope present but incomplete (`_meta` must carry BOTH `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities`) | `-32602` |
| Envelope revision ≠ `MCP-Protocol-Version` header | `-32020` |
| Missing `Mcp-Method` header on a modern **request** (notifications are exempt) | `-32020` |
| Missing / mismatched / bad-Base64 `Mcp-Name` on `tools/call`, `prompts/get`, `resources/read` — and only when the body supplies the mirrored `params.name` / `params.uri`; no other method requires it | `-32020` |
| Envelope claims a modern revision the endpoint does not serve | unsupported-protocol-version error |

Two adjacent CURRENT behaviours that interact with the above:

- **Accept-header normalization** (`normaliseAcceptHeader` in
  `packages/mcp-server/src/inbound-era.ts`): when a client sends
  `Accept: application/json` without `text/event-stream`, cinatra rebuilds the
  request with `text/event-stream` appended. This **does** change the outcome on
  the legacy leg — without it the request is answered `406`
  (`Not Acceptable: Client must accept both application/json and text/event-stream`)
  — but it does not change the response format: the legacy leg runs with
  `enableJsonResponse`, so SSE is never used there either way. It exists because
  some hosted relays send only `application/json`.
- **CORS** (`MCP_CORS_ALLOW_HEADERS` in `packages/mcp-server/src/inbound-era.ts`):
  `Access-Control-Allow-Headers: Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name`
  and `Access-Control-Expose-Headers: WWW-Authenticate, MCP-Protocol-Version`.
  `Mcp-Method` / `Mcp-Name` are **required request headers of the revision**, not
  optional gateway-routing extras: `Mcp-Method` on every modern REQUEST, and
  `Mcp-Name` on the three name-bearing methods above. A modern request missing a
  required one is answered `-32020`, so their admission had to land in the SAME
  change as the revision, or `2026-07-28` would be unusable from any
  browser-origin client.

  Three consequences of that, decided on cinatra#2221 and recorded here. The two
  header SETS below, and the OPTIONS seam that emits them, are pinned by
  `src/lib/__tests__/mcp-cors-admission-contract.test.ts`; the routing position
  and the security boundary are recorded, not machine-enforced.

  1. **The expose list deliberately does not carry them.**
     `Access-Control-Expose-Headers` governs which RESPONSE headers a browser
     may read; `Mcp-Method` / `Mcp-Name` are request headers, and no audited path
     — the SDK's or cinatra's — writes either onto a response. Admitting inbound
     and exposing outbound are different questions with different answers. (The
     existing `MCP-Protocol-Version` expose entry predates this and is not
     re-litigated here.)
  2. **Cinatra adopts no header-based ROUTING.** The headers exist so an
     intermediary can dispatch without parsing the JSON body. No audited
     cinatra-managed ingress makes any routing, throttling or caching decision on
     an MCP header, so there is nothing to consume them; they travel for the
     SDK's own header/body cross-check and for whatever a CALLER chooses to put
     in front of us. Adding a header-keyed rule with no consumer would be
     adoption for its own sake.
  3. **A mirrored header is a client-supplied claim, not authenticated truth.**
     The revision expressly contemplates intermediaries routing or rate-limiting
     on these headers, but only because the destination re-validates the
     header/body cross-check. Any intermediary may therefore dispatch on them; none
     may widen access on them, and every routed destination must still enforce the
     cross-check.

  **Trigger that reopens the browser-client CORS design:** if a tool declares
  `x-mcp-header` on an input property, then whenever that argument is present and
  non-null the matching `Mcp-Param-{Name}` header must accompany the call and is
  cross-checked at tool resolution (`-32020` on disagreement). Such a header has
  to be admitted **by concrete name** — CORS has no `Mcp-Param-*` prefix
  wildcard — so the allow list stops being a fixed list. Upstream's own TypeScript
  client currently declines to mirror these headers in a browser for CORS reasons,
  which makes this a browser-compatibility design question and not a one-line
  allow-list edit. No tracked tool declares `x-mcp-header` today, but tool input
  schemas can arrive from extensions at runtime, so this is a live trigger rather
  than a closed question.

### TARGET

None outstanding for the inbound surface. Row A is implemented; a later
deliberate legacy-era deprecation (row B) remains open as its own owner-gated
decision with its own release communication.

### Behaviour on an older-revision inbound peer

**CURRENT.** Accept, and down-negotiate silently — row A.

- A client that requests any of the five legacy revisions in `initialize` gets
  that exact revision echoed back and is served, through the 2025-era codec.
- A client that requests a revision **outside** the set in `initialize` is **not
  rejected** — it is answered `2025-11-25` and served. Whether it can actually
  speak `2025-11-25` is not checked.
- A client that sends an unaccepted revision in the `MCP-Protocol-Version`
  **header** on a subsequent request **is** rejected, 400 / `-32000`.
- `GET` / `DELETE` are answered `405`.

The asymmetry between the middle two is SDK behaviour, not a cinatra policy: the
handshake is lenient, the header is strict. The preservation is deliberate and
both paths are tested.

**TARGET.** None. Row B — dropping the legacy era so the accepted set is
`2026-07-28` only, with legacy-classified notifications answered `202` and
dropped — stays available as a one-line flip of `MCP_INBOUND_LEGACY_POSTURE`
in `packages/mcp-server/src/inbound-era.ts`, and is covered by a test so the
posture is provably a decision rather than a default. It requires release
communication before it ships and is not scheduled.

No third option is in scope: 2.0.0 exposes no handler-valued `legacy` option, and
the user-land `isLegacyRequest()` split reproduces row A's accepted set (which is
exactly what the implementation above does).

## Outbound — per client surface

### CURRENT

`@modelcontextprotocol/sdk` is declared `^1.29.0` in the root `package.json` and
the lockfile resolves **`1.29.0`**, whose `LATEST_PROTOCOL_VERSION` is
`2025-11-25` and whose `SUPPORTED_PROTOCOL_VERSIONS` is the same five-revision
list the inbound legacy leg accepts. **Unchanged by cinatra#2218 L1** — that lane
is the server surface only; the client migration to
`@modelcontextprotocol/client@2.0.0` is its own lane.

| Surface | Client | Offers on `initialize` | Accepts from server |
| --- | --- | --- | --- |
| `src/lib/connector-instance-mcp-transport.ts` | SDK `Client` + `StreamableHTTPClientTransport` | `2025-11-25` | the five legacy revisions |
| `http-client.ts` in `packages/marketplace-mcp-client` | SDK `Client` + `StreamableHTTPClientTransport` | `2025-11-25` | the five legacy revisions |
| `packages/objects/src/graphiti-client.ts` | SDK `Client` + `StreamableHTTPClientTransport` | `2025-11-25` | the five legacy revisions |
| `packages/agents/src/external-mcp-caller.ts` | hand-rolled JSON-RPC over `fetch` | **nothing — no `initialize` at all** | n/a (no negotiation) |

`external-mcp-caller.ts` is the outlier and the one to watch. It POSTs
`tools/list` and `tools/call` directly with `Content-Type: application/json` and
`Accept: application/json`, performs no handshake, and sends **no**
`MCP-Protocol-Version` header. It declares no revision, so it is a claim-less
POST: against a `2026-07-28` endpoint it classifies as **legacy** traffic and is
served only if that endpoint runs `legacy: 'stateless'`. Against a modern-only
peer it fails.

Not MCP protocol surfaces, listed so they are not mistaken for gaps:
`src/lib/wordpress-mcp-connection.ts` and `src/lib/drupal-mcp-connection.ts`
issue `HEAD` reachability probes only and carry no MCP traffic; the raw `fetch`
calls in that same `http-client.ts` are REST catalog `GET`s, distinct from the
`Client` on the same file's MCP path.

**Known divergence — documentation, not wire.**
`src/lib/connector-instance-mcp-transport.ts` exports
`MCP_PROTOCOL_VERSION = "2025-06-18"` and its module header documents the
handshake at that revision. **That constant is never passed to the SDK `Client`**
— it has exactly one other occurrence in the tree, a locally re-declared copy in
a test. The real handshake offers the installed SDK's
`LATEST_PROTOCOL_VERSION`, i.e. `2025-11-25`. The constant and the comment are
stale; the wire is not. Anyone reasoning about the outbound revision must read
the SDK version, not that constant.

### TARGET

The outbound path moves to `@modelcontextprotocol/client@2.0.0`. This is a
**package migration, not a version bump** — `@modelcontextprotocol/sdk@1.30.0`
contains zero occurrences of `2026-07-28`, so the v1 line is not a route to this
revision.

`client@2.0.0` negotiates through a `versionNegotiation` option. **It is an
options object, and its default mode is `'legacy'`** — the client resolves
`options?.mode ?? 'legacy'`, so a bare string (`versionNegotiation: 'auto'`)
leaves `mode` undefined and silently selects the legacy path. Measured against
`client@2.0.0` + `server@2.0.0`: written as the bare string, `connect()`
negotiated `2025-11-25` with **no `server/discover` request on the wire at all**;
written as `{ mode: 'auto' }` it negotiated `2026-07-28` in two requests. Migrating
the package is therefore **not** sufficient to reach the revision — the mode must
be passed explicitly.

- **`{ mode: 'auto' }`** — probe `server/discover` for a modern revision; on no
  modern overlap, fall back to the legacy `initialize` handshake. Legacy fallback
  is available unless `supportedProtocolVersions` is set to a modern-only list.
- **`{ mode: 'legacy' }`, or the option omitted entirely (the default)** — skip
  the probe, `initialize` directly.
- **`{ mode: { pin: '<modern revision>' } }`** — pin a modern revision; pinning a
  legacy revision is a `TypeError`.

**TARGET outbound policy: `versionNegotiation: { mode: 'auto' }` on every surface
whose peer may plausibly speak `2026-07-28`, no pins, no modern-only surface.**
cinatra calls third-party MCP servers it does not control, so preferring
`2026-07-28` while retaining the legacy fallback is the only posture that does not
break existing connector instances.

`'auto'` is not free against a peer that cannot answer the probe. Measured on one
connect-per-call cycle against a 2025-era-only peer: `{ mode: 'auto' }` costs
**five** HTTP requests (`server/discover` rejected, then `initialize`,
`notifications/initialized`, the `GET` stream open, `tools/call`) where today's
client costs **four**. On a surface whose peer is *known* 2025-era — and whose
transport reconnects per call — an explicit `{ mode: 'legacy' }` is the correct
setting until that peer's posture changes, not a regression from this policy.

Per surface:

| Surface | TARGET client | TARGET negotiation | TARGET accepted from server |
| --- | --- | --- | --- |
| `src/lib/connector-instance-mcp-transport.ts` | `@modelcontextprotocol/client@2.0.0` | `{ mode: 'auto' }` — or explicit `{ mode: 'legacy' }` while the peer is the sessionful 2025-era gateway | `2026-07-28` preferred; the five legacy revisions via fallback |
| `http-client.ts` in `packages/marketplace-mcp-client` | `@modelcontextprotocol/client@2.0.0` | `{ mode: 'auto' }` | `2026-07-28` preferred; the five legacy revisions via fallback |
| `packages/objects/src/graphiti-client.ts` | `@modelcontextprotocol/client@2.0.0` | `{ mode: 'auto' }` — the era choice tracks the pinned peer image | `2026-07-28` preferred; the five legacy revisions via fallback |
| `packages/agents/src/external-mcp-caller.ts` | `@modelcontextprotocol/client@2.0.0` — **migrate off hand-rolled `fetch`** | `{ mode: 'auto' }` | `2026-07-28` preferred; the five legacy revisions via fallback |

Whichever mode a surface lands on, the migration must **prove** it: an assertion
that `server/discover` was (or was not) issued and that the expected revision was
negotiated. A package version is not evidence of a negotiation — the bare-string
trap above produces a fully working client on the wrong era.

The last row is a decision, not a deferral. `external-mcp-caller.ts` negotiates
nothing today, which means it fails silently against a modern-only peer and can
never reach `2026-07-28`; leaving it hand-rolled would make it the single surface
whose revision posture is unstatable. It moves onto the SDK client so that all
four outbound surfaces have one negotiation model. Also TARGET, in the same
change: the stale `MCP_PROTOCOL_VERSION = "2025-06-18"` constant and its module
comment are deleted rather than updated — the SDK owns the offered revision, so no
cinatra constant should appear to.

### Behaviour on an older-revision outbound peer

**CURRENT.** Interoperate. The SDK `Client` offers `2025-11-25`; a server that
answers with any of the five accepted revisions is accepted and used, including
`2025-06-18`. A server answering a revision outside that set fails the handshake.

`external-mcp-caller.ts` performs no negotiation, so it does not *observe* the
peer's revision — but the peer's revision posture still decides the outcome. Its
headerless, claim-less POST succeeds only against peers that answer a **bare
`tools/list`** with no prior handshake. That is narrower than "2025-era": a
2025-era server is free to require the `initialize` exchange and a protocol
session, and some do — the module header of
`src/lib/connector-instance-mcp-transport.ts` records exactly that case, where a
bare `tools/list` returns HTTP 400 `-32600 "Missing Mcp-Session-Id header"`. It
also **fails against a modern-only peer**, with no negotiation error to explain
why. So "negotiates nothing" is not "unaffected" — it means the surface has no
revision posture to state and no diagnostic when a peer's posture excludes it.

**TARGET.** Unchanged in outcome for the three SDK-client surfaces, by design:
under `versionNegotiation: { mode: 'auto' }` an older-revision server is detected
by the absent or non-overlapping `server/discover` probe and served through the
legacy `initialize` path, so the five legacy revisions stay reachable outbound.
**cinatra does not drop support for calling 2025-era MCP servers.** Any future
change to that is a separate decision with its own release communication.

For `external-mcp-caller.ts` the TARGET is a strict improvement rather than parity:
after the migration an older-revision peer is reached through the same legacy
fallback as the other three, and a modern-only peer becomes reachable instead of
silently failing.

### What outbound clients do with the `DiscoverResult` (cinatra#2222)

**CURRENT and TARGET, both: `server/discover` is a version probe only.** No
outbound surface caches a `DiscoverResult`, holds a prior across connections, or
reads the capabilities/instructions it carries. `client@2.0.0` can adopt a
validated prior discovery with zero extra round trips
(`connect(transport, { prior: { kind: 'modern', discover } })`); cinatra does not
use it. Three separable decisions, recorded separately because they have
different costs:

| Decision | Posture |
| --- | --- |
| **Prior reuse** (transport optimization) | **No.** Measured saving is one HTTP request per connect-per-call cycle (2 → 1 against a modern peer). `server/discover` is a *cacheable result* on `2026-07-28` — it carries a server-authored `ttlMs` / `cacheScope` — and a default-configured `server@2.0.0` answers `ttlMs: 0` / `cacheScope: 'private'`, i.e. SHOULD be treated as immediately stale. cinatra will not routinely reuse a modern prior past its advertised freshness horizon, so `ttlMs: 0` disables routine reuse. `validatePrior()` schema-checks only — no TTL, no expiry, no identity binding — so freshness would be entirely ours to get right. |
| **Capability consumption** (dispatch) | **No.** The advertised set is a server self-report and does not prove a given tool exists (`tools/list` does). Under the SDK default (`enforceStrictCapabilities: false`) nothing reads it; under strict enforcement a stale set blocks a supported call with zero requests on the wire. |
| **Instruction consumption** (model-facing) | **No, and it is not a discovery question.** The legacy `initialize` result already carries `instructions` and the installed v1 client already exposes it; all four surfaces discard it. Putting peer-authored text into model context is a prompt-injection decision on its own merits, identical on both eras. |

**Standing invariant, whatever the outcome above.** Server-advertised capabilities
may suppress or route *dispatch*; the server remains the authorization and
enforcement point. Nothing derived from a peer's self-report may widen, narrow or
substitute for an authorization decision on our side.

**Why a cache is not merely "unbanked value".** Measured: a cached *modern* prior
against a peer that has since gone 2025-era-only fails the call outright —
`connect({ prior })` never re-probes and has no fallback, where `{ mode: 'auto' }`
with no prior detects the peer and succeeds. A cache converts a recoverable
negotiation into an outage.

**Reopen trigger.** Conditions 1 and 2 are prerequisites for evaluating at all;
condition 3 decides whether it is worth implementing:

1. A surface has actually migrated to `@modelcontextprotocol/client@2.0.0` with
   `{ mode: 'auto' }` (nothing here is expressible on the v1 client); **and**
2. a real peer on that surface answers `server/discover` with a **positive
   `ttlMs`**; **and**
3. the probe is a measured, material share of that surface's per-call cost —
   recorded at migration time as negotiated era, discovery latency, total
   connect-plus-call latency, `ttlMs` and `cacheScope`, and crossing a threshold
   declared before the measurement rather than after.

Any cache built after that trigger is keyed by canonical endpoint **and**
authorization/tenant context **and** client negotiation configuration, stores the
receipt time (a `DiscoverResult` alone cannot express its own expiry), carries a
local maximum TTL, invalidates and re-probes only on an unambiguous *pre-dispatch*
protocol/version rejection — never by retrying an arbitrary failed `tools/call`,
whose execution may be non-idempotent — and single-flights refresh so expiry does
not stampede.

## Asymmetry, stated deliberately

The inbound and outbound accepted sets are **not required to match**, and after
#2218 they may well differ: outbound keeps the legacy fallback because we do not
control the servers we call, while the inbound set is a product decision about who
may call us. Neither set may be inferred from the other, and neither may be
inferred from the installed package version alone.

## What this document does not settle

- ~~**The inbound accepted set / `legacy` posture.**~~ **Settled: row A**
  (recorded ruling, 2026-07-29) and implemented by cinatra#2218 L1. Row B
  remains a separate, owner-gated future decision.
- ~~**`Mcp-Method` / `Mcp-Name` CORS admission.**~~ **Settled: admitted.** This
  was filed as "follows header-routing adoption, which is a separate,
  non-automatic decision" — that framing was WRONG. The two headers are
  REQUIRED request headers of `2026-07-28` (a modern request missing either is
  answered `-32020` by `validateStandardRequestHeaders`), so adopting the
  revision forces their admission; there is no separate adoption decision.
- ~~**Whether outbound clients consume the `server/discover` payload as a
  capability / instructions source.**~~ **Settled: no** (cinatra#2222) — probe
  only, no prior held across connections, with the reopen trigger recorded
  above.
- ~~**Header-based routing on `Mcp-Method` / `Mcp-Name`, and the expose list.**~~
  **Settled on cinatra#2221: no routing adopted, expose list unchanged** — see
  the CORS bullet above for the reasoning, the security boundary, and the
  `x-mcp-header` / `Mcp-Param-{Name}` trigger that would reopen the
  browser-client CORS design.
- **Anything about conformance.** The presence of a TARGET paragraph is not
  evidence that any surface implements it.
