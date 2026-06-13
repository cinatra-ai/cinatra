# Extension-coupling audit gates — classification, exemption policy, end-state

This document is the reference the extension-coupling gates point at. It
defines the shared reference taxonomy, the strict exemption policy, and the
**zero-floor end-state** (cinatra#151 Stage 7 — the close of the zero-floor
IoC epic, built on the zero-tolerance flip cinatra-ai/cinatra#36 that closed
the IoC Runtime Cutover epic #24 — completed in BOTH directions by the
cinatra#172 flip).

These gates pin a **LEXEME** — a concrete extension package NAME
(`@scope/ext`) or an `extensions/<scope>/<name>` path/import — not extension
**IDENTITY**. Under that lexeme reading the zero-floor end-state holds: no
hand-written host code imports or names a concrete extension package *lexeme*,
no extension imports host `@/` modules / other extensions / non-SDK
first-party packages, and the gates are pinned so none ever can again.

What the lexeme gates do NOT cover is the **identity surface**: the parallel
slug / route / env-var / capability-id strings by which producer and consumer
match each other BY NAME. The owner ruled (cinatra-engineering#155, eng#168(c)
"the middle path") that the unavoidable identity references are a documented
**exempt class** (see [Identity-surface exempt class](#identity-surface-exempt-class-cinatra-engineering155)
below), and that the two genuinely DANGEROUS identity-coupling kinds are FIXED
and guarded by the stateless `identity-coupling-gate.mjs`. So the strict
statements in this document are precise under the lexeme reading and are
EXPLICITLY bounded that way wherever an identity reading would over-claim.

## The gates

| Gate | Direction | Unit | Baseline |
| --- | --- | --- | --- |
| `core-extension-instance-coupling-ban.mjs` | core (`src/` + `packages/`) naming a specific extension (string/JSX/prompt/metadata literal, path literal, or import) | `file :: kind :: value -> count` occurrences | `core-extension-instance-coupling-ban.baseline.json` — **PINNED EMPTY** |
| `core-extension-import-ban.mjs` | core (`src/`) importing an extension package | `file -> extension` edges | `core-extension-import-ban.baseline.json` — **PINNED EMPTY** |
| `extension-import-ban.mjs` | extensions importing host `@/` modules, other extensions, or non-SDK first-party packages | `extension -> module` edges in 3 dimensions | `extension-import-ban.baseline.json` — **PINNED EMPTY** |
| `required-extensions-cover-host-imports.mjs` | the prod bootable DECLARATION vs the live code surface | packages | live-derived (no baseline) + the **declaration equality guard** |
| `identity-coupling-gate.mjs` | IDENTITY surface — auth-route-guard public-route exemptions naming a concrete extension; host `src/` re-declaring an SDK-owned capability id literal | dangerous-class findings | **stateless** (no baseline; every finding is a hard fail) |

`discovery-dispatcher-bypass-ban.mjs` guards the runtime-discovery dispatcher
(its documented `SANCTIONED_READERS` allowlist is "sanctioned, never counted" —
distinct from the baseline, which is pinned EMPTY since the flip — cinatra#36).
`host-peer-value-import-ban.mjs` holds every serverEntry graph at 0 host-peer
value imports (SDK peers stay type-only). `identity-coupling-gate.mjs` is the
NEW (cinatra-engineering#155) identity-surface guard — it pins extension
IDENTITY where the others pin only the lexeme; see the dedicated section below.

## Enforcement model — the zero-floor end-state (cinatra#151 Stage 7 + the cinatra#172 flip)

FOUR baselines are PINNED EMPTY — zero is the floor AND the ceiling, in BOTH
directions of the IoC rule:

- **`core-extension-instance-coupling-ban`** (the Stage 7 flip): any
  non-comment occurrence of an extension package name or
  `extensions/<scope>/<name>/` path literal in core source fails CI
  immediately; a non-empty committed baseline is itself a failure;
  `--write-baseline` refuses non-empty output. The frozen `SCANNER_EPOCH`
  (=2) and the `CORE_EXT_INSTANCE_BAN_BASE` monotonic guard survive purely as
  tamper checks (fail-closed on unresolvable refs / any epoch mismatch).
- **`core-extension-import-ban`** (the Stage 3 honest-zero flip, landed WITH
  the shared-lexer adoption + the last transport edges' removal): any
  core->extension import edge fails immediately; same non-empty-baseline and
  `--write-baseline` refusals; `CORE_EXT_BAN_BASE` kept as a tamper check.
- **`discovery-dispatcher-bypass-ban`** (the #36 flip): any non-sanctioned
  direct native-reader reference fails immediately.
- **`extension-import-ban`** (the cinatra#172 flip — the extension→host
  direction, completing the IoC rule's zero floor in both directions): any
  current `hostInternal`, `crossExtension`, or `sdkOnly` edge fails
  immediately (the committed baseline is no longer consulted for violation
  detection); a committed baseline with any non-empty dimension is itself a
  failure; `--write-baseline` refuses non-empty output; `--strict-sdk-only`
  is retained as an accepted no-op (the `sdkOnly` dimension is
  unconditionally zero-tolerance — neither passing nor omitting the flag can
  weaken enforcement); the owner-ruled `STRICT_SDK_ONLY_ALLOWLIST` (EMPTY,
  self-policing via the stale-carve-out hard failure) is the only carve-out
  mechanism, scoped to the `sdkOnly` dimension exclusively; `IMPORT_BAN_BASE`
  survives purely as a fail-closed tamper check.

On top of the pinned-empty gates:
- the cover gate enforces the **declaration equality**
  `requiredExtensions == systemExtensions == lock` (cinatra#151 Stage 7) ON
  TOP of its live bootable-coverage derivation: the prod bootable declaration
  may not grow beyond the system set without an owner ruling that also
  declares the package a systemExtension. The equality pins the DECLARATIONS
  only — regrowth of hard-coded extension names in code is caught by the two
  pinned-empty coupling gates, and an undeclared hard import is caught by the
  live coverage derivation, not by the equality.

Changing any of this requires editing the gate code and its tests in a
reviewed PR — there is no data path (baseline, epoch, seed, regenerate) that
can raise a floor.

## Reference classification (shared taxonomy)

Defined in `scripts/audit/lib/extension-reference-classification.mjs` and used
by the coupling gates:

- **runtime-coupling** — core selects/loads/branches on a specific extension
  at runtime (named imports, loader maps, provider registration,
  prompt/dispatch literals). The default class; ZERO occurrences remain — any
  reappearance fails the pinned-empty gates.
- **mechanical** — re-export facades, hand-written inventories/catalogs, and
  dev-name lists. Counted exactly like runtime-coupling — never exempt. Every
  counted *lexeme* (a concrete extension package name) is at ZERO since the
  mechanical-cleanup phase (#35): the classified mechanical files
  (`packages/extensions/src/system-extension-inventory.ts`,
  `src/lib/objects/surface-inventory.ts`,
  `packages/connectors-catalog/src/descriptors.mjs`) carry no pinned
  extension-name literal and would hard-fail the pinned-empty gates if one
  reappeared. NOTE under the IDENTITY reading: `descriptors.mjs` IS a live,
  hand-maintained slug→packageId catalog (the connector identity surface) —
  "ZERO" is the count of pinned package-name *lexemes*, not "no hand catalog
  exists". The catalog is a SANCTIONED identity surface (see the
  Identity-surface exempt class) and pins no lexeme because every packageId is
  DERIVED from its slug via `packageIdForSlug`.
- **permanent-exempt** — never counted. Strict, owner-ruled set; see below.

## Strict exemption policy

Permanently exempt are ONLY:

1. **The generator-emitted file list** — the exact files
   `scripts/extensions/generate-extension-manifest.mjs` emits (the shared
   `GENERATED_MANIFEST_FILES` list: `extensions.server.ts`,
   `connector-setup-pages.ts`, `extensions.client.tsx`,
   `widget-stream-public-paths.ts`, `agent-bindings.ts` under
   `src/lib/generated/`, plus the ONE package-local emission
   `packages/objects/src/generated/artifact-floor.ts` — cinatra#151 Stage 6:
   the semantic-floor binding lives inside `packages/objects` because that
   package is consumed from graphs where the host `@/` alias does not
   resolve; same generator, same byte pin, same explicit-list discipline —
   the exempt class is the EMITTED LIST, not a directory). Names there
   are generator output — the legitimate data-driven install list, not
   hand-coupling. The owner ruling on #36 made the generator-emitted set
   the ONE permanent-exempt class (the sibling generated maps are part of it,
   not a separate concession), unifying the instance-coupling and import-ban
   exempt sets. Two integrity guards keep the exemption honest:
   - the exemption is an EXPLICIT file list, never a directory prefix — a
     hand-added extra file under `src/lib/generated/` (or any `generated/`
     dir) is counted (default class runtime-coupling → hard fail);
   - the listed files are pinned to the generator's byte-exact output by the
     FAIL-CLOSED `generate-extension-manifest.mjs --check` CI step (drift,
     missing file, or catalog-parity break fails CI).
2. **The documented data-contract-ID allowlist**
   (`DATA_CONTRACT_ID_ALLOWLIST`) — stable string identifiers that embed an
   extension name as a frozen serialization/compatibility contract, NOT as
   runtime selection. Every entry must carry a written justification (the gate
   hard-fails on an unjustified entry), entries are added only with an owner
   ruling, stale entries hard-fail until removed, and allowlisted occurrences
   are reported separately from counted ones. IDs may contain ONLY the
   boundary alphabet `[A-Za-z0-9_.:/@-]` (`DATA_CONTRACT_ID_ALPHABET_RE`) —
   enforced as a structural defect — so the exact-ID masking can never
   prefix-mask a longer ID past a non-alphabet character. **EMPTY at the
   zero-floor end-state** — it stays empty unless an owner ruling mints an
   entry.
3. Test files (`*.test.*`, `*.spec.*`, `__tests__/`, `__mocks__/`, `tests/`)
   and the `extensions/` tree itself (an extension naming itself is fine).

No facades, no inventories, no dev-name lists are exempt — they are counted
(`mechanical`) and hard-fail if they ever reappear.

## Identity-surface exempt class (cinatra-engineering#155)

The lexeme gates above pin a concrete extension package NAME / path. They do
NOT see the parallel **identity surface** — the slug / route / env-var /
capability-id strings by which a producer and a consumer match each other by
name. The owner ruled (eng#168(c), "the middle path") that the unavoidable
identity references are SANCTIONED and that only the genuinely dangerous kinds
get fixed + guarded. The **sanctioned (exempt) identity surfaces** are:

- **Env-var names** (e.g. `NANGO_SECRET_KEY`, `CINATRA_*`). Referring to an
  environment variable by its stable name is intrinsic; these are sanctioned
  and not guarded.
- **Role-typed capability ids shared via a single SDK constant** (e.g.
  `email-send`, `llm-toolbox`). The SDK (`packages/sdk-extensions`) is the
  single authority — it exports each id as a `*_CAPABILITY` / `*_CAPABILITY_ID`
  constant. The capability id STRING is the sanctioned shared identity.
  CONSUMER side (HOST, `src/`): the host MUST import the SDK constant — what is
  FORBIDDEN (and guarded by `identity-coupling-gate.mjs`) is a host file
  RE-DECLARING that literal instead of importing it (precedent:
  `src/lib/llm-toolbox-providers.ts`, `src/lib/email-send-providers.ts`).
  PRODUCER side (EXTENSION `serverEntry`): an extension registers the capability
  via `ctx.capabilities.registerProvider("<id>", …)` using the id LITERAL — by
  design, NOT a regression. Extension serverEntry graphs keep their
  `@cinatra-ai/sdk-extensions` imports TYPE-ONLY (held at 0 host-peer VALUE
  imports by `host-peer-value-import-ban`), so a producer cannot import the
  VALUE constant without breaking that gate / its compile-against-older-host
  contract. The id literal at the producer is the frozen serialization contract;
  the gate scope is therefore HOST `src/` only (the consumer side the SDK
  constant exists for), not the extension producer side.
- **The connector slug catalog** (`packages/connectors-catalog/src/descriptors.mjs`):
  the single sanctioned hand-maintained slug→packageId catalog. It pins no
  package-name lexeme (every `packageId` is DERIVED from its slug via
  `packageIdForSlug`, and the org scope is the single `CONNECTOR_PACKAGE_SCOPE`
  constant), so a rename resolves away rather than re-pinning.
- **Namespaced object-type ids** (`@cinatra-ai/<ns>:<id>` map KEYS in the
  taxonomy / retention / new-url maps, e.g. `@cinatra-ai/agent-builder:agent-template`).
  These are persisted serialization-contract keys, not runtime extension
  selection; the `@cinatra-ai/agent-builder:*` ids routed WITHIN
  `packages/agents` are additionally centralized in
  `packages/agents/src/agent-builder-ids.ts` (the single id authority), so a
  producer/consumer mismatch is a build error, not a silent string mismatch.

The two DANGEROUS identity-coupling kinds are FIXED and guarded by the
stateless `identity-coupling-gate.mjs`:

1. **auth-route-guard public-route allowlist naming a concrete extension** — a
   per-extension public-route exemption is security-adjacent dangling state.
   The legitimate path is the GENERATED, manifest-derived
   `GENERATED_WIDGET_STREAM_PUBLIC_PATHS` list (no extension name in the guard
   source); the gate fails on any hand-pinned literal whose path segment equals
   a real extension short-name or embeds an extension package id.
2. **re-declared SDK capability constants** — a host `src/` file that
   re-declares an SDK-owned capability id literal (or passes it as a string
   literal to a capability-registry call) instead of importing the SDK
   `*_CAPABILITY` / `*_CAPABILITY_ID` constant. The gate fails on any such
   re-declaration (precedent: `src/lib/llm-toolbox-providers.ts` and
   `src/lib/email-send-providers.ts` both import the SDK constant).

The `DATA_CONTRACT_ID_ALLOWLIST` stays EMPTY: it is the mechanism for a frozen
contract id that embeds a REAL extension package name; the identity surfaces
above embed virtual scopes / object-type namespaces (not real extension dirs),
so they are neither counted by the lexeme gates nor allowlist candidates.

Known, documented residual lexer limitation: JSX TEXT is not modeled by
`lib/strip-comments.mjs` (that needs a JSX-aware parser), so a named-extension
reference appearing in JSX text AFTER a bare non-URL `//` on the same line
would be under-counted. No such case exists in the tree. There is no
epoch-recompute path: if a future JSX-aware lexer reveals references, they
must be fixed in the same PR that lands the lexer (the floor cannot rise).
That policy was exercised by the import-ban scanner itself: its legacy regex
stripper (blind after a line comment containing a literal `/*`) was replaced
by the shared lexer in the SAME PR that removed the four transport-DI edges
it had been hiding (cinatra#151 Stage 3) — every CORE-side coupling scanner
(instance-coupling, import-ban, the cover gate's hard-import scan) now runs
the shared lexer. (`extension-import-ban` — the reverse direction — still
strips comments via its own inventory tooling; its floors are PINNED EMPTY
since the cinatra#172 flip, so a stripper correction there that reveals
edges must land WITH those edges' removal in the same PR — the identical
fix-with-the-reveal policy, with no floor that can rise.)

## Pinned floors — the zero-floor end-state (cinatra#151 Stage 7 + the cinatra#172 flip)

| Gate | Pinned floor | Direction |
| --- | --- | --- |
| `core-extension-instance-coupling-ban` | **0 occurrences / 0 keys / 0 files** | PINNED EMPTY (Stage 7 flip) |
| `core-extension-import-ban` | **0 edges / 0 files** | PINNED EMPTY (Stage 3 flip, honest under the shared lexer) |
| `discovery-dispatcher-bypass-ban` | **0 files** (5 documented sanctioned readers, justified in-gate) | PINNED EMPTY (#36 flip) |
| `extension-import-ban` | **0 `@/` + 0 cross-extension + 0 sdkOnly** (allowlist EMPTY) | PINNED EMPTY (cinatra#172 flip) |
| `host-peer-value-import-ban` | **0** over all serverEntry graphs | hold at 0 |
| cover gate declarations | **requiredExtensions == systemExtensions == lock == 8** (0 hard-imported, 8 generated-required, 0 root-dep; every other extension guardedOptional/acquirable-on-demand) | equality, live-enforced |
| Root + package-level concrete connector `workspace:*` deps | **0** | hold at 0 |

The journey (for the record): the corrected epoch-2 instance-coupling
baseline started at **349 occurrences / 96 import edges**; the decoupling
phases (#27–#35) and the Plan-B lazy/guarded cutover (#7) drove it to the
166/41 flip floor (#36); the zero-floor epic (cinatra#151) emptied it —
Stage 1 nango serverEntry cutover (−15 occ, import-ban 10→0),
Stage 2 packages/llm provider adapters (−7), Stage 3 transport-DI inversion
(−4, import-ban pinned empty + shared lexer), Stage 4 packages/agents
connector edges + catalog metadata (−4, requiredExtensions floor 8 reached),
Stage 5 agent-identity decoupling (−85), Stage 6 artifact/blog/seed tail
(−20, baseline EMPTY), Stage 7 pinned the zero + the declaration equality.
`requiredExtensions` shrank 16 → 8 == `systemExtensions` along the same train
(gemini at Stage 2; openai/anthropic/drupal-mcp/wordpress-mcp at Stage 3;
crm/gmail/google-calendar at Stage 4).

The REVERSE direction (cinatra#172, stages H1–H5): `extension-import-ban`'s
`hostInternal` dimension went **16 → 12 → 8 → 4 → 0 → PINNED EMPTY** —
H1 crm ctx-port adoption + the two test re-groundings (gmail, twenty), H2 the
Drupal family (drupal-mcp service extension + the new drupal-widget-auth
service), H3 the WordPress family (wordpress-mcp connection-admin extension +
the new wordpress-content and wordpress-widget-auth services), H4 the
transport tail (new github/linkedin/youtube connection services + the
external-mcp-registry read surface), H5 the pinned-empty flip
(`crossExtension` and `sdkOnly` were already empty). All FOUR coupling
baselines are pinned empty from H5 onward.

## End-state record — how core reaches extensions now

The residual floor register is retired (nothing residual is left). The
SANCTIONED inversion-of-control paths, each with its own guard:

- **The generated manifest tree** (`GENERATED_MANIFEST_FILES`): the generator
  — driven by extension `package.json` declarations — is the ONE place
  concrete extension names appear outside `extensions/` and tests. Byte-pinned
  by the fail-closed `generate-extension-manifest.mjs --check` CI step;
  loader entries carry generator-owned `resolution` metadata
  (`required` for `cinatra.systemExtensions` members, else `guardedOptional`
  routed through the standardized degraded-result guard and proven degradable
  by the generated test). The presence-degraded build job asserts the
  regime-aware emission (system-only universe ⇒ zero guarded loaders).
- **The capability registry**: connectors/agents self-register surfaces from
  their `serverEntry` `register(ctx)` (nango-system, llm-provider-surface,
  crm-list-reader, email-sender-identities, appointment-schedules, transport
  deps, …); the host publishes per-concern `@cinatra-ai/host:*` services
  (`register-host-connector-services.ts` — names NO extension package) and
  resolves extension surfaces at call time with established fail-loud or
  degrade-to-empty semantics per consumer. The legacy
  `@cinatra-ai/host:nango-connection-storage` delegating adapter id is FULLY
  retired (Stage 3 contract removal; Stage 7 compat-shim removal — the id
  resolves to nothing; a pre-Stage-3 runtime package-store digest gets a
  capability-resolution miss at call time and must be refreshed from the
  marketplace).
- **Manifest metadata bindings**: `cinatra.fieldRenderers`, `cinatra.roles`,
  `cinatra.facadePrimitives`, `cinatra.devCliModules` — validated fail-closed
  at generation (`scripts/extensions/agent-binding-kinds.mjs` etc.), emitted
  as pure data (`agent-bindings.ts`, `artifact-floor.ts`), resolved by
  neutral host primitives (`agent-roles.ts`, `extension-roles.ts` — fail-loud
  for system-required roles, degrade for optional ones). Runtime-installed
  packages contribute renderer bindings through the installed-package
  collector (Source B); roles bind from build-time presence (documented
  limitation).
- **Presence-conditional host surfaces**: seeds
  (`scripts/seed-lib/extension-presence.mjs` — skip-with-notice, determinism
  pinned for both universes), the connectors catalog (derives
  `primitiveOverrides` from manifests), `/connectors` readiness (generated
  loader maps).

**How extensions reach host capability now (the cinatra#172 end-state — the
former "one standing non-zero floor" register entry is retired; the owner
ruled zero-floor in both directions and stages H1–H5 delivered it):** the
SANCTIONED extension→host paths, each grant- or contract-guarded:

- **`register(ctx)` host ports** (`ExtensionHostContext`,
  `packages/sdk-extensions/src/host-context.ts`): `authSession`, `jobs`,
  `nango`, `capabilities`, `mcp`, … — grant-gated by manifest
  `requestedHostPorts`.
- **Per-concern `@cinatra-ai/host:*` services** published at boot by
  `src/lib/register-host-connector-services.ts` (SDK contract types in
  `packages/sdk-extensions/src/host-connector-services-contract.ts`,
  publication asserted member-by-member by
  `src/lib/__tests__/host-connector-services-publication.test.ts`), consumed
  through each connector's `deps.ts` slot (namespaced+versioned `globalThis`
  Symbol, bound lazily and fail-loud by the serverEntry `register(ctx)`;
  SDK imports in serverEntry graphs stay type-only — held at 0 by
  `host-peer-value-import-ban`). Connectors keep STRUCTURAL local types, so
  no SDK type import is needed to compile against an older host.
- **Frozen pure-data contract ids** (queue names, config keys): inlined
  connector-local constants documented as serialization contracts (e.g. the
  `twenty-pointer-repair` job name), with the host registry
  (`BACKGROUND_JOB_NAMES`, …) staying the single authority.

## Scanner correctness (historical)

The instance-coupling scanner previously stripped comments with a regex pair
that was not lexical-context aware; the shared single-pass lexer
`scripts/audit/lib/strip-comments.mjs` fixed two failure classes that hid
real references (a `/*` inside a line comment swallowing following code; a
`//` inside a string swallowing the line). The recomputed baseline after the
fix was a one-time RISE sanctioned by bumping `SCANNER_EPOCH` 1 → 2 in the
same PR. The zero-tolerance flip (#36) FROZE the epoch at 2 and retired the
growth allowance; the zero-floor flip (cinatra#151 Stage 7) pinned the empty
baseline, so the epoch survives purely as a tamper check on the committed
baseline document.

## Reproduction

```sh
# end-state (all should pass / print the pinned floors above)
node scripts/audit/core-extension-instance-coupling-ban.mjs
node scripts/audit/core-extension-import-ban.mjs
node scripts/audit/discovery-dispatcher-bypass-ban.mjs
node scripts/audit/extension-import-ban.mjs --strict-sdk-only
node scripts/audit/host-peer-value-import-ban.mjs
node scripts/audit/identity-coupling-gate.mjs                   # identity-surface dangerous-class guard (stateless)
node scripts/audit/required-extensions-cover-host-imports.mjs   # 8 == 8 == 8
node scripts/extensions/generate-extension-manifest.mjs --check # fail-closed integrity of the exempt generated tree

# with the CI monotonic base-ref tamper checks
CORE_EXT_INSTANCE_BAN_BASE=origin/main node scripts/audit/core-extension-instance-coupling-ban.mjs
CORE_EXT_BAN_BASE=origin/main node scripts/audit/core-extension-import-ban.mjs
DISCOVERY_BYPASS_BASE=origin/main node scripts/audit/discovery-dispatcher-bypass-ban.mjs
IMPORT_BAN_BASE=origin/main node scripts/audit/extension-import-ban.mjs --strict-sdk-only

# regenerating a pinned-empty baseline REFUSES non-empty output
node scripts/audit/core-extension-instance-coupling-ban.mjs --write-baseline
node scripts/audit/core-extension-import-ban.mjs --write-baseline
node scripts/audit/extension-import-ban.mjs --write-baseline
```

The extension source tree must be cloned back first
(`node scripts/ci/sync-dev-extensions.mjs`) or the gates fail closed.
