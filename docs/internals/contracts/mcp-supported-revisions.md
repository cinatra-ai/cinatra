# Supported MCP protocol revisions

Which MCP specification revisions cinatra accepts inbound on `/api/mcp`, which it
offers outbound per client surface, and what it does when it meets a peer on an
older revision — in both directions.

## How to read this document

Every statement below is tagged **CURRENT** or **TARGET**.

- **CURRENT** describes what the code on `main` actually does. Each claim names
  the file (and, for vendored SDK behaviour, the bundled function) it was read
  from. Verified against `origin/main` @ `a57a6c4` on 2026-07-29.
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

The endpoint is served by the **vendored** `@modelcontextprotocol/server`
`2.0.0-alpha.0` at `packages/mcp-server/vendor/modelcontextprotocol-server`
(a `file:` dependency of `packages/mcp-server/package.json`), mounted through
`WebStandardStreamableHTTPServerTransport` constructed in
`packages/mcp-server/src/index.tsx` with `sessionIdGenerator: undefined` and
`enableJsonResponse: true` — stateless, one server instance per request, SSE never
used.

**Accepted set (CURRENT):**

```
2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07
```

Five revisions. `2026-07-28` is **not** accepted and **not** served — the string
does not occur anywhere in the vendored tree.

This set is the SDK default, not a cinatra choice. No cinatra source file passes
`supportedProtocolVersions`, and the inbound path contains no MCP revision string
of its own. The list is `SUPPORTED_PROTOCOL_VERSIONS` in the vendored bundle,
alongside `LATEST_PROTOCOL_VERSION = "2025-11-25"` and
`DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-03-26"`.

Across all of `src/` and `packages/` (excluding `vendor/`) there is exactly **one**
MCP revision string in cinatra source: the unused `MCP_PROTOCOL_VERSION` constant
on the outbound side, recorded under "Known divergence — documentation, not wire"
below. It has no effect on the inbound set.

**Where negotiation is enforced (CURRENT).** Two places, both inside the vendored
SDK — cinatra adds no revision check of its own:

1. **Header validation** — `WebStandardStreamableHTTPServerTransport.validateProtocolVersion(req)`.
   An `MCP-Protocol-Version` request header naming a revision outside the accepted
   set is rejected with HTTP **400** and JSON-RPC error **`-32000`**, message
   `Bad Request: Unsupported protocol version: <v> (supported versions: <list>)`.
   The header being **absent is accepted** — the request falls back to the version
   negotiated at initialization, or to `DEFAULT_NEGOTIATED_PROTOCOL_VERSION`
   (`2025-03-26`) when there is none.
2. **Handshake negotiation** — the `initialize` handler. The requested
   `params.protocolVersion` is **echoed back if it is in the accepted set**;
   otherwise the server answers with the **head of the list** (`2025-11-25`).
   An unknown or future revision is therefore **not an error** here — it is
   silently down-negotiated.

Two adjacent CURRENT behaviours that interact with the above:

- **Accept-header normalization** (`packages/mcp-server/src/index.tsx`): when a
  client sends `Accept: application/json` without `text/event-stream`, cinatra
  rebuilds the request with `text/event-stream` appended so the SDK's validator
  admits it. This **does** change the outcome — without it the request is rejected
  — but it does not change the response format: stateless + `enableJsonResponse`
  means SSE is never actually used either way. It exists because some hosted
  relays send only `application/json`.
- **CORS** (`packages/mcp-server/src/index.tsx`):
  `Access-Control-Allow-Headers: Authorization, Content-Type, MCP-Protocol-Version`
  and `Access-Control-Expose-Headers: WWW-Authenticate, MCP-Protocol-Version`.
  The `2026-07-28` routing headers `Mcp-Method` and `Mcp-Name` are **not** in
  either list.

### TARGET

`/api/mcp` serves `2026-07-28`, negotiated via `server/discover` behind the
`_meta` envelope, on `@modelcontextprotocol/server@2.0.0`.

The 2.0.0 entry point `createMcpHandler(factory, options)` decides the inbound
accepted set through one option, `legacy: 'stateless' | 'reject'`:

| `legacy` | Accepted inbound set | 2025-era traffic |
| --- | --- | --- |
| `'stateless'` (default, and when omitted) | `2026-07-28` **plus** all five legacy revisions | served per-request through the stateless idiom; `GET` and `DELETE` (2025 session operations) answered `405` |
| `'reject'` | `2026-07-28` only | **not served at all** — legacy-classified requests get the unsupported-protocol-version error; legacy-classified notifications get `202` and are dropped |

