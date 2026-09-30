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
match each other BY NAME. The owner ruled (the identity-surface ruling,
"the middle path") that the unavoidable identity references are a documented
**exempt class** (see [Identity-surface exempt class](#identity-surface-exempt-class)
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
| `vendor-token-core-gate.mjs` | VENDOR tokens in core (`src/` + `packages/`) — vendor-named file/route path segments and import specifiers, independent of any extension package lexeme | `file :: path :: token` / `file :: import :: specifier` occurrences | `vendor-token-core-gate.baseline.json` — **shrink-only residual floor** (cinatra#973, epic cinatra-ai/cinatra#978; see the dedicated section below) |
| `application-border-gate.mjs` | application code (`src/` + `packages/*/src`) written for one artifact type, agent or connector — a claimed object type id spelled in it (class 1), a module named for one domain (class 2), growth of a listed module (class 3) | `file :: type :: id` / `file :: name :: token` counts, and a per-module ceiling | `application-border-gate.baseline.json` — **shrink-only floor**, every entry naming its owner (cinatra#3821; see the dedicated section below) |
| `connector-artifact-road-gate.mjs` | a road from a module that faces connectors (the connector handler, a capability the application publishes) to a module that creates an artifact (class 6) | `capability id :: creating module` roads, plus the declaration of every published capability | `connector-artifact-road-gate.baseline.json` — **shrink-only floor**, every road naming the item that removes it (cinatra#3821; see the dedicated section below) |

`discovery-dispatcher-bypass-ban.mjs` guards the runtime-discovery dispatcher
(its documented `SANCTIONED_READERS` allowlist is "sanctioned, never counted" —
distinct from the baseline, which is pinned EMPTY since the flip — cinatra#36).
`host-peer-value-import-ban.mjs` holds every serverEntry graph at 0 host-peer
value imports (SDK peers stay type-only). `identity-coupling-gate.mjs` is the
NEW identity-surface guard — it pins extension
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
  `extensions == systemExtensions == lock` (cinatra#151 Stage 7) ON
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
   prefix-mask a longer ID past a non-alphabet character. **Holds exactly ONE
   owner-ruled entry** at the zero-floor end-state —
   `@cinatra-ai/dashboard-artifact:dashboard` (the `DASHBOARD_OBJECT_TYPE`
   persisted object-type key; owner ruling 2026-07-22, PR #1971) — and grows
   only when an owner ruling mints another.
3. Test files (`*.test.*`, `*.spec.*`, `__tests__/`, `__mocks__/`, `tests/`)
   and the `extensions/` tree itself (an extension naming itself is fine).

No facades, no inventories, no dev-name lists are exempt — they are counted
(`mechanical`) and hard-fail if they ever reappear.

## Identity-surface exempt class

The lexeme gates above pin a concrete extension package NAME / path. They do
NOT see the parallel **identity surface** — the slug / route / env-var /
capability-id strings by which a producer and a consumer match each other by
name. The owner ruled (the identity-surface ruling, "the middle path") that the unavoidable
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

The `DATA_CONTRACT_ID_ALLOWLIST` holds exactly ONE owner-ruled entry
(`@cinatra-ai/dashboard-artifact:dashboard`, the `DASHBOARD_OBJECT_TYPE`
persisted key — owner ruling 2026-07-22, PR #1971): it is
the mechanism for a frozen contract id that embeds a REAL extension package
name. The identity surfaces above embed virtual scopes / object-type namespaces
(not real extension dirs), so they are neither counted by the lexeme gates nor
allowlist candidates.

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

## Vendor-token core gate — the shrink-only residual floor (cinatra#973, epic cinatra-ai/cinatra#978)

The lexeme + identity gates above pin references to extension PACKAGES. What
none of them saw (PR #969 proved the gap) is core code that names the VENDOR
directly — a new `src/app/api/webhooks/<vendor>/` route, a new
`src/lib/<vendor>-api.ts`, a new `from "@/lib/<vendor>-api"` edge — without
ever spelling an extension package name. Epic cinatra-ai/cinatra#978's
doctrine ("core owns integration MECHANISM, never vendor CODE") makes that a
boundary violation in its own right; `vendor-token-core-gate.mjs` enforces it.

**Scan surfaces** (exactly the three the gap analysis named — arbitrary
string/JSX/prompt literals are deliberately out of scope; vendor WORDS in UI
copy are not code coupling):

1. **file paths** — filenames AND directory/route segments under `src/` +
   `packages/` (a vendor-named Next.js route dir counts for every file under it);
2. **import specifiers** — static import / export-from, side-effect imports,
   dynamic `import()`, `require()`, after the shared lexical comment stripper.

**Token set** (frozen in-gate as `VENDOR_TOKENS`): `wordpress`, `wp`,
`drupal`, `linkedin`, `github`, `youtube`, `resend`, `google`, `twenty`,
`apollo` — grounded in the epic #978 residual clusters. Tokens match path /
specifier sub-tokens exactly (camelCase-split, so `wordpressApi` counts);
tokens of five or more characters also match as a segment substring (so a
squashed `wordpressapi.ts` evasion counts). Explicit NON-members, mirroring
the epic's non-goals: `nango` (the sanctioned credential-broker MECHANISM —
the model core code is pointed AT) and the LLM-provider names
`openai`/`anthropic`/`gemini` (the `packages/llm` provider layer plus its
`/configuration` + `/setup` surfaces are core-owned model mechanism, not
connector vendor code; extension-package coupling there is still policed by
the pinned-empty lexeme gates). Growing or shrinking the token set is a
reviewed change to the gate and its tests.

**Sanctioned surfaces excluded from the scan** (the epic #978 categories
(a)–(e); each is either byte-pinned, pure identity data, or the surface that
polices/documents the boundary):

| Exclusion | Category | Why |
| --- | --- | --- |
| the generator-emitted manifest file list (`PERMANENT_EXEMPT_FILES` — explicit list, never a directory prefix) | (a) | build-generated, byte-pinned by `generate-extension-manifest.mjs --check`; a hand-added extra file under `src/lib/generated/` is still counted |
| `packages/sdk-extensions/` | (c) | the frozen ABI type-contract surface (e.g. the google-oauth-connection / nango-system wire contracts); pinned by its own gates (`sdk-public-surface-ban`, `sdk-abi-readme-gate`) |
| `packages/connectors-catalog/` | (b) | the ONE sanctioned hand-maintained slug→packageId identity catalog (see the identity-surface section) |
| `packages/agents/src/reserved-workspace-slugs.ts` | (b) | reserved-slug identity data, never logic |
| tests / mocks (`*.test.*`, `*.spec.*`, `__tests__/`, `__mocks__/`, `tests/`) and docs (`*.md`) | (d) | the surfaces that police and document the boundary |
| sanctioned import specifiers: `next/font/google`, `@google/genai` (exact), `@icons-pack/react-simple-icons/` (prefix) | — | framework font loader; the LLM-provider SDK consumed by core-owned `packages/llm` (the LLM non-goal above); brand LOGOS (presentation identity data). A vendor-named FILE next to these imports still counts |

The dev/required extension locks (`cinatra-*-extensions.lock.json`) and the
`docker/` fixtures — categories (b)/(e) — live outside the `src/` +
`packages/` scan roots and need no in-gate carve-out.

**Ratchet mechanics** (the `exdev-rename-gate` /
`host-peer-value-import-ban` shape, hardened): the committed baseline
(`vendor-token-core-gate.baseline.json`) enumerates TODAY'S residual vendor
floor — the epic #978 clusters (the vendor API-client layer and its ~15 core
import sites including the named defect
`src/lib/register-host-connector-services.ts`, the vendor-literal
routes/pages and dead `bundle.js` routes, the blog vendor lifecycles + the
two vendor HITL renderers, the `wp-drupal-contract` category-(c) residue, the
`dev-auto-setup.ts` provisioning blocks, the skills-from-GitHub cluster, the
google-oauth glue, the twenty external-MCP proxy). The floor only shrinks:

- a NEW occurrence (new key, or a grown count on an existing key) fails CI
  immediately with the doctrine pointer at epic cinatra-ai/cinatra#978;
- a REMOVED occurrence makes the baseline STALE and fails CI until
  `--write-baseline` ratchets it down (no silent headroom to re-spend);
- `--write-baseline` REFUSES growth vs the committed baseline;
- the `VENDOR_TOKEN_BASE` monotonic guard refuses a committed baseline that
  grew vs the base branch, failing CLOSED on flag-like/unresolvable refs.

As the epic waves (#974–#977, #979) evict each cluster into its owning
extension, the floor ratchets toward the sanctioned-surface set; the baseline
file is the authoritative current count.

## Application border gates — the shrink-only floors (cinatra#3821)

**The rule.** The application offers the same roads to every extension. What
an artifact holds is the work of the agent extension whose flow creates it. A
connector gives an agent its connection and its tools, and it never creates an
artifact. An artifact extension declares the type and draws it from its
content. The application gains no function for one artifact type, one agent or
one connector. The lexeme, identity and vendor gates above do not see that
line; these two gates hold it.

### What they refuse

`application-border-gate.mjs` scans application code (`src/` and every
`packages/*/src`; `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`)
with the TypeScript compiler API and refuses a new occurrence of:

1. **Class 1 (`types`)** — a string literal (or a template literal without
   substitutions) whose text equals an object type id an extension claims, or
   has the id shape `<namespace>:<local>` under a namespace a claim declares, in
   any position — for example as the type of an artifact the application
   itself creates. Key `file :: type :: id`, with its count.
2. **Class 2 (`names`)** — a module whose path carries a word of the frozen
   domain set (`appointment`, `blog`, `campaign`, `campaigns`, `cms`, `crm`,
   `email`, `icp`, `mail`, `newsletter`, `outreach`, `playbook`, `podcast`,
   `portfolio`, `prospecting`, `social`) as a whole sub-token of a directory or
   file segment (split on non-alphanumerics and camelCase, as the vendor gate
   splits). The segments read are those after `src/`; for a package, its
   directory name plus those after `packages/<name>/src/`. Key
   `file :: name :: token`, with the number of segments. The set is frozen and
   reviewed, not derived from the package names of the locks: derived words
   (`client`, `mcp`, `server`, `list`, ...) read mostly generic modules, and a
   derived set would move with every lock change, so a pin advance could turn
   `main` red with no code change. Vendor words stay the vendor gate's, so one
   path segment is counted by one gate.
3. **Class 3 (`ceilings`)** — growth of a module already on the class 1 or
   class 2 floor. Each such module carries a ceiling: its count of top-level
   value declarations (the names of top-level functions, classes and
   variables, exported or not). A count above the ceiling is refused; a count
   below it is a stale entry. A new top-level function that stores the
   published words of a CMS page in `src/lib/artifacts/cms-content-snapshot-capture.ts`
   is refused; a fix inside an existing declaration adds no name, so a listed
   module stays maintainable while its surface cannot widen.

`connector-artifact-road-gate.mjs` refuses a new **class 6 road**: from a
module that faces connectors to a module that creates an artifact.

- The connector-facing modules are `packages/extensions/src/connector-handler.ts`
  and every capability the application publishes: a
  `registerCapabilityProvider` call (or a call of a local wrapper that forwards
  its first parameter to it) in a module under `src/` whose provider identity
  is the application's own (`HOST_PROVIDER_PACKAGE`). Its capability id is
  resolved from an inline literal, a same-module constant, a member of
  `HOST_CONNECTOR_SERVICE_CAPABILITIES` or an imported SDK constant; an id the
  gate cannot resolve, and a direct call whose options are neither an object
  literal nor a constant bound to one, is a scanner error (exit 2), never a
  pass. A
  capability's roots are the modules that define its impl members, plus the
  modules its declaration names as `entries`.
- A creating module calls a builder of `src/lib/artifacts/artifact-writer-witness.ts`
  (the witness every host writer that mints an artifact emits), also through a
  module that re-exports it, or passes a claimed type id as the value of a
  `typeHint` property.
- The reach follows value-import edges only (static imports and re-exports,
  side-effect imports, literal dynamic `import()`, `require()`; `import type`
  and `export type` are skipped), resolved through `@/`, relative paths and
  workspace packages by their `exports` or `src/<subpath>`. A package root
  barrel (`packages/<name>/src/index.*`) is not traversed, and a road is at
  most six edges long: through the barrels every root reaches the whole run
  machinery, which is no truthful floor.
- **The declaration** (the `capabilities` section of the baseline) is the one
  place the gate reads whether a capability can create an artifact: every
  published id with `createsArtifact` (true or false) and, where the impl
  reaches its work through a `globalThis` slot, `entries` (the modules that
  bind the slot). A published id missing from it, a declared id no longer
  published, a `createsArtifact` that disagrees with the reach, and an impl
  that reads a `globalThis` property with no `entries` each fail. The review
  seam for staged CMS writes (`@cinatra-ai/host:cms-review`) reaches its
  capture only through such a slot, which
  `src/lib/register-cms-review-host-seam-runtime.ts` binds; no import edge
  leads there from the registration, so the declaration names it.
- When `packages/sdk-extensions/src/artifact-contract.ts` exports
  `ARTIFACT_CREATING_ROADS`, its members under the application's provider
  identity must equal the ids declared `createsArtifact: true`; while it is
  absent the OK line says `SDK roads list absent` and the declaration governs.

### The vocabulary is derived, never typed

`scripts/audit/lib/claimed-type-vocabulary.mjs` reads the well-formed
`cinatra.artifact.objectTypes[].type` claims of the extension packages the two
locks name from the materialized tree (`extensions/<scope>/<name>`, with the
produces gate's own `discoverExtensionDirs` and `readArtifactClaimIds`). It
names no extension package. An absent tree, fewer packages than
`cinatra.devExtensions` declares, a package whose manifest is unreadable or
names no package, or a tree that claims no id throws a named
error, which each gate maps to exit 2 (scanner error, never a vacuous pass).
The namespaces of the claims matter as much as the ids: five claimed
namespaces (the email artifacts pack's `@cinatra-ai/email` among them) are no
package name, so the instance-coupling ban cannot see them.

### Count once beside the display boundary gate

`artifact-ui-boundary-gate.mjs` (G1) reads a type id only in a `.tsx` module
and only in a keying position; class 1 reads every other position of every
module. Class 1 imports G1's own `classifyIdentity` and `keyingKindOf` and
skips exactly a literal G1 classifies as an object type in a keying position,
so the partition is G1's definition and cannot drift from it. Nothing on G1's
floor enters this floor, and a literal G1 counts is still refused by G1.

### Exemptions, each with its reason

| Exemption | Classes | Why |
| --- | --- | --- |
| the generator-emitted files (`PERMANENT_EXEMPT_FILES`, an explicit list) | all | generator output from the manifests, byte-pinned by `generate-extension-manifest.mjs --check`; a hand-added file under `src/lib/generated/` is still counted |
| tests and specs, `__tests__/`, `__fixtures__/`, `__mocks__/` (the test doubles), `test/` and `tests/`, stories, `.d.ts` declarations | all | the surfaces that police the boundary or declare types only |
| documents (`*.md`) | all | they document the boundary |
| the owner-ruled `DATA_CONTRACT_ID_ALLOWLIST` ids | class 1 | the one place owner rulings on such ids live; reported apart exactly as the instance-coupling ban reports them, never a second exception list |
| `SANCTIONED_MODULES`: `src/lib/org-invitation-email.ts` | class 2 | the platform's own member-invitation mail, written for no type, agent or connector; the set grows only by a reviewed change to the gate |

### How the floors move

Both floors only shrink, with the mechanics of the vendor gate:

- a new key or a grown count fails; a key whose count fell is **stale** and
  fails until `--write-baseline` ratchets the floor down;
- `--write-baseline` refuses to write a grown floor;
- the base guards (`APPLICATION_BORDER_BASE`, `CONNECTOR_ARTIFACT_ROAD_BASE`)
  fail closed on a flag-like or unresolvable reference and refuse a committed
  floor that grew against the base (no constraint when the base holds no
  floor);
- one growth of the class 1 floor is admitted, by `--write-baseline` run with
  `APPLICATION_BORDER_BASE` set and by the base guard: a new class 1 key (and
  the new ceiling its module then needs) whose file is byte-identical at the
  base reference — the code did not change, only the vocabulary did (an
  extension newly claiming an id the application already spells); a key
  already on the floor never grows this way, and a count that is not a
  non-negative integer fails;
- every entry of the application border floor names its `owner`, the
  extension that will own the code, and every road names `removedBy`, the item
  that removes it; `--write-baseline` writes a new entry as `UNASSIGNED`, and
  the check fails on an `UNASSIGNED` or empty value.

At introduction the application border floor holds 28 class 1 entries in 8
files, 85 class 2 entries in 84 files and 89 ceilings; the road floor holds
four roads (`@cinatra-ai/host:cms-review` to the CMS snapshot capture and to
the preview capture store, `@cinatra-ai/host:blog-routing` to the artifact
creation module, `@cinatra-ai/host:email-routing` to its own registering
module), and the connector handler reaches no creating module. The items that
empty the floors are filed apart. The baseline files are the authoritative
current count.

**Enforcement.** The tests of record in
`scripts/audit/__tests__/application-border-gate.test.mjs` and
`scripts/audit/__tests__/connector-artifact-road-gate.test.mjs` run each gate's
own scan and diff over the whole tree in the root suite (`pnpm test:root`), so
every pull request of the application runs them beside the sibling gates; they
fail, never skip, when the extension tree is not cloned back. A change that
adds a violation and adds its entry to the committed floor in the same pull
request stays green until the base-branch guard of the floors runs in CI,
which is a later change; the floor file's diff shows such an entry to the
reviewer.

### What they cannot see

- a type id assembled at run time or passed in a variable;
- an id outside the vocabulary, such as one the application registers under
  its own namespace (`@cinatra-ai/objects:cms-content-snapshot`);
- a module whose path holds no word of the frozen set;
- growth inside an existing declaration, a nested function, a new branch, an
  interface or a type alias;
- a road through a package root barrel, a registry or a slot that is not
  declared (a slot is looked for in the registering module only: in the impl
  it registers and the same-module functions that impl names), or a road
  longer than six edges;
- an artifact-typed row written through the generic objects write with a type
  chosen at run time (the `@cinatra-ai/host:objects-integration` capability
  hands a connector the objects provider; a run-time refusal is outside these
  gates);
- an application MCP tool a connector calls.

The connector's own side, classes 4 and 5, belongs to the conformance checker
(`scripts/extensions/lib/conformance-rules.mjs`), not to these gates: its rules
for a package of kind connector refuse a declared produced type or a claimed
object type (class 4), and connector code that calls a road that creates an
artifact (class 5). Those rules are the sibling change of cinatra#3821 and run
in each connector's repository and over the materialized tree on the
application's pull requests.

## Floors compared with the base branch (cinatra#3832)

A ratchet gate compares a live count or list with a committed floor and fails
on growth. If the floor is read only from the pull request's own checkout, the
change that adds an occurrence can add it to the floor as well and pass. The
guarded gates therefore also compare the committed floor with the copy of the
same file on the base branch; the `VENDOR_TOKEN_BASE` guard above is the
pattern. The gates below use ONE shared helper,
`scripts/audit/lib/floor-base-guard.mjs`, and each names what "growth" means
for its floor:

| Gate | Floor compared with the base | Growth (fails) | Own base variable |
| --- | --- | --- | --- |
| `scripts/extensions/self-rendering-extensions-border-gate.mjs` | `self-rendering-extensions-border.baseline.json` | a new (package, path) copy | `SELF_RENDERING_BORDER_BASE` |
| `extension-fs-import-ban.mjs` | `extension-fs-import-ban.baseline.json` | a new (extension, file) hit | `EXTENSION_FS_IMPORT_BAN_BASE` |
| `ci-pinned-tests-exist.mjs` | `package-suite-runner-exceptions.json` and `root-tier-runner-exceptions.json` | a new item in either file | `CI_PINNED_TESTS_BASE` |
| `org-archive-bypass-scan.mjs` | `org-archive-bypass-allowlist.json` | a new row or a raised count | `ORG_ARCHIVE_BYPASS_BASE` |
| `route-graph-ratchet.mjs` | `route-graph-ratchet.baseline.json` | a raised ceiling without a record that matches it; a stale, orphan or altered record | `ROUTE_GRAPH_RATCHET_BASE` (set by the workflow) |
| `required-extensions-cover-host-imports.mjs` | `cinatra.systemExtensions` in the root `package.json` (a register: see the record road below) | a new package in the set without its record | `REQUIRED_EXTENSIONS_COVER_BASE` |
| `org-write-table-sweep.mjs` | `org-write-table-sweep.baseline.json` | a new file or a raised count of raw org-axis writes | `ORG_WRITE_TABLE_SWEEP_BASE` |
| `system-writer-manifest-gate.mjs` | `system-writer-manifest.json` (a register: see the record road below) | a new manifest row (file and reference) or a raised count without its record | `SYSTEM_WRITER_MANIFEST_BASE` |
| `skill-packaging-gate.mjs` | `embeddedSkills` in `config/skill-packaging-legacy-exceptions.json` | a new name in the list of embedded skills | `SKILL_PACKAGING_BASE` |

The rules the helper holds for every gate:

- **Where the base comes from**, in this order: the gate's own variable when
  the workflow sets one (a git revision: the remote base branch on a pull
  request, the previous tip on a push); else the platform's variable for a pull
  request's base branch (`GITHUB_BASE_REF`), read as the remote branch of that
  name (`origin/main` for `main`). A job whose checkout holds the base branch
  (`fetch-depth: 0`) reads it there, and nothing is fetched.
- **A checkout of one commit**: when the base comes from the pull request's
  base branch and is not in the checkout, the helper fetches that branch
  itself, one commit deep, from the checkout's own remote `origin`
  (for the base branch `main`: `git fetch --depth=1 --no-tags origin
  +refs/heads/main:refs/floor-base-guard/main`), into a reference of its own,
  never into a branch of the checkout, and reads the floor there. The
  branch name must have the form of a branch name (letters, digits, dot, dash,
  underscore and slash; no leading dash; no `..`) before it reaches git; a name
  of another form fails the gate. One attempt with a timeout of 30 seconds, one
  more after a failure, and no other network call. The repository is public:
  the helper adds no credential and reads none. The fetch is anonymous
  whatever the checkout left in its configuration: the helper's own call
  passes an empty credential helper, an empty askpass program, an empty
  `http.extraheader` and an empty value for every address-scoped
  `http.ADDRESS.extraheader` key it finds, with `GIT_TERMINAL_PROMPT=0`, so a
  job token that a checkout stored as a header is never sent. A remote address that holds a user part is never printed; the
  remote is then named by its name only. A fetch that fails fails the gate with
  its reason. A base named by the gate's own variable is a revision the
  workflow chose, and it is never fetched. `FLOOR_BASE_FETCH=0` switches the
  fetch off, so a missing base fails closed without it; the tests that run a
  gate in the real checkout set it, so they never reach the network.
- **No pull request, no base**: on a run that is no pull request (a push to the
  default branch, a local run) and no base is named, the guard says so in one
  line and passes; the gate's own check against the tree still runs.
- **Fail closed**: on a pull request's run a base that cannot be read fails the
  gate with a line that names the reason — a flag-like or malformed reference,
  a reference that does not resolve, a floor file that is not on the base, a
  base copy that does not parse. The guard never passes in silence.
- **Shrinking passes**: a lowered count, a removed stale item or a removed
  package is never growth.
- **A route-graph ceiling rises with its record** (cinatra#3848): a raise
  passes in the pull request that carries an `absorbs` record matching it
  exactly (`from` the base's ceiling, `to` the committed one), and the gate
  prints a notice for it. A ceiling measures the graph a route reaches and
  real growth raises it, so the record with its notice makes the raise
  visible; a floor that lists faults only shrinks.
- A package added to the system set fails against the base like any other
  floor growth, so the equality `extensions == systemExtensions == lock` cannot
  grow in one pull request either.

`org-archive-bypass-scan.mjs` has no workflow step of its own: the root suite
runs it through its test ("exits 0 against the repo as checked out"), which
inherits the run's environment and so compares with the base on a pull
request's run. The tests that run a gate on a SYNTHETIC floor drop the base
variables, so a synthetic floor is never compared with the real base branch.

The org-write boundary workflow runs `org-write-table-sweep.mjs` and
`system-writer-manifest-gate.mjs`, and the skill packaging workflow runs
`skill-packaging-gate.mjs`; their checkouts take one commit, so these three
gates get their base through the fetch above. The root suite also runs
`system-writer-manifest-gate.mjs` and `skill-packaging-gate.mjs` through their
tests against the repository as checked out, with the run's environment.

Not guarded yet: the other gates that cinatra#3832 lists, which need a
workflow change or a floor moved into a file of its own.

### The record road for registers

Two guarded lists are registers of things allowed after a review, not floors
of faults: the system writers' manifest and the set of system extensions. A
row added to either passes in the pull request that carries it, WITH ITS
RECORD in the register's permits file, in the same change:

- `scripts/audit/system-writer-manifest.permits.json` for the manifest (a
  record per row, by file and reference; a raised count needs its record
  written or updated in the change);
- `scripts/audit/required-extensions-cover-host-imports.permits.json` for the
  set (a record per package name).

A record is `{ "list", "row", "reason", "pr" }`: the register's name, the exact
row, a reason that is a sentence (at least six words of three letters or more,
at least four of them different) and the number of the pull request. The gate
prints one NOTICE line for every addition it absorbs, naming the row, the
reason and the pull request. A row added without its record fails, and the
refusal names the permits file and the record's form. A record for a row the
register does not hold is an orphan and fails. A record is carried forward
unchanged while its row stands (an altered or deleted record with its row
still on the register fails), and it goes when its row goes. A permits file
that does not parse fails the gate on a pull request's run; an absent one
holds no records. The shared helper holds the reader and the rules once
(`parsePermits`, `checkPermits` in `scripts/audit/lib/floor-base-guard.mjs`).

The other guarded floors list tolerated faults (a raw write outside the
registry, an embedded skill, a forbidden import): they have no record road
and only shrink.

## Pinned floors — the zero-floor end-state (cinatra#151 Stage 7 + the cinatra#172 flip)

| Gate | Pinned floor | Direction |
| --- | --- | --- |
| `core-extension-instance-coupling-ban` | **0 occurrences / 0 keys / 0 files** | PINNED EMPTY (Stage 7 flip) |
| `core-extension-import-ban` | **0 edges / 0 files** | PINNED EMPTY (Stage 3 flip, honest under the shared lexer) |
| `discovery-dispatcher-bypass-ban` | **0 files** (5 documented sanctioned readers, justified in-gate) | PINNED EMPTY (#36 flip) |
| `extension-import-ban` | **0 `@/` + 0 cross-extension + 0 sdkOnly** (allowlist EMPTY) | PINNED EMPTY (cinatra#172 flip) |
| `host-peer-value-import-ban` | **0** over all serverEntry graphs | hold at 0 |
| cover gate declarations | **extensions == systemExtensions == lock == 8** (0 hard-imported, 8 generated-required, 0 root-dep; every other extension guardedOptional/acquirable-on-demand) | equality, live-enforced |
| Root + package-level concrete connector `workspace:*` deps | **0** | hold at 0 |

The journey (for the record): the corrected epoch-2 instance-coupling
baseline started at **349 occurrences / 96 import edges**; the decoupling
phases (#27–#35) and the Plan-B lazy/guarded cutover (#7) drove it to the
166/41 flip floor (#36); the zero-floor epic (cinatra#151) emptied it —
Stage 1 nango serverEntry cutover (−15 occ, import-ban 10→0),
Stage 2 packages/llm provider adapters (−7), Stage 3 transport-DI inversion
(−4, import-ban pinned empty + shared lexer), Stage 4 packages/agents
connector edges + catalog metadata (−4, extensions floor 8 reached),
Stage 5 agent-identity decoupling (−85), Stage 6 artifact/blog/seed tail
(−20, baseline EMPTY), Stage 7 pinned the zero + the declaration equality.
`extensions` shrank 16 → 8 == `systemExtensions` along the same train
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
node scripts/audit/vendor-token-core-gate.mjs                   # vendor-token residual floor (shrink-only, cinatra#973)
node scripts/audit/required-extensions-cover-host-imports.mjs   # 8 == 8 == 8
node scripts/extensions/generate-extension-manifest.mjs --check # fail-closed integrity of the exempt generated tree

# with the CI monotonic base-ref tamper checks
CORE_EXT_INSTANCE_BAN_BASE=origin/main node scripts/audit/core-extension-instance-coupling-ban.mjs
CORE_EXT_BAN_BASE=origin/main node scripts/audit/core-extension-import-ban.mjs
DISCOVERY_BYPASS_BASE=origin/main node scripts/audit/discovery-dispatcher-bypass-ban.mjs
IMPORT_BAN_BASE=origin/main node scripts/audit/extension-import-ban.mjs --strict-sdk-only
VENDOR_TOKEN_BASE=origin/main node scripts/audit/vendor-token-core-gate.mjs
REQUIRED_EXTENSIONS_COVER_BASE=origin/main node scripts/audit/required-extensions-cover-host-imports.mjs

# the floors compared with the base branch (cinatra#3832; on a pull request's
# run GITHUB_BASE_REF=main names the base without these variables)
SELF_RENDERING_BORDER_BASE=origin/main node scripts/extensions/self-rendering-extensions-border-gate.mjs
EXTENSION_FS_IMPORT_BAN_BASE=origin/main node scripts/audit/extension-fs-import-ban.mjs
CI_PINNED_TESTS_BASE=origin/main node scripts/audit/ci-pinned-tests-exist.mjs
ORG_ARCHIVE_BYPASS_BASE=origin/main node scripts/audit/org-archive-bypass-scan.mjs
ROUTE_GRAPH_RATCHET_BASE=origin/main node scripts/audit/route-graph-ratchet.mjs

# regenerating a pinned-empty baseline REFUSES non-empty output
node scripts/audit/core-extension-instance-coupling-ban.mjs --write-baseline
node scripts/audit/core-extension-import-ban.mjs --write-baseline
node scripts/audit/extension-import-ban.mjs --write-baseline
```

The extension source tree must be cloned back first
(`node scripts/ci/sync-dev-extensions.mjs`) or the gates fail closed.
