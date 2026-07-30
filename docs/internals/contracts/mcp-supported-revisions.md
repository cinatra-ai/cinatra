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

`client@2.0.0` negotiates through a `versionNegotiation` option:

- **`'auto'` (default)** — probe `server/discover` for a modern revision; on no
  modern overlap, fall back to the legacy `initialize` handshake. Legacy fallback
  is available unless `supportedProtocolVersions` is set to a modern-only list.
- **`'legacy'`** — skip the probe, `initialize` directly.
- **`{ pin: '<modern revision>' }`** — pin a modern revision; pinning a legacy
  revision is a `TypeError`.

**TARGET outbound policy: `versionNegotiation: 'auto'` on every surface, no pins,
no modern-only surface.** cinatra calls third-party MCP servers it does not
control, so preferring `2026-07-28` while retaining the legacy fallback is the
only posture that does not break existing connector instances.

Per surface:

| Surface | TARGET client | TARGET negotiation | TARGET accepted from server |
| --- | --- | --- | --- |
| `src/lib/connector-instance-mcp-transport.ts` | `@modelcontextprotocol/client@2.0.0` | `'auto'` | `2026-07-28` preferred; the five legacy revisions via fallback |
| `http-client.ts` in `packages/marketplace-mcp-client` | `@modelcontextprotocol/client@2.0.0` | `'auto'` | `2026-07-28` preferred; the five legacy revisions via fallback |
| `packages/objects/src/graphiti-client.ts` | `@modelcontextprotocol/client@2.0.0` | `'auto'` | `2026-07-28` preferred; the five legacy revisions via fallback |
| `packages/agents/src/external-mcp-caller.ts` | `@modelcontextprotocol/client@2.0.0` — **migrate off hand-rolled `fetch`** | `'auto'` | `2026-07-28` preferred; the five legacy revisions via fallback |

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
under `versionNegotiation: 'auto'` an older-revision server is detected by the
absent or non-overlapping `server/discover` probe and served through the legacy
`initialize` path, so the five legacy revisions stay reachable outbound.
**cinatra does not drop support for calling 2025-era MCP servers.** Any future
change to that is a separate decision with its own release communication.

For `external-mcp-caller.ts` the TARGET is a strict improvement rather than parity:
after the migration an older-revision peer is reached through the same legacy
fallback as the other three, and a modern-only peer becomes reachable instead of
silently failing.

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
- **Anything about conformance.** The presence of a TARGET paragraph is not
  evidence that any surface implements it.