There is **no handler-valued `legacy` option** in 2.0.0. To keep a separate
existing legacy wiring alive beside a strict modern endpoint, the supported
pattern is to route in user land on the exported `isLegacyRequest(request)`
predicate in front of a `legacy: 'reject'` handler.

**The inbound accepted set is an OPEN DECISION and is deliberately not settled in
this document.** It is a product/release-communication decision about who may call
us, not an engineering detail, so it is owner-gated under #2218 rather than chosen
by whoever writes this file. This is the one axis on which the document is a stub,
and it is a stub on purpose.

What makes it a ruling rather than a default: choosing `'reject'` drops **five**
currently-accepted revisions, including the `2025-11-25` that `/api/mcp`
negotiates today. It is not a floor-raise from `2025-06-18` to `2025-11-25` — it
is removal of the entire legacy era. Choosing `'stateless'` keeps all five and
adds `2026-07-28`.

Both branches are fully specified below, so the only thing the ruling supplies is
which one applies. Recording the outcome here is a **prerequisite** for L1 wiring
the 2.0.0 handler; until then this document states no inbound TARGET floor and no
`legacy` value.

Also TARGET, independent of that decision: `Mcp-Method` and `Mcp-Name` are added
to the CORS allow/expose lists if and when header-based routing is adopted
(tracked separately — adoption is not automatic just because the headers exist).

### Behaviour on an older-revision inbound peer

**CURRENT.** Accept, and down-negotiate silently.

- A client that requests any of the five accepted revisions in `initialize` gets
  that exact revision echoed back and is served.
- A client that requests a revision **outside** the set in `initialize` is **not
  rejected** — it is answered `2025-11-25` and served. Whether it can actually
  speak `2025-11-25` is not checked.
- A client that sends an unaccepted revision in the `MCP-Protocol-Version`
  **header** on a subsequent request **is** rejected, 400 / `-32000`.

The asymmetry between those last two is SDK behaviour, not a cinatra policy: the
handshake is lenient, the header is strict. It is recorded here because it is
surprising and because tests must cover both paths, not one.

**TARGET.** Exactly one of the two rows below, selected by the ruling. Whichever
applies, the behaviour is covered by a test in both directions — the
acceptance-or-rejection must be a decision, not a side effect of a default.

| If the ruling selects | Accepted inbound set | An older-revision inbound peer |
| --- | --- | --- |
| `legacy: 'stateless'` | `2026-07-28` + `2025-11-25` + `2025-06-18` + `2025-03-26` + `2024-11-05` + `2024-10-07` | **Accepted** and served through the 2025-era codec. `GET`/`DELETE` answered `405`. The lenient-handshake / strict-header asymmetry above is preserved, and the preservation is deliberate and tested. |
| `legacy: 'reject'` | `2026-07-28` only | **Rejected** with the unsupported-protocol-version error naming `2026-07-28` as the only supported revision; legacy-classified notifications get `202` and are dropped. Requires release communication before it ships. |

No third option is in scope: 2.0.0 exposes no handler-valued `legacy` option, and
a user-land `isLegacyRequest()` split in front of `legacy: 'reject'` reproduces the
`'stateless'` row's accepted set with more moving parts, so it is not a distinct
policy.

## Outbound — per client surface

### CURRENT

`@modelcontextprotocol/sdk` is declared `^1.29.0` in the root `package.json` and
the lockfile resolves **`1.29.0`**, whose `LATEST_PROTOCOL_VERSION` is
`2025-11-25` and whose `SUPPORTED_PROTOCOL_VERSIONS` is the same five-revision
list as the server side.

| Surface | Client | Offers on `initialize` | Accepts from server |
| --- | --- | --- | --- |
| `src/lib/connector-instance-mcp-transport.ts` | SDK `Client` + `StreamableHTTPClientTransport` | `2025-11-25` | the five legacy revisions |
| `packages/marketplace-mcp-client/src/http-client.ts` | SDK `Client` + `StreamableHTTPClientTransport` | `2025-11-25` | the five legacy revisions |
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
calls in `packages/marketplace-mcp-client/src/http-client.ts` are REST catalog
`GET`s, distinct from the `Client` on the same file's MCP path.

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
| `packages/marketplace-mcp-client/src/http-client.ts` | `@modelcontextprotocol/client@2.0.0` | `'auto'` | `2026-07-28` preferred; the five legacy revisions via fallback |
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

- **The inbound accepted set / `legacy` posture.** Open; owner-gated under #2218.
  Recording it here is a prerequisite for wiring the 2.0.0 handler.
- **`Mcp-Method` / `Mcp-Name` CORS admission.** Follows header-routing adoption,
  which is a separate, non-automatic decision.
- **Anything about conformance.** The presence of a TARGET paragraph is not
  evidence that any surface implements it.
