# Supported MCP protocol revisions

Which MCP specification revisions cinatra accepts inbound on `/api/mcp`, which it
offers outbound per client surface, what it does when it meets a peer on an
older revision — in both directions — and, for each feature the current revision
deprecates, the migration position cinatra has recorded
([Deprecated features](#deprecated-features--cinatras-migration-positions)).

## How to read this document

Every statement below is tagged **CURRENT** or **TARGET**.

- **CURRENT** describes what the code on `main` actually does. Each claim names
  the file (and, for SDK behaviour, the bundled function) it was read from. The
  outbound section was verified against `origin/main` @ `a57a6c4` on 2026-07-29,
  and its graphiti row was rewritten by the cinatra#2218 **L2a** client
  migration from a live wire measurement against the pinned peer image; the
  inbound section was rewritten by the cinatra#2218 **L1** server cutover
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

**The status an unauthenticated probe is answered with (CURRENT).** This runs
before any era routing below, so it is stated first. Verified against
`origin/main` @ `06bc554` (cinatra#3130): `packages/mcp-server/src/index.tsx`
(`transportHandler`, `createUnauthorizedResponse`) and
`packages/mcp-server/src/dev-admin-bypass.ts` (`grantDevAdminBypassThroughPort`).

The fixture is the DEFAULT posture and only that: `CINATRA_MCP_DEV_ADMIN_BYPASS`
unset, and no `Authorization` header. `grantDevAdminBypassThroughPort`
returns false unless that variable is exactly `"true"`, before it consults the
installed bypass port at all — and it refuses again when nothing has filled that
port. The bypass decision reads no hostname in any case, so the answer below
does not depend on which host the probe arrives on.

| Method | Status | Answered by |
| --- | --- | --- |
| `OPTIONS` | **204** | `transportHandler`'s preflight branch, before the auth gate — a preflight is never gated on a credential. |
| `GET` / `POST` / `DELETE` | **401** | `createUnauthorizedResponse`: JSON `{ "error": "unauthorized", "message": "Authentication is required to access the Cinatra MCP server." }` plus `WWW-Authenticate: Bearer resource_metadata="…"`. Answered before any method-specific transport handling, so all three are identical. |
| any other method | **405** | Next.js's own route dispatch — `src/app/api/mcp/route.ts` exports only the four methods above, so an unsupported one never reaches `transportHandler`. `transportHandler` answers 405 separately at the mount boundary when invoked directly with one. |

This is a statement of what the code already does; cinatra#3130 changed no
behaviour. It is pinned by `src/app/api/mcp/__tests__/route.test.ts`, so a change
to any of the three statuses has to change that test — and this paragraph — too.

Two 405s are easy to confuse. The one above is the top-level METHOD gate,
reached with no credential. The one in the legacy-leg row further down is what an
AUTHENTICATED `GET` / `DELETE` gets as an unsupported 2025-era session
operation, reached only after authentication has already passed.

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
format for every existing caller. (The in-repo Anthropic function-tools probe at
`src/app/configuration/mcp/llm-access/test/route.ts` — which POSTed `tools/list`
and called `.json()` on the result — was the worked example here until
cinatra#2579 replaced that handler with a tool-free key-validation probe; the
argument stands unchanged for the external callers, which cinatra does not
control.) The **accepted set**
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

**Zero of the four outbound surfaces run `@modelcontextprotocol/sdk`.** The
client migration to `@modelcontextprotocol/client@2.0.0` ran one surface at a
time and all four have landed — the connector-instance transport was the last
(cinatra#2218 **L2d**). **The v1 SDK is gone from every manifest this repo
tracks**: cinatra#2218 **L2z** deleted the root `package.json` dependency, the
root importer's lockfile entry, and the v1 build-externalization entry in
`config/build-config.manifest.json` (and the `next.config.ts` line it generates).

Stated at exactly that width, because three CLASSES of reference to the specifier
survive here and none of them is a host-runtime dependency of this repo:

1. one CI capture harness whose optional dynamic import is caught, and whose
   workflow installs its own copy;
2. one direct declaration in a synced-but-untracked extension
   (`extensions/cinatra-ai/wordpress-mcp-connector`, a workspace member, so it
   keeps its own committed lockfile importer entry) that imports nothing;
3. the remaining lockfile resolutions — mostly third-party (`drizzle-cube`,
   `@modelcontextprotocol/ext-apps`, `@google/genai`'s optional peer), but
   **including one first-party edge**: the published `@cinatra-ai/cinatra@0.1.8`
   snapshot, which predates the CLI's own migration.

Each is resolved individually below.

**How this section got here (cinatra#2218 L2z, two attempts).** An earlier
revision said that dependency's "only remaining consumer in the tree is one CI
capture harness". **That was wrong**, and the first L2z attempt stopped on it
rather than forcing the removal: an exhaustive search found **two cinatra-owned
production consumers** the L2a–L2d plan never enumerated. Both have since been
cleared in their own repos, and this run performed the removal the corrected
table gated. The full table is kept below with each row resolved, because the
resolution — not the removal — is the evidence.

| Consumer (as recorded by the blocked attempt) | Kind | Resolution at this change |
| --- | --- | --- |
| `extensions/cinatra-ai/drupal-mcp-connector` — `src/lib/drupal-mcp-client.ts` imported the v1 `Client` + `StreamableHTTPClientTransport` and backs `callDrupalMcp`, the transport behind every Drupal content handler | **Production source, cinatra-owned. A FIFTH outbound MCP surface the L2a–L2d plan never enumerated.** Declared nothing; resolved through the root manifest's hoisted symlink | **CLEARED.** Migrated to `@modelcontextprotocol/client@2.0.0` on `versionNegotiation: { mode: 'auto' }` **and** declaring the dependency itself (lane **L2e**, its own repo); pin advanced here by cinatra#2473 (`d3cddae29`). Re-proved in the synced tree at this change: its only MCP import is `@modelcontextprotocol/client`, and a `createRequire` probe from `drupal-mcp-client.ts` resolves `@modelcontextprotocol/client` and answers `MODULE_NOT_FOUND` for `@modelcontextprotocol/sdk` — which is now the correct answer, because it no longer asks |
| `@cinatra-ai/cinatra` (the cinatra CLI, repo `cinatra-ai/cinatra-cli`; a root **devDependency** here) — `src/marketplace-mcp.mjs` imported the v1 `Client` + `StreamableHTTPClientTransport`, `src/login.mjs` the whole OAuth surface from `@modelcontextprotocol/sdk/client/auth.js` | **Production source, cinatra-owned. A SIXTH v1 consumer.** Declared `^1.29.0` properly, so it resolved from its own `.pnpm` sibling `node_modules` and never depended on the root symlink | **CLEARED AT SOURCE, NOT YET IN THE PUBLISHED ARTIFACT — stated plainly.** `cinatra-ai/cinatra-cli#202` (merged `cb7be8ef`, 2026-08-06) moved both consumers to `@modelcontextprotocol/client@2.0.0`; the CLI's `main` manifest no longer declares the v1 package. The pinned root devDependency here is the **published** `@cinatra-ai/cinatra@0.1.8`, which predates that merge, so the lockfile still records `@modelcontextprotocol/sdk: 1.29.0` under its snapshot until the CLI's next release lands and this pin moves. **That is not a cinatra-source consumer**: the CLI is a build/setup **tool** (`node_modules/.bin/cinatra`, materialized into the image at `Dockerfile:53`), no cinatra source file imports `@cinatra-ai/cinatra` at all (zero hits over `src/`, `packages/`, `tests/`, `scripts/`, `extensions/`), and therefore nothing in cinatra reaches the v1 symbol **through** the CLI |
| `tests/e2e/wp-mcp-gateway/capture-annotations.mjs` | CI capture harness (sub-claim (b)); its retained `SSEClientTransport` fallback is recorded in the deprecated-features section below | **SCOPED OUT, deliberately** — the file's bytes are hashed as `producerSha256` into all nine committed captures, so any edit reds the required capture-freshness gate until a fixture-boot harvest rewrites them. Unaffected by this change in CI: the workflow `npm install`s its own copy into `tests/e2e/wp-mcp-gateway/node_modules`. One honest local consequence below |
| `extensions/cinatra-ai/wordpress-mcp-connector` | Declares `@modelcontextprotocol/sdk` `^1.29.0` in its own `package.json` but **never imports it** — a stale first-party declaration | **STILL OPEN, in its own repo.** It is a workspace member here, so it keeps its own lockfile importer entry; it never resolved through the root symlink and does not block anything. Removing a declaration nothing imports is a one-line change in `cinatra-ai/wordpress-mcp-connector` |
| `drizzle-cube` (`packages/dashboards`, `packages/sdk-dashboard`), `@modelcontextprotocol/ext-apps` (required peer, via drizzle-cube) | Third-party hard dependencies | **UNCHANGED and expected to stay.** They keep the package in the lockfile; they add no cinatra source import |
| `@google/genai` (`packages/llm`, `extensions/cinatra-ai/gemini-connector`) | **Optional** peer; cinatra never calls `mcpToTool` (zero hits repo-wide) | **UNCHANGED**, not load-bearing |

**What the removal actually did, measured.** Deleting the root `package.json`
line and re-running `pnpm install` (after clearing pnpm 11's
`node_modules/.pnpm-workspace-state-v1.json`, which otherwise false-greens a
`--frozen-lockfile` check in ~190 ms against a stale state) drops exactly three
lockfile lines — the root importer's `@modelcontextprotocol/sdk` block — and
nothing else. `node_modules/@modelcontextprotocol/` now contains `client` only;
the `sdk` symlink is gone, which is the phantom-dependency escape hatch closing.

**What the removal did NOT do, also measured.** The runtime image ships
`.next/standalone`, not the full tree, so "what does the shipped image lose?" is
a separate question from "what does the manifest declare?" — and it was answered
by building BOTH sides. `@modelcontextprotocol/sdk` is **absent from
`.next/standalone` in the baseline build too** (the same tree with the root
dependency restored): identical eleven-entry public top level
(`@opentelemetry`, `bullmq`, `ioredis`, `next`, `pg`, `react`, `react-dom`,
`tar`, `typescript`, `undici`, `zod`) and, in the hidden-hoist directory,
`@modelcontextprotocol/core` only — in both builds. A root DECLARATION is not a
trace: Next copies what the server graph actually reaches, and after L2a–L2d
nothing reached the v1 package. The claim this supports is exactly that and no
more: **the standalone trace is unchanged with respect to this specifier**, so
the removal takes nothing out of what the runtime image ships. (It is not a claim
that the two images are otherwise identical — that was not measured.)

**Why the root declaration was load-bearing at all**, recorded because it is the
mechanism that made the blocked attempt necessary: pnpm's default `isolated`
linker (there is no root `.npmrc`, and `pnpm-workspace.yaml` sets no linker or
hoist option — the synced extensions carry their own `.npmrc` files but those set
only `auto-install-peers` / `verify-deps-before-run`, never a linker or hoist
key) publicly links a package into the root `node_modules/` **only**
when it is a direct dependency of the root importer, while transitive copies stay
inside `.pnpm/` where a workspace package's upward directory walk cannot reach
them. An extension that imports a package the root declares — without declaring
it itself — therefore compiles, and breaks the moment the root line goes. That is
what the Drupal connector did, and L2e fixed it at the source rather than by
keeping the root line alive.

**A note on what "removed" can ever mean here.** `drizzle-cube`, the published
CLI artifact and the WordPress connector's stale declaration all keep
`@modelcontextprotocol/sdk` in `pnpm-lock.yaml`, and none of those edges is
something this repo's own manifests decide. Zero lockfile occurrences is
therefore the wrong completion test for cinatra#2218. The right one is all four
of, with the state at this change:

1. zero cinatra-owned **source** imports (production, tests and CI harnesses
   alike) — **met for production source in every repo**; the one remaining
   cinatra-owned import anywhere is the CI capture harness in this repo, scoped
   out above with its own retirement path;
2. zero first-party **direct declarations** — **met in this repo**; one stale
   declaration remains in `cinatra-ai/wordpress-mcp-connector`, which imports
   nothing;
3. zero direct **installs** outside the manifests — **not met, deliberately**:
   the capture workflow's `npm install --prefix tests/e2e/wp-mcp-gateway` step
   is the harness's own copy and retires with the harness;
4. both build-externalization entries (`config/build-config.manifest.json` and
   the `next.config.ts` block it generates) removed — **met**.

**The one honest local consequence of the removal.** The capture harness's
dynamic import previously resolved by walking up to the root `node_modules`
symlink when run locally without the nested `npm install`. That symlink is gone,
so a bare local run now degrades sub-claim (b) to its recorded
`sdkAvailable: false` finding instead of succeeding. CI is unaffected — the
workflow installs the harness's own copy, and that step is already
`continue-on-error: true` with the same graceful degrade. The authoritative
annotation proof is the raw path (a) either way.

**Lockfile occurrences after the removal: 15** (16 before; the root importer's
key line is the one that went). None is a cinatra **source** edge — but they are
not all *transitive* either: one is a direct workspace declaration (the WordPress
connector's, which imports nothing) and one is the published CLI pin's snapshot.
Counted exactly:

| Occurrences | What they are |
| --- | --- |
| 2 | the `@modelcontextprotocol/sdk@1.29.0` package entry and its peer-keyed snapshot entry |
| 1 | the `extensions/cinatra-ai/wordpress-mcp-connector` importer's stale direct declaration |
| 1 | the published `@cinatra-ai/cinatra@0.1.8` snapshot's dependency (the CLI pin, pre-`cli#202`) |
| 2 | `drizzle-cube@0.6.4`'s snapshot dependency, and its `@modelcontextprotocol/ext-apps` peer edge (whose key embeds the sdk) |
| 3 | `@modelcontextprotocol/ext-apps@1.7.4`'s peer declaration, its snapshot key and its snapshot dependency |
| 6 | `@google/genai@2.8.0`'s **optional** peer declaration + `peerDependenciesMeta` entry, its snapshot key and snapshot dependency, and the two importer edges that carry it (`packages/llm`, `extensions/cinatra-ai/gemini-connector`) |

Expect this count to move only when a third party drops the edge, the CLI pin
advances past `cli#202`, or the WordPress connector drops its stale declaration —
never through another direct ROOT declaration of the SDK.

**One in-repo comment this change makes stale, named rather than left to be
found.** `.github/workflows/wp-mcp-gateway-capture.yml` justifies its
harness-local install with "(root dep range `^1.29.0`)". After this change there
is no root dep range, so that parenthetical is false — the `^1.29.0` there is now
purely a **harness-pinned** range with no manifest behind it. It is not corrected
here because `.github/**` is deliberately untouched by this lane (editing any
workflow moves the change into the high-risk gate class). It is a one-line
comment fix, and — unlike the harness itself — editing the WORKFLOW does not
touch `producerSha256`, so it carries no recapture. It should ride the change
that retires the harness, or any other workflow-touching change.

**One cross-repo documentation residual, named rather than left to be found.**
`extensions/cinatra-ai/drupal-mcp-connector/AGENTS.md` and
`extensions/cinatra-ai/plane-connector/src/dev-setup.ts` still describe the host
or connector client as `@modelcontextprotocol/sdk`. Both live in their own repos
(`extensions/` is gitignored here and synced by
`scripts/ci/sync-dev-extensions.mjs`), so neither is editable from this change;
both are comments with no effect on resolution or the wire.

| Surface | Client | Negotiation | Offers on `initialize` | Accepts from server |
| --- | --- | --- | --- | --- |
| `src/lib/connector-instance-mcp-transport.ts` | **`@modelcontextprotocol/client@2.0.0`** | **`{ mode: 'auto' }` — explicit, live-wire-measured** | nothing on a modern peer (`server/discover` instead); `2025-11-25` on the legacy fallback | `2026-07-28` where the peer answers the probe; today's pinned WordPress adapter, the five legacy revisions |
| `http-client.ts` in `packages/marketplace-mcp-client` | **`@modelcontextprotocol/client@2.0.0`** | **`{ mode: 'auto' }` — explicit, measured** | `2026-07-28` on the probe, then `2025-11-25` on the legacy fallback | `2026-07-28` when the peer offers it; today the five legacy revisions |
| `packages/objects/src/graphiti-client.ts` | **`@modelcontextprotocol/client@2.0.0`** | **`{ mode: 'legacy' }` — explicit, measured** | `2025-11-25` | the five legacy revisions |
| `packages/agents/src/external-mcp-caller.ts` | **`@modelcontextprotocol/client@2.0.0`** | **`{ mode: 'auto' }` — explicit, wire-observed** | nothing on a modern peer (`server/discover` instead); `2025-11-25` on the legacy fallback | `2026-07-28` where the peer answers the probe, else the five legacy revisions |

**The graphiti row moved with cinatra#2218 L2a**, and its mode is a measured
decision rather than a holding position. The peer is a digest-pinned image —
`zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2`, pinned in
`docker-compose.yml` — and it was probed. It does not implement `2026-07-28`:
it answers a `server/discover` probe `400` / `-32600 "Missing session ID"`, and
it refuses a session-less `tools/list` the same way, so it is a **sessionful
2025-era peer**. Measured against that exact digest, on the live wire:

| Mode passed | Negotiated era | Revision | HTTP frames per connect-and-call |
| --- | --- | --- | --- |
| `{ mode: 'legacy' }` | `legacy` | `2025-11-25` | 5 |
| `{ mode: 'auto' }` | `legacy` | `2025-11-25` | 6 (the extra one is the rejected probe) |
| `'auto'` as a bare string | `legacy` | `2025-11-25` | 5 — **no probe issued at all** |

`auto` therefore reaches an identical era at the cost of one rejected round
trip, and this client opens a fresh connection **per call**, so that cost would
be per call rather than once per process. That is the general policy below
applied, not an exception to it: the policy names explicit `{ mode: 'legacy' }`
as correct for a surface whose peer is *known* 2025-era and whose transport
reconnects per call.

The third row is the bare-string trap, confirmed on the wire rather than only
from the source: it produces a fully working client that never negotiated.
`packages/objects/src/__tests__/graphiti-client.test.ts` asserts the options
object reaches the `Client` constructor with `mode === 'legacy'`, and
`graphiti-wire-negotiation.manual.test.ts` is the re-runnable live probe (gated
on `RUN_GRAPHITI_WIRE_PROOF=1`).

The session id the pinned peer requires is minted and held by the client
library and stays transport-private — cinatra does not read, persist, route, or
authorize on it, per this issue's acceptance criterion 4.

**The `external-mcp-caller.ts` row moved with cinatra#2218 L2c**, and it is the
one surface whose mode is `{ mode: 'auto' }` on principle rather than on a
measurement of one peer: its peers are arbitrary third-party servers an
administrator registers at run time, at URLs cinatra neither controls nor pins,
so per-peer negotiation is the only posture that can be correct. It was the
outlier before that change — a hand-rolled `tools/list` POST with
`Accept: application/json`, no handshake and no `MCP-Protocol-Version` header,
i.e. a claim-less POST with no revision to state. Two properties of the surface
it replaced, both measured on the wire rather than inferred:

- a conformant 2025-era peer refuses that POST **`406`** on the `Accept` header
  alone, before any protocol question is reached;
- against a modern-only peer it fails with no negotiation error to explain why.

Measured for the migrated module against real `@modelcontextprotocol/server@2.0.0`
peers, through a frame-recording proxy
(`packages/agents/src/__tests__/external-mcp-caller-negotiation.test.ts`, which
runs ungated in the normal suite — the peers are in-process, so no container and
no network access are required):

| Peer | Mode passed | Negotiated era | Revision | HTTP frames |
| --- | --- | --- | --- | --- |
| modern (`2026-07-28`) | `{ mode: 'auto' }` | `modern` | `2026-07-28` | 2 |
| 2025-era only | `{ mode: 'auto' }` | `legacy` | `2025-11-25` | 4 (the first is the refused probe) |
| modern (`2026-07-28`) | `'auto'` as a bare string | `legacy` | `2025-11-25` | 3 — **no probe issued at all** |

The third row is the bare-string trap in its costly form: the peer *does* speak
`2026-07-28`, and the string still lands the connection on the 2025 era with
nothing reporting it.

**Implementation note carried by this row.** On both `client@2.0.0` and
`sdk@1.29.0` the Streamable HTTP transport builds each request as
`{ ...requestInit, method, headers, signal }`, so a caller-supplied
`requestInit.signal` is **overwritten and bounds nothing**. Measured against a
black-hole peer: a `1200 ms` `requestInit.signal` returned only after the
protocol timeout, where the same deadline imposed through the transport's
`fetch` option, or through `connect(transport, { timeout })`, returned at
`~1200 ms`. This surface therefore carries its per-server budget on the custom
`fetch` and on the protocol-level `timeout`, not on `requestInit`.

**The marketplace row moved with cinatra#2218 L2b, and it lands on `auto` rather
than graphiti's `legacy` because the two peers differ in exactly the way the
policy below turns on.** The peer — the wordpress/mcp-adapter at
`/wp-json/cinatra/mcp`, probed live and anonymously — does not implement
`2026-07-28` today: it answers a `server/discover` probe `400` / `-32600
"Missing Mcp-Session-Id header"`, refuses a session-less `tools/list` the same
way, and on `initialize` the server SELECTS `2025-06-18`. Measured on the live
wire, per connect-and-call cycle: `{ mode: 'auto' }` reaches era `legacy` at
`2025-06-18` in 3 frames, `{ mode: 'legacy' }` reaches the identical era and
revision in 2. But this peer is an independently-operated hosted service, not a
digest-pinned image — it can gain `2026-07-28` (or drop the 2025-era
`initialize`) with no change in this repo and no signal that would prompt one.
The explicit-`legacy` exception is scoped to a peer that is *known* 2025-era AND
PINNED, so it does not reach here: `auto` costs one rejected round trip if the
peer never moves, and `legacy` breaks outright if it does.
The client package's `tests/marketplace-wire-negotiation.manual.test.ts` is the
re-runnable live probe (gated on `RUN_MARKETPLACE_WIRE_PROOF=1`); when it starts
failing, the peer answered the probe and this row moves to the modern revision
with no code change.

That same change reworked the one consumer that discriminated marketplace errors
BY CLASS — the offline-rename gate in
`src/app/configuration/instance/actions.ts` — in the same commit, because the v2
client raises `SdkHttpError`/`ProtocolError` where v1 raised
`StreamableHTTPError`/`McpError`, and a gate left on the old classes would have
read a reachable-but-erroring marketplace as an unreachable one and failed OPEN.
The gate now consumes a three-way origin (`unreachable` / `peer-response` /
`indeterminate`) from `classifyMarketplaceFailure()` in the client package and
may only relax on `unreachable`, which requires a brand the client stamps on the
`fetch()` rejection itself — no error CLASS is accepted as proof, because undici
raises `TypeError` both for a connect failure and for a body stream that dies
after a real HTTP 200.

Not MCP protocol surfaces, listed so they are not mistaken for gaps:
`src/lib/wordpress-mcp-connection.ts` and `src/lib/drupal-mcp-connection.ts`
issue `HEAD` reachability probes only and carry no MCP traffic; the raw `fetch`
calls in that same `http-client.ts` are REST catalog `GET`s, distinct from the
`Client` on the same file's MCP path.

**The connector-instance row moved with cinatra#2218 L2d — the last outbound
surface, and the one the restated acceptance criterion 4 exists for.** Its peers
are the reason it is on `auto` rather than graphiti's explicit `legacy`: they are
**independently-operated WordPress and Drupal adapter instances at customer
URLs**, one per instance row, that cinatra neither controls nor pins. There is no
peer whose era could be decided once in the source, so per-peer negotiation is
the only posture that can be correct for every row at once. The explicit-`legacy`
exception is scoped to a peer that is *known* 2025-era AND PINNED and cannot
reach a customer endpoint.

Today's pinned adapter (`mcp-adapter` 0.5.0, the digest-pinned CI fixture) does
**not** implement `2026-07-28`, re-verified live on 2026-08-05: it answers a
`server/discover` probe carrying the modern `_meta` envelope `400` / `-32600
"Invalid Request: Missing Mcp-Session-Id header"`, and refuses a session-less
`tools/list` identically — a **sessionful 2025-era peer**. Measured on the live
wire through a recording proxy, one connect-and-call cycle under
`{ mode: 'auto' }` is **5 frames**: the refused probe, `initialize` (the server
echoes `2025-11-25` and mints an `Mcp-Session-Id`), the initialized
notification, the standalone `GET` (answered `405`), then the call. The refusal
is a legacy VERDICT, not a failure — `classifyHttpError` parses the JSON-RPC body
and falls back.

`src/lib/__tests__/connector-instance-mcp-wire-negotiation.manual.test.ts` is the
re-runnable live probe (gated on `RUN_CONNECTOR_WIRE_PROOF=1`); when it starts
failing, the adapter answered the probe and this row moves to the modern
revision with no code change.
`src/lib/__tests__/connector-instance-mcp-negotiation.test.ts` runs ungated and
covers both eras in-process — the 2025-era leg against the pinned adapter's own
recorded frames, the modern leg against a real `@modelcontextprotocol/server@2.0.0`.

The stale `MCP_PROTOCOL_VERSION = "2025-06-18"` constant this section previously
recorded as a documentation-only divergence is **deleted**: the client now
negotiates, so no source file in this surface claims a revision.

**Sessions on this surface (acceptance criterion 4).** The pinned peer REQUIRES a
session handshake, and that is permitted: the id is minted and held by the client
library, replayed by it on every post-handshake frame, and stays
transport-private. cinatra never reads, persists, routes, or authorizes on it.
The transport exposes no accessor for it, and it reaches no application value, no
error, and no log line — proven behaviourally (capture the id the peer actually
minted, then assert its absence from every escape channel) in the AC4 suite of
`connector-instance-mcp-negotiation.test.ts`, and on the live wire in the manual
probe.

**Error-taxonomy note carried by this row.** v2 drops v1's message prefixes
(`"Streamable HTTP error: "`, `"MCP error <code>: "`), so this surface's session
split — `session_required` (JSON-RPC `-32600`) vs `session_not_found`
(`-32005`, which buys exactly one bounded retry) — is now read STRUCTURALLY from
`SdkHttpError.status` and the JSON-RPC code parsed out of `SdkHttpError.data.text`.
`classifyTransportError` became an ALLOWLIST at the same time: only
`network_error` and `timeout` map to the relaxed `unreachable` server-health
state, so both now require positive proof (a brand stamped on the `fetch()`
rejection itself; `SdkErrorCode.RequestTimeout` or the `AbortSignal` contract),
and every unproven shape becomes the new fail-CLOSED `transport_error`. The
pre-migration classifier defaulted the other way — its final statement was an
unconditional `network_error` — so an answering peer's 5xx, and an auth wall,
both reported as `unreachable`.

### The standing outbound policy (now CURRENT on every surface)

This section stated the TARGET while the migration was in flight. **All four
surfaces have landed**, so it now describes implemented behaviour and the rules
any future outbound surface inherits — for the four surfaces **this repo owns**.
The fifth outbound surface the original lane plan missed
(`extensions/cinatra-ai/drupal-mcp-connector`) landed as **L2e** in its own repo
on the same policy — `{ mode: 'auto' }`, dependency declared — and the sixth
cinatra-owned v1 consumer, the CLI, migrated in `cinatra-ai/cinatra-cli#202`.
**L2z** then removed the root host-runtime dependency on
`@modelcontextprotocol/sdk` and its build externalization — the manifests this
repo tracks, not every reference in the working tree. See the resolution table
under **Outbound — CURRENT** above for each consumer's state, the three surviving
references, and what is still outstanding elsewhere.

The outbound path runs `@modelcontextprotocol/client@2.0.0`. This was a
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

**Outbound policy: `versionNegotiation: { mode: 'auto' }` on every surface
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

Per surface — **all four LANDED; see CURRENT above for the measurement behind
each mode**:

| Surface | Client | Negotiation | Accepted from server |
| --- | --- | --- | --- |
| `src/lib/connector-instance-mcp-transport.ts` | **LANDED** (L2d) | **`{ mode: 'auto' }`**, live-wire-measured: peers are customer-operated adapter instances, so no pinned-peer exception applies | `2026-07-28` preferred; the five legacy revisions via fallback |
| `http-client.ts` in `packages/marketplace-mcp-client` | **LANDED** (L2b) | **`{ mode: 'auto' }`**, measured: the peer refuses `server/discover` today and `auto` falls back cleanly, but it is a hosted service that can move without a cinatra change | `2026-07-28` preferred; the five legacy revisions via fallback |
| `packages/objects/src/graphiti-client.ts` | **LANDED** (L2a) | **`{ mode: 'legacy' }`**, measured: the pinned image rejects `server/discover`. Flip to `{ mode: 'auto' }` when the image pin moves to one that answers it | the five legacy revisions |
| `packages/agents/src/external-mcp-caller.ts` | **LANDED** (L2c) | **`{ mode: 'auto' }`**, wire-observed against both peer classes | `2026-07-28` preferred; the five legacy revisions via fallback |

Whichever mode a surface lands on, the migration must **prove** it: an assertion
that `server/discover` was (or was not) issued and that the expected revision was
negotiated. A package version is not evidence of a negotiation — the bare-string
trap above produces a fully working client on the wrong era.

The `external-mcp-caller.ts` row was a decision rather than a deferral:
it negotiated nothing, which meant it failed silently
against a modern-only peer and could never reach `2026-07-28`; leaving it
hand-rolled would have made it the single surface whose revision posture was
unstatable. With L2d landed, **all four outbound surfaces now share one
negotiation model**, and the stale `MCP_PROTOCOL_VERSION = "2025-06-18"` constant
and its module comment are deleted rather than updated — the client library owns
the offered revision, so no cinatra constant should appear to.

### Behaviour on an older-revision outbound peer

**CURRENT.** Interoperate. On the legacy leg the client offers `2025-11-25`; a
server that answers with any of the five accepted revisions is accepted and used,
including `2025-06-18`. A server answering a revision outside that set fails the
handshake. With L2d landed this is `client@2.0.0` behaviour on every outbound
surface — reached through the `{ mode: 'auto' }` fallback on three of them and
through explicit `{ mode: 'legacy' }` on graphiti.

The migrated graphiti surface behaves the same way and reaches it more
deliberately: on `client@2.0.0` with `{ mode: 'legacy' }` it runs the plain
2025 sequence — byte-identical to the pre-migration client — and interoperates
with its sessionful 2025-era peer. Its peer is one cinatra pins, so "an
older-revision peer" is not a contingency there but the measured steady state.

The migrated `external-mcp-caller.ts` surface reaches the same outcome by
negotiating it per peer, which is the only way it *can* be reached there: its
peers are arbitrary and change at run time, so there is no peer whose era could
be decided once in the source. Under `{ mode: 'auto' }` a 2025-era peer refuses
the `server/discover` probe and the connection completes on the legacy
`initialize` path; a `2026-07-28` peer answers the probe and the connection
never issues `initialize` at all. Both outcomes are wire-observed, not inferred.

Before that migration this surface performed no negotiation, so it did not
*observe* the peer's revision — but the peer's revision posture still decided
the outcome. Its headerless, claim-less POST succeeded only against peers that
answer a **bare `tools/list`** with no prior handshake, *and* accept
`Accept: application/json` alone — narrower still than "2025-era", since a
conformant 2025-era peer answers that Accept header `406` before reaching any
protocol question, and is free to require the `initialize` exchange and a
protocol session on top (the module header of
`src/lib/connector-instance-mcp-transport.ts` records exactly that case, where a
bare `tools/list` returns HTTP 400 `-32600 "Missing Mcp-Session-Id header"`). It
also **failed against a modern-only peer**, with no negotiation error to explain
why. "Negotiates nothing" was never "unaffected": it meant the surface had no
revision posture to state and no diagnostic when a peer's posture excluded it.

**Standing policy** (was TARGET; now implemented on all four surfaces).
Unchanged in outcome, by design: under
`versionNegotiation: { mode: 'auto' }` an older-revision server is detected by
the absent or non-overlapping `server/discover` probe and served through the
legacy `initialize` path, so the five legacy revisions stay reachable outbound.
On a surface that ships explicit `{ mode: 'legacy' }` — graphiti today — the
same five stay reachable without the probe at all. **cinatra does not drop
support for calling 2025-era MCP servers.** Any future change to that is a
separate decision with its own release communication.

For `external-mcp-caller.ts` the change has landed, and it is an improvement for
every **conformant** peer rather than a strict improvement for every peer: an
older-revision peer is now reached through the same legacy fallback as the other
surfaces, and a modern-only peer became reachable instead of silently failing.

**Two non-conformant peer classes became unreachable**, recorded here rather
than left to be discovered. Both were measured on the wire:

1. a peer that answers a bare `tools/list` with no handshake **and** accepts
   `Accept: application/json` alone, but does not implement `initialize`. Both
   extra conditions are load-bearing — a conformant 2025-era peer answers that
   Accept header `406` before reaching any protocol question — so this class is
   narrower than "permissive 2025-era server", but it is not empty;
2. a peer whose `tools/list` **result** is not schema-conformant. Measured case:
   `{ tools: [{ name: "x" }] }` with no `inputSchema`. The hand-rolled code read
   `.name` off whatever JSON came back; `client.listTools()` validates the
   result against the spec schema and rejects, so such a row now yields nothing
   instead of its tool names.

Neither class fails silently or blocks anything: each fails per-row, is logged
with the row's label, and leaves the compile running with the remaining rows —
the same degradation as an unreachable server. Recovering them would mean
keeping a hand-rolled parse beside the SDK client, which reinstates exactly the
unstatable-revision-posture problem this row's migration removed.

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

## Deprecated features — cinatra's migration positions

`2026-07-28` deprecates a set of features with a stated **twelve-month minimum**
removal window running from the revision's publication date, 2026-07-28.
Deprecation is not removal: nothing on the list stops working inside the window,
and the window is about removal TIMING — it is not a promise that old and new
revisions interoperate.

This section is the cinatra#2218 scope-item-7 record: for each deprecated
feature, **the position cinatra takes** and **the evidence that position rests
on**. Every row is CURRENT unless it says otherwise.

**Grounding method, and why it matters here.** Each "not used" position below was
re-derived by grep against the tree at the time this section was written, over
`src/`, `packages/`, `tests/`, `extensions/` and `scripts/`, excluding
`node_modules/`. The searched token set is named in each row so the claim is
re-runnable rather than merely asserted. That re-derivation is not ceremony: it
already **corrected** one carried-forward claim (the legacy HTTP+SSE row below —
a flat "no usage found" that is true of the server half and false of the client
half). A position copied from an earlier assessment is not evidence.

### Logging — NOT USED

**Position: no migration. The window may expire with no action on our side.**

Evidence: **zero** occurrences of `logging/setLevel`, `notifications/message`,
`sendLoggingMessage`, `LoggingMessageNotification`, `setLoggingLevel`,
`LoggingLevel`, or a `logging` member of a capabilities literal. cinatra's
per-request runtime server (`packages/mcp-server/src/runtime-server.ts`)
registers tools, resources, prompts, screens and an optional `experimental`
block — never a `logging` capability — so `/api/mcp` does not advertise one, and
no outbound surface sets a log level or reads `notifications/message`.

**The near-namesake that is NOT this feature.** `src/lib/mcp-logging.ts`, the
`/configuration/mcp` logging toggles, and the JSON transcripts under
`data/logs/mcp-server/` + `data/logs/mcp-client/` are cinatra-local **file**
logging of MCP traffic. They carry no capability, no RPC and no notification —
they are ordinary application logging that happens to log MCP — and the
deprecation does not touch them. Anyone reading "logging is deprecated" onto that
module would be deleting a working admin feature for no reason.

### Legacy HTTP+SSE transport — NO PRODUCTION RELIANCE; one retained CI fallback

**Position: nothing to migrate on any production surface, and one live fallback
branch in a CI-only capture producer that is deleted (not ported) when that
producer's SDK dependency goes.** Stated that way deliberately: the branch is
retained code that will execute if its condition is met, so "no usage" would be
false. What is true is that no shipped surface, and no code path a cinatra user
can reach, speaks the deprecated transport.

This row **corrects** the earlier flat "no `SSEServerTransport` / `SSEClientTransport`
usage found". The server half is right; the client half is not.

- **`SSEServerTransport` — zero occurrences in source, tests and tooling** (the
  only occurrences of the name anywhere in the repo are in this document itself).
  cinatra never offers the legacy two-endpoint SSE transport inbound. `/api/mcp`
  is served only by the two legs recorded above
  (`WebStandardStreamableHTTPServerTransport` for the 2025 era,
  `createMcpHandler` for the 2026 era), and `GET` / `DELETE` on that path are
  answered `405`.
- **`SSEClientTransport` — exactly one file.**
  `tests/e2e/wp-mcp-gateway/capture-annotations.mjs` (lines 280, 286, 295, 313)
  dynamically imports `@modelcontextprotocol/sdk/client/sse.js` and uses it
  **only as a fallback** after a StreamableHTTP attempt throws, when capturing
  `tools/list` annotations from the pinned WordPress gateway fixture. It runs on a
  CI runner from `.github/workflows/wp-mcp-gateway-capture.yml` against a
  docker-composed fixture; it is in no runtime bundle and no user-facing path.
  The committed capture records which transport actually answered, and for both
  captured servers that is `"transport": "streamable-http"`
  (`tests/e2e/wp-mcp-gateway/captures/annotations-b-sdk-listtools.json`) — the SSE
  branch did not fire **in the captured runs**. That is evidence about the runs
  observed, not a guarantee about future ones: the branch is still live and would
  execute if the StreamableHTTP attempt threw.

  **Migration position:** the fallback is deleted, not re-expressed, when this
  harness stops using `@modelcontextprotocol/sdk`. Two mechanical facts set the
  shape of that change, and neither was understood when this position was first
  recorded. First, the capture **workflow** does not rely on the root manifest —
  it `npm install`s its own copy into `tests/e2e/wp-mcp-gateway/node_modules`, so
  the L2z root-dependency removal neither broke the CI run nor retired the
  fallback. (It did change ONE thing, recorded rather than discovered: run
  locally without that nested install, the harness used to reach the root copy by
  the ordinary upward walk, and now cannot — a bare local run degrades sub-claim
  (b) to its `sdkAvailable: false` finding. The CI path is the one that matters
  here, and it is unchanged.) Second, the harness's own bytes are a provenance input
  (`producerSha256`), so **any** edit to it invalidates the nine provenanced
  captures and reds the required capture-freshness gate until a fixture-boot
  harvest rewrites the transcripts. Retiring the fallback is therefore its own
  change, carrying its own recapture — not a rider on the dependency removal.
  It needs no deprecation window of its own: it is a
  diagnostic convenience against a fixture we pin and control, whose gateway is
  observed serving Streamable HTTP, and a red capture run is a CI signal rather
  than a user-visible outage. Until then it stays, and it stays **live**: if the
  StreamableHTTP attempt throws, the producer takes the SSE branch and uses its
  result. The position is "retained as an optional CI fallback", not "unused" and
  not "unrelied upon" — the honest scope of the claim is that nothing a cinatra
  user can reach depends on it.

**Three things that look like this feature and are not.** The deprecated feature
is the two-endpoint `GET`-a-stream + `POST`-messages transport pair, not SSE
framing in general:

- `Accept: application/json, text/event-stream` on Streamable HTTP calls (e.g.
  `src/app/api/external-mcp/proxy/[serverId]/route.ts`) is the 2025-era
  Streamable-HTTP requirement, not the SSE transport.
- The `text/event-stream` responses under `/api/a2a`, `/api/notifications/stream`
  and the agent/assistant run streams are cinatra's own streaming surfaces on
  other protocols entirely.
- The inbound legacy leg's `normaliseAcceptHeader` (see the CORS/Accept bullet
  above) appends `text/event-stream` to satisfy that same requirement while the
  leg still answers `application/json`.

### Roots / Sampling / Elicitation — NOT USED

**Position: no migration. The window may expire with no action on our side.**
Ruled on cinatra#2223, which closed as "no change".

Evidence, re-derived rather than carried over: **zero** occurrences of
`elicitInput`, `elicitation/create`, `elicitUrl`, `createMessage`,
`requestSampling`, `sampling/createMessage`, `roots/list` or `listRoots`. The
vendored server tree that used to carry the vocabulary was deleted by the L1
cutover, so not even a dormant copy remains.

The one flow with an elicitation-*shaped* contract — the connector-instance
destructive-call confirmation park — is a first-party typed refusal plus an
out-of-band resume, not an MCP primitive. cinatra#2223 evaluated re-expressing it
as Multi Round-Trip Requests and declined, recording a reopen trigger on that
thread. Nothing here depends on the deprecated primitives in either direction.

### Dynamic Client Registration (DCR) — RETAIN, with usage telemetry

**Position: RETAIN through the deprecation window.** This is the one deprecated
feature cinatra actually relies on. Recorded maintainer decision (cinatra#2218,
2026-08-05), quoted in full so the terms are not paraphrased away:

> **Dynamic Client Registration: retain.** DCR stays enabled through the
> deprecation window (twelve-month minimum from 2026-07-28). Usage telemetry is
> added now so any removal is evidence-gated; removal happens only via a future
> issue that also delivers the successor mechanism (Client ID Metadata
> Documents). The L4 dispositions record carries this as the recorded migration
> position.

Three terms bind, and all three are load-bearing:

1. **DCR stays enabled** — no flag flip, no soft-deprecation, no warning banner
   inside the window.
2. **Removal is evidence-gated** — the telemetry below is the evidence channel, so
   a removal proposal that cites no observation window is not admissible.
3. **Removal ships the successor in the same issue** — Client ID Metadata
   Documents (CIMD). Removing DCR without CIMD would strip the only self-service
   admission path for MCP clients, so "remove DCR" is never a standalone change.

#### Where DCR actually lives (CURRENT)

| Piece | Where | What it does |
| --- | --- | --- |
| The endpoint | `POST /api/auth/oauth2/register` (`registerOAuthClient` in `@better-auth/oauth-provider`) | RFC 7591 client registration |
| The enablement | `buildMcpAuthPlugins` in `packages/mcp-server/src/auth-plugins.ts` | `allowDynamicClientRegistration: options.… ?? true` **and** `allowUnauthenticatedClientRegistration: options.… ?? true` |
| The caller | `createMcpServerAuthPlugins(...)` in `src/lib/auth.ts` | passes **neither** flag, so both keep the `?? true` default; passes `clientRegistrationDefaultScopes` (the base scopes) and `clientRegistrationAllowedScopes` (base + CLI) |
| The advertisement | `src/app/.well-known/oauth-authorization-server/api/auth/route.ts` | the provider emits `registration_endpoint` **only while** dynamic registration is enabled |
| The cinatra shim | `POST` in `src/app/api/auth/[...all]/route.ts` | unions `mcp:connect` into a **client-supplied** `scope` |

Two facts worth stating plainly, because they change what "retain" costs:

- **DCR is on by cinatra's choice, not by inheritance.** The upstream plugin
  defaults `allowDynamicClientRegistration` *and*
  `allowUnauthenticatedClientRegistration` to `false`; cinatra's builder flips
  both to `true`. So the endpoint is open to unauthenticated registration, rate-
  limited by the provider's own default budget on `/oauth2/register`.
- **The shim exists because of an ordering rule in the provider.** Its
  registration handler applies `clientRegistrationDefaultScopes` only when
  `scope` is FALSY — absent, `undefined` or `""`
  (`if (!body.scope) body.scope = …`). An MCP client that registers with an
  explicit narrow scope (the MCP CLI proxy registers with `openid email profile`
  and asks for `mcp:connect` later, from the protected-resource metadata)
  therefore bypasses the default and fails the subsequent authorize with
  `invalid_scope`. The shim unions `mcp:connect` into that explicit scope; it
  leaves a falsy-scope body untouched so the provider's own default still
  applies.

#### The usage telemetry (CURRENT)

`src/lib/mcp-dcr-telemetry.ts` emits one structured event per DCR registration
attempt, from the single seam both paths pass through (the `POST` handler in
`src/app/api/auth/[...all]/route.ts`). It follows the repo's existing
structured-event convention — `console.info(JSON.stringify({ event: "…", … }))`,
as used by the skill-match maintenance sweeps — rather than introducing a new
telemetry substrate for one counter.

`omitted` and `unusable-scope` are kept apart on purpose. The provider fills in
`clientRegistrationDefaultScopes` only when `scope` is FALSY — absent,
`undefined`, or `""` — so a whitespace-only `scope` is truthy and gets no
defaults, and a non-string `scope` is refused by the endpoint's body schema.
Reporting either as "the client omitted scope" would describe a client the
provider defaults for and a client it does not as the same observation. Both are
forwarded untouched: this lane records admission behaviour, it does not change
it.

Event name: `mcp_dcr_registration`. Fields:

| Field | Values | Answers |
| --- | --- | --- |
| `path` | `plugin-default` · `cinatra-scope-shim` | Is the reliance the endpoint, or the endpoint **plus** our shim? |
| `scopeDisposition` | `omitted` · `already-required` · `widened` · `unusable-scope` · `unreadable-body` | Which branch of the scope rule the client landed in |
| `clientRequestedScopeCount` | integer, pre-union | How specific the client's own request was |
| `outcome` | `accepted` · `rejected` · `handler-error` | Whether the attempt succeeded |
| `status` | HTTP status, or `null` when the handler threw | The rejection class |
| `occurredAt` | ISO-8601 | When |

**What is deliberately NOT in the payload**, and this is a contract, not an
oversight: no `client_id`, no `client_secret`, no bearer or session token, no
`redirect_uris`, no `client_name` / `software_id`, no request headers, no
response body, and no verbatim client-supplied scope string. A registration
response carries a freshly minted client secret; nothing derived from it is
logged. The payload is dimensions and counts only.

**Silence is part of the contract, and it is scoped.** The event fires for a DCR
registration attempt and for nothing else — no other auth route, no `GET`, no
non-registration `POST`, and not for a near-miss path like
`/api/auth/x/oauth2/register` (the seam matches the registration path exactly, so
an over-matching predicate cannot inflate the reading). Both halves are pinned by
tests (`src/lib/__tests__/mcp-dcr-telemetry.test.ts` and
`src/app/api/auth/[...all]/__tests__/route-dcr-telemetry.test.ts`).

**But the emit is best-effort, so a quiet log is NOT self-certifying.** The
recorder swallows its own failures — telemetry must never turn a working client
registration into a failed one — which means "no events observed" is consistent
with both "no client registered" and "the log sink was broken, or this build was
not deployed, or its stdout was never collected". Stated here rather than
discovered later: an empty reading supports a **no-observed-use** claim only once
the deployment-and-collection question is answered separately. It is not a
prerequisite for removal either — a reading full of events can also clear the
gate, once CIMD demonstrably covers the cases those events describe.

#### What the telemetry can and cannot decide

It can distinguish three states that "is DCR used?" collapses together, and the
successor work differs in each:

1. **No events at all** — no client registered dynamically *in what was
   collected*. DCR removal costs nothing observable; CIMD is still required as
   the replacement admission path. This state is the one that needs the
   deployment/collection check above before it counts.
2. **Events with `path: plugin-default` only** — clients use DCR, but none needs
   our scope shim. The shim can be deleted independently of, and before, the DCR
   decision.
3. **Events with `path: cinatra-scope-shim`** — at least one client depends on
   the narrow-scope workaround, so CIMD must cover that case before DCR goes.

It **cannot** substitute for the decision. It is one install's server-side view;
it says nothing about clients that would register if they tried; the emit is
best-effort, so an empty reading also has to rule out a broken or uncollected log
path; and an observation window has to be declared **before** the reading is
taken, not chosen afterwards to fit a conclusion. A removal proposal cites the
window it declared, that the instrumented build ran and was collected across it,
the counts within it, and the CIMD design — not a bare "we saw nothing".

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
- ~~**What cinatra does about the features `2026-07-28` deprecates.**~~
  **Settled: recorded above** (cinatra#2218 scope item 7) — Logging and
  Roots/Sampling/Elicitation are unused; the legacy HTTP+SSE transport has no
  production reliance and one retained CI-only fallback branch; and DCR is
  RETAINED with usage telemetry per the 2026-08-05 maintainer decision. What is
  NOT settled there, deliberately: the DCR **removal** decision and the CIMD
  successor design, which are a future evidence-gated issue.
- **Anything about conformance.** The presence of a TARGET paragraph is not
  evidence that any surface implements it.
