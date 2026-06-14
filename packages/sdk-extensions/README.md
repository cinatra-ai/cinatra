# @cinatra-ai/sdk-extensions

The Cinatra extension SDK — the **frozen author-facing ABI** every Cinatra
extension (agent, connector, skill, artifact, workflow) builds against.

It is intentionally a leaf, host-agnostic contract package: an extension
peer-depends on `react` / `next` / `@cinatra-ai/sdk-*` only and reaches every
privileged host capability through the injected `ctx` ports — never via a
`@/lib/*`, `@/components/*`, or `@/app/*` import.

## What it provides

- **`register(ctx)` host-port surface** (`ExtensionHostContext`) — the privileged
  ports the host injects at activation: `db`, `settings`, `secrets`, `nango`,
  `authSession`, `mcp`, `objects`, `jobs`, `notifications`, `ui`, `logger`,
  `runtime`, `capabilities`, and `telemetry`.
- **Manifest + dependency contracts** — the `cinatra.*` package-manifest shape,
  the dependency-graph types, and the package-export contract.
- **Loader / registry types** — the shared activation driver and ABI-range check.

## ABI version

The SDK ABI is **`2.2.0`** (`SDK_EXTENSIONS_ABI_VERSION` in
[`src/register.ts`](src/register.ts) — the authoritative source of truth, also
mirrored as `cinatra.sdkAbiVersion` in this package's `package.json`). A CI gate
asserts this README, the `register.ts` constant, and the `package.json` field
all agree, so the documented ABI can never drift from the code.

### Versioning policy

The ABI is semantic-versioned independently of the npm package version (see
*ABI vs npm version* below):

- **MAJOR** — a breaking change to the author-facing contract: removing or
  changing the signature of an existing host port or its methods, the
  `register`/`bootstrap`/`destroy` lifecycle, or a manifest field — **and adding
  a new host port** (the port set is declared FROZEN in
  [`src/host-context.ts`](src/host-context.ts): `ExtensionHostContext` exposes
  every port as a required property, so a new port widens the surface every
  extension is type-checked against — a breaking change). An extension built
  against an older MAJOR is not guaranteed to activate.
- **MINOR** — a backward-compatible, *additive* change: a new **optional** method
  on an existing host port. Extensions built against an older MINOR keep working
  unchanged; only those that need the new method must raise their declared range
  (or feature-detect it).
- **PATCH** — documentation/typing clarifications with no surface change.

### ABI changelog

- **`2.0.0`** — added the `telemetry` host port (metered connectors).
- **`2.1.0`** — added optional `mcp.getPublicBaseUrl`.
- **`2.2.0`** — added optional `nango` render-time getters: `getStatus`,
  `getFrontendConfig`, `getPrimarySavedConnection(s)`, `listConnectionRecords`.

### ABI-evolution policy

The port surface is **frozen**, but it evolves under a fixed policy. Each host
port carries a lifecycle **tier** (exported as `HOST_PORT_TIER`, a
`Record<HostPortName, HostPortTier>`; the derived reserved set is
`RESERVED_HOST_PORTS`):

| Tier | Meaning | Granting it |
| --- | --- | --- |
| `stable` | Wired, frozen, safe to use. | Returns the real host impl. |
| `reserved` | Declared in the frozen surface but **not wired** yet. | Fail-loud at runtime (`"not-implemented"`) until a future MINOR wires it. |

Today only **`db`** is `reserved` (the scoped, least-privilege escape hatch —
config goes through `settings`, credentials through `secrets`). An extension may
list a `reserved` port in `cinatra.requestedHostPorts`, but the manifest
generator **warns** (it is not build-blocked) and any access throws at runtime.

How the tier governs the version bump:

- **Adding a NEW port** → ABI **MAJOR**. Older hosts don't have it; an extension
  needing it is correctly skipped on a host below the new major.
- **Wiring a `reserved` → `stable` port** → ABI **MINOR**. The port already
  exists in the surface; an older host simply fail-louds it, and an extension
  that needs the wired behaviour declares the floor (`>=` the wiring minor).
- **Removing or reshaping a port** (changing its method signatures or privilege
  model) → ABI **MAJOR**.

`HOST_PORT_TIER` is the **canonical** tier table. The host's grant-aware factory
derives its `"not-implemented"` branch directly from it (in-process, a real TS
import). The build-time manifest generator (`scripts/extensions/generate-extension-manifest.mjs`)
runs under bare Node and cannot import the TS SDK, so it keeps a **literal mirror**
of the derived `reserved` set for its warning — that mirror is not trusted blindly:
a vitest parity test (`scripts/extensions/__tests__/host-port-tiers-parity.test.ts`)
asserts it exactly equals the SDK's derived `RESERVED_HOST_PORTS`, so any drift
fails CI. Wiring a reserved port is a one-line tier flip in `HOST_PORT_TIER` (the
host factory follows automatically); the generator's mirror is the one parity-guarded
copy you also update, and the test will flag it if you forget.

#### Future direction (not yet built)

- **Minimum-minor type folding** — making the optional MINOR-added methods (e.g.
  the 2.2.0 `nango` render getters) *non-optional* on the ctx type when an
  extension declares a high-enough `sdkAbiRange`, so the type system enforces the
  floor instead of feature-detection. This is a **breaking** type change (it
  would require an ABI 3.0); the policy is documented here, the type is deferred.
- **Grant-typed ctx** — a `ctx` parameterized by the manifest's
  `requestedHostPorts` so an ungranted port is a *compile-time* error rather than
  a runtime fail-loud. Deferred; runtime grant enforcement remains the boundary.

### Declaring a compatible range (`cinatra.sdkAbiRange`)

A server-entry extension pins the host ABI range it needs via
`cinatra.sdkAbiRange` in its package manifest; the loader refuses to activate an
extension whose declared range the host ABI does not satisfy
(`isSdkAbiRangeSatisfied` in [`src/register.ts`](src/register.ts)). The check is
**fail-closed**: an unsupported/malformed range, or a host ABI outside the
range's bounds, is refused.

Supported grammar (exactly what the loader accepts — anything else is rejected):

The bounds are `[lower, upperExclusive)` — the host ABI satisfies the range when
it is at or above `lower` and strictly below `upper` (a `∞` upper means no
ceiling):

| Form | Example | Satisfied by host ABI in |
| --- | --- | --- |
| Absent / `""` / `*` | *(unset)* | any (unpinned) |
| Exact | `2.2.0` (or `=2.2.0`) | `[2.2.0, 2.2.1)` |
| Bare major / x-range | `2`, `2.x`, `2.*` | `[2.0.0, 3.0.0)` |
| Minor x-range | `2.2`, `2.2.x`, `2.2.*` | `[2.2.0, 2.3.0)` |
| Caret (major only) | `^2` | `[2.0.0, 3.0.0)` |
| Caret (minor/patch) | `^2.2`, `^2.2.0` | `[2.2.0, 3.0.0)` |
| Tilde (major only) | `~2` | `[2.0.0, 3.0.0)` |
| Tilde (minor/patch) | `~2.2`, `~2.2.0` | `[2.2.0, 2.3.0)` |
| Minimum | `>=2`, `>=2.2.0` | `[2.0.0, ∞)`, `[2.2.0, ∞)` |

Notes that match the loader exactly:

- An operator may be followed by whitespace (`^ 2.2.0` is accepted).
- The `=` prefix is optional and equivalent to omitting it: a *full* `=2.2.0`
  is an exact pin, while a *partial* `=2` / `=2.2` widens exactly like the bare
  `2` / `2.2` x-range rows above (it does **not** narrow to an exact match).
  Prefer the bare spellings for clarity.
- The MAJOR must be **≥ 1** — major-`0` ranges are rejected (the ABI's major-`0`
  caret semantics differ; fail-closed).
- Any other comparator — `<`, `>`, `<=`, OR (`||`), hyphen ranges (`1 - 2`), and
  pre-release/build tags (`-rc.1`, `+meta`) — is **not** supported and is
  refused. The host ABI version is compared on its `MAJOR.MINOR.PATCH` prefix.

### Range-declaration guidance

Pick the *loosest* range that still guarantees the surface you use:

- Use **only** the frozen base surface? Declare `^2` (or `>=2.0.0`) — you ride
  every additive MINOR for free and only a MAJOR can lock you out.
- Need an **optional** method added in a MINOR? Either **feature-detect** it
  (`if (ctx.mcp.getPublicBaseUrl) …`) and keep `^2`, or declare the floor that
  guarantees it: `>=2.1.0` for `mcp.getPublicBaseUrl`, `>=2.2.0` for the `nango`
  render-time getters. Feature-detection keeps your extension installable on
  older hosts; a hard floor refuses activation there instead.
- Avoid exact (`2.2.0`) and tilde-minor (`~2.2`) pins unless you genuinely
  cannot tolerate a forward MINOR — they reject a perfectly compatible newer
  host.

### ABI vs npm version

The ABI version (`SDK_EXTENSIONS_ABI_VERSION`) and this package's npm `version`
are **independent** numbers: the ABI tracks the author-facing contract, the npm
`version` tracks releases of this package. They are not kept in lockstep — read
the host ABI an extension targets from `cinatra.sdkAbiRange`, never from a
package version. This package is currently `private: true` (not published); when
the types-only SDK split ships, the published npm version will carry its own
semver and the ABI changelog above remains the contract record.

### Testing against the ABI

`register(ctx)` is pure dependency injection — every privileged capability
arrives on `ctx`. A unit test constructs a fake `ExtensionHostContext` with just
the ports the extension touches (stub the methods you call; omit the rest) and
asserts your registrar wires them correctly — no live host, DB, or network. For
a port whose method talks to a local service in integration tests, point it at a
mock server on an ephemeral `localhost` port and inject that port through the
stubbed `ctx`; nothing about the ABI requires a fixed port.

## `cinatra.serverEntry` — published packages ship BUILT artifacts

A runtime-store-installed package's `cinatra.serverEntry` must resolve —
exports-map key first, else literal `./`-relative path — to an existing
`.mjs`/`.cjs`/`.js` file inside the package (the recommended published shape
is a top-level `register.mjs` with `cinatra.serverEntry: "./register.mjs"`).
TypeScript source, extensionless, and missing entries are refused at install
time. Full normative contract, error families, and the operator refresh
runbook: [`docs/extension-server-entry-contract.md`](../../docs/extension-server-entry-contract.md).

## Public surface is types-first (the host bus stays fenced)

The package root (`@cinatra-ai/sdk-extensions`) is the **types-first author
surface**: the `register(ctx)` ports, the manifest/dependency contracts, the
loader/register helpers, and the per-concern `Host*Service` / provider **TYPES**
an extension uses to type a capability `impl` resolved from `ctx.capabilities`.

The host service-bus **addressing constants** — the `@cinatra-ai/host:*`
capability ids the host registers per-concern service impls under
(`HOST_CONNECTOR_SERVICE_CAPABILITIES`, `NANGO_SYSTEM_CAPABILITY`,
`*_CAPABILITY` / `*_CAPABILITY_ID`) — are **host-internal** and are NOT on the
public root. They live behind the host-only `@cinatra-ai/sdk-extensions/internal`
subpath. An extension never value-imports them: it inlines the capability-id
string literal (the host-peer value-import ban) and types the `impl` against the
public TYPE. Two gates keep the root constant-free:

- `scripts/audit/sdk-public-surface-ban.mjs` — static source-text gate over
  `src/index.ts` (fail-closed for any `*_CAPABILITY` / `*_CAPABILITY_ID`),
- `src/__tests__/public-surface.test.ts` — runtime reachability proof.

## Allowed first-party dependencies

A Cinatra extension's only permitted `@cinatra-ai/*` **code** dependencies are
the SDK packages: this package and `@cinatra-ai/sdk-ui` (visual primitives).
Everything else is reached through a `ctx` port.

## Schema migrations (`cinatra.migrationsDir`)

A **trusted-signed** extension that owns Postgres tables ships **standard
[node-pg-migrate](https://github.com/salsita/node-pg-migrate) migrations** —
the same engine, options, and shared ledger the host core uses (cinatra#115/#118).
The HOST runs them; the extension never receives a DB handle.

### Declaring

Point `cinatra.migrationsDir` at a package-relative directory of migration
modules:

```jsonc
{
  "name": "@acme/crm-connector",
  "cinatra": {
    "kind": "connector",
    "serverEntry": "./register.mjs",
    "migrationsDir": "cinatra/migrations"
  }
}
```

> The pre-#118 declarative JSON-DSL field (`cinatra.migrations`) is **retired**
> and rejected fail-closed at install, boot, and hot-activate.

The host pins identity before any DDL: the materialized `package.json`'s
`name` must match the trusted package identity of the install/loader record
exactly, or the migration preflight refuses the package.

### Naming — the per-source ledger namespace

Every module in the directory must be named

```
ext_<scope>_<pkg>__NNNN_<short-description>.mjs
```

- `ext_<scope>_<pkg>__` derives from the package name: `@acme/crm-connector`
  → `ext_acme_crm-connector__`. The package name MUST be scoped and
  lowercase kebab-case (`[a-z0-9-]` segments — no underscores or dots);
  anything else has no derivable namespace and is refused.
- `NNNN` is a zero-padded, strictly increasing 4-digit sequence (`0001`, …),
  unique within your package. Shipped migrations are immutable — never
  renumber, edit, or delete one; supersede it with a new sequence number.
- `<short-description>` is lowercase `[a-z0-9-]` (hyphens, no underscores),
  starting with a letter or digit.
- The host validates **every visible entry** in the directory against this
  contract — a stray `README.md`, helper module, or subdirectory fails the
  preflight (dotfiles are ignored). Keep the directory migrations-only.
- Ledger names are the filenames without `.mjs`, capped at 255 characters,
  recorded in the host's shared `pgmigrations` ledger alongside `core__…`
  rows — the namespace is what keeps independently versioned sources from
  colliding.

### Module shape

A migration is a plain **runtime ESM** module exporting `up(pgm)` and
`down(pgm)` (node-pg-migrate's `MigrationBuilder`):

```js
// cinatra/migrations/ext_acme_crm-connector__0001_create-leads.mjs
/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`CREATE TABLE IF NOT EXISTS ext_acme_crm_connector_leads (
  org_id text NOT NULL,
  id text PRIMARY KEY,
  email text
);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS ext_acme_crm_connector_leads_org_idx
  ON ext_acme_crm_connector_leads (org_id);`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DROP TABLE IF EXISTS ext_acme_crm_connector_leads;`);
}
```

Rules (the host enforces the mechanical ones; the rest are the contract you
sign up to by being trusted):

- **Raw SQL via `pgm.sql`** is the default; the full `pgm.*` builder API and
  arbitrary async work are available. Use `pgm.noTransaction()` for
  statements that cannot run inside a transaction (e.g.
  `CREATE INDEX CONCURRENTLY`); otherwise each migration runs in its own
  transaction.
- **Unqualified table names** — the runner sets `search_path` to the host
  app schema.
- **Safe to re-run** on a schema already at target shape (`IF EXISTS` /
  `IF NOT EXISTS` guards): branch/clone flows can re-encounter applied
  states.
- **Write a real `down()`** (or document why it is irreversible).
- **Plain runtime ESM only** — no TypeScript, no build step. The host
  imports the module in-process; relative imports within your package work,
  but bare-specifier dependencies are NOT guaranteed to resolve (the store
  does not materialize your `node_modules`) — `pgm` already carries the full
  builder/SQL surface. No symlinks: the host refuses symlinked migration
  modules.
- One migration per concern; append-only.

### When migrations run, and the trust gate

The host applies your chain (always **up**, oldest pending first):

- at **install** — *before* the install is finalized: a failed migration
  aborts the install (it never becomes trusted/activatable);
- at **boot** and **hot-activate** — before your `register(ctx)` runs; a
  failed migration excludes the extension from activation.

Migrations run **only for `trusted-signed` packages** — the same Ed25519
signature gate that authorizes importing your server code in-process. An
unsigned or bootstrap-trusted package that declares `migrationsDir` is
**refused** (install refuses to finalize; the loader refuses to import).
Workflow-kind packages installed through the workflow path cannot declare
host migrations at all — ship a `serverEntry` and use the runtime install
path.

### Responsibility on the shared schema

Your migration is arbitrary SQL on the **shared multi-tenant app schema** —
the host does not sandbox it (the trust boundary is the signature + review,
cinatra#118). The contract:

- touch **only your own tables** — prefix them `ext_<scope>_<pkg>_…`;
- carry **`org_id text NOT NULL`** on every table and filter by it in your
  queries (host-side tenancy convention);
- never touch `core` tables, other extensions' tables, or the
  `pgmigrations` ledger itself.

### Rollback

The host never migrates an extension down. Operators can revert your newest
ledger rows with
`cinatra db migrate --down --dir <abs migrations dir> --namespace ext_<scope>_<pkg>__`;
rolling back is fenced per namespace (your rows only). Prefer shipping a
superseding forward migration.
