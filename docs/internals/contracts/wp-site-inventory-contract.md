# wp-site-inventory contract v1 — WordPress MCP server enrichment (cinatra#2018)

Normative contract for the payload a **connected WordPress site pushes to core
to report its MCP Adapter server inventory**, driving per-instance multi-server
enrollment (add / update / retire). It couples two producers/consumers:

- **Core (consumer):** the zod schema in
  `src/lib/wordpress-site-inventory-contract.ts` is the single validation
  authority; the enrollment reconciler
  (`src/lib/wordpress-server-enrollment.ts`) diff-applies a parsed payload onto
  the host-owned `connector_instance_server` rows.
- **Site plugin (producer, cinatra#2021):** the cinatra WordPress plugin
  collects the inventory (MCP Adapter `get_servers()` enumeration) and sends it
  on the connect handshake, on admin-panel visits, and on its own cadence.

The **golden example** both sides must stay conformant to is the synthetic
fixture `src/lib/__tests__/__fixtures__/wp-site-inventory-v1.json` — it is
parsed by the same schema in core's tests, so a producer that reproduces the
fixture shape is valid by construction.

## Channel

```
POST /api/connect/site-inventory
Authorization: Bearer cnx_<siteId>_<secret>
Origin: <site origin>
Content-Type: application/json
```

Server-to-server; no session/cookies. All three headers are REQUIRED. The
`cnx_` credential (constant-time hash vs the `connect_sites` row) **is the
authentication**; the paired `Origin` header is a binding/consistency check
only (it prevents cross-site credential confusion and keeps parity with the
existing `cnx_` server-to-server paths — it adds no secrecy on a
server-to-server call). The verified site origin is then mapped to **exactly
one** connector instance by strict siteUrl match; zero or multiple matches
reject, and `claimedInstanceId` may only disambiguate among origin-matched
instances, never select outside them. An org cross-check between the
connect-site row and the instance's persisted org binding runs as defense in
depth. Pre-auth failures return a generic `400 {"error":"invalid_request"}`
(no oracle); post-auth validation failures return structured errors
(`unsupported_contract_version` with the supported list, `invalid_payload`,
`stale_payload`).

Body size cap: **256 KB**. Per-site debounce: **60 s** (`429` +
`Retry-After`).

## Ordering / anti-replay (`inventorySeq`)

The payload carries a REQUIRED site-generated monotonic `inventorySeq`
(integer, `0 ≤ seq ≤ 2^53−1`, JS-safe bound, schema-enforced), scoped to the
**credential generation** as its epoch. Core accepts a payload iff its
`(credentialVersion, inventorySeq)` pair is **strictly newer** than the last
accepted pair for the instance:

```
accept  ⇔  credentialVersion > stored.credentialVersion
        ∨ (credentialVersion = stored.credentialVersion ∧ inventorySeq > stored.inventorySeq)
```

A stale pair returns a structured `400 stale_payload` and applies **nothing**
— a replayed or out-of-order inventory can never retire newer servers. The
gate, the server-row diff and the stored-pair advance run atomically per
instance, so concurrent intakes serialize and the loser is rejected against
the advanced sequence. Credential rotation starts a new epoch (the sequence
may restart) — a reinstalled/reset site that lost its counter recovers by
reconnecting, no manual unwedge. The producer persists its counter (a WP
option) and increments it on every send. `collectedAt` is advisory
(debugging) and is never trusted for ordering.

## Payload shape (v1)

See the schema module for exact bounds/patterns. Summary:

| Field | Type | Semantics |
|---|---|---|
| `contractVersion` | `"v1"` | Unknown version → `unsupported_contract_version` + supported list. |
| `client` | `"wordpress"` | Literal in v1; the intake additionally cross-checks it against the authenticating credential row's client. |
| `inventorySeq` | int | See above. |
| `collectedAt` | ISO-8601 | Advisory only. |
| `claimedInstanceId` | string? | Disambiguation only among origin-matched instances. |
| `site.wpVersion` / `site.phpVersion` | string | Site versions (≤32). |
| `site.adapterVersion` | string \| null | `null` ⇒ MCP Adapter absent ⇒ `servers` MUST be `[]` (all previously discovered servers retire; the default server row stays and its probe reports truthfully). |
| `site.abilitiesPluginVersion` | string \| null? | Optional. |
| `site.connectedUserRole` | string | The connection App-Password user's primary role (surfacing only). |
| `site.permalinkStructure` | `"pretty" \| "plain"` | Informational; core's injected endpoints use the query-string REST form either way. |
| `servers[]` | ≤100 entries | The `get_servers()` enumeration; `[]` is valid. `adapterServerId` values must be unique per payload. |

Per server entry:

| Field | Semantics |
|---|---|
| `adapterServerId` | The MCP Adapter registry id — the stable natural identity core digests into its host-minted `serverId`. Route moves under the same id keep the same identity (caches/health/policy refs survive). |
| `namespace`, `route`, `restPath` | `restPath` MUST canonically equal `"/" + namespace + "/" + route` (cross-checked; mismatch rejects). It is a PATH, resolved only against the verified instance's own siteUrl — same-site by construction. |
| `name`, `description`, `version` | Display metadata (name/version changes on a reused `adapterServerId` are audited core-side). |
| `transports` | Site-normalized enum `streamable-http \| stdio \| sse \| unknown` (the producer maps the adapter's PHP transport class names; unmappable → `unknown`). |
| `requiresDedicatedAuth` | Site-declared "demands its own auth" flag. |
| `isDefault` | Pinned BIDIRECTIONALLY to the default route (`/mcp/mcp-adapter-default-server`): `isDefault` requires that route AND that route requires `isDefault`; at most one default entry per payload. That entry refreshes metadata on the grandfathered always-enrolled default row and never joins the discovered-identity reconciliation (so it can never shadow a real server's registry id out of the retire pass). |
| `toolCount` | Advisory only. |

## Enrollment semantics (what core does with an accepted payload)

- **Auto-enroll** an entry iff `transports` includes `streamable-http` AND
  `requiresDedicatedAuth` is false. Credential acceptance is verified
  **operationally** (first probe/catalog load) — never trusted from the
  payload; a server that rejects the connection App-Password keeps its row but
  serves no tools (health shows `auth_error`).
- **Present, not enrolled:** every other reported entry is persisted with a
  typed reason (`custom_transport` / `custom_auth`) — surfaced, never silently
  dropped. Per-server credential capture is out of scope for v1.
- **Retire:** previously discovered servers absent from an accepted payload
  retire (tools fail closed). Manually enrolled routes are NEVER touched by
  reconciliation, and the default server never retires.
- The payload is the **enumeration authority** — core cannot discover
  dedicated routes by probing; between pushes a site-side deletion fails
  closed operationally (probe/catalog failure) until the next accepted
  inventory formalizes the retire.

## Responses

- `200 {"accepted":true,"enrolled":N,"presentUnenrolled":M,"retired":K}`
- `400` generic pre-auth (`invalid_request`); structured post-auth
  (`unsupported_contract_version`, `invalid_payload`, `stale_payload`)
- `429` + `Retry-After` on the per-site debounce

## Consumer note — enrollment state is host-owned

Enrollment state is deliberately NOT part of the connector instance config
blob. Any settings UI, export/backup or migration path that needs an
instance's server set must read the host enrollment surface
(`listInstanceServers` on the `wordpress-mcp` host service); the instance blob
alone no longer describes the full site integration.

## Versioning

`SUPPORTED_SITE_INVENTORY_VERSIONS` lists what a core build accepts. The v1
objects are STRICT: unknown fields are rejected, so additive producer-side
fields require a new contract version; unknown versions are rejected loudly
with the supported list so a newer plugin degrades visibly.
