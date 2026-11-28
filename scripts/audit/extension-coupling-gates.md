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
| `extension-rendering-gate.mjs` | an artifact extension that claims a pinnable artifact-writable type and is not drawn — neither by its own display (a `<package>::detail` entry in the generated display map) nor by a required content-type display that serves every form its manifest declares | claiming extensions | `extension-rendering-gate.baseline.json` — **PINNED EMPTY**, BLOCKING mode since cinatra#3092 (cinatra#3871; see the dedicated section below) |
| `agent-extension-code-gate.mjs` | in a pack the product treats as an agent (kind `agent`, or a pinned tree with `cinatra/oas.json`), files that are not content (class `nonContentFiles`); in any pinned pack, `cinatra.tools` declarations (`toolDeclarations`), flow steps calling the core tool `extension_tool` (`extensionToolSteps`) and ApiNode steps whose data cannot be read (`unreadableSteps`); in an agent, skill or workflow pack, declared dependencies on a UI package (`uiDependencies`) and `cinatra.fieldRenderers` entries that carry a `component` (`rendererComponents`); in a skill, workflow or connector pack that is no agent, any `cinatra.fieldRenderers` entry (`hitlDeclarations`); in an agent, skill or workflow pack, the `.tsx` and `.jsx` files it ships (`jsxFiles`), all cinatra#4532 | the recorded items per `package` (per `package :: cinatra/<file>.json` for the steps) | `agent-extension-code-gate.baseline.json` — **shrink-only items** (cinatra#4885; see the dedicated section below) |

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
   prefix-mask a longer ID past a non-alphabet character. **Holds no entry**
   since cinatra#4849: its one entry, the dashboard twin's persisted
   object-type key (owner ruling 2026-07-22, PR #1971), went stale when core
   began reading that key from the pack's declaration. It grows only when an
   owner ruling mints an entry.
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

The `DATA_CONTRACT_ID_ALLOWLIST` holds no entry since cinatra#4849 (its one
entry, the dashboard twin's persisted key from owner ruling 2026-07-22, PR
#1971, went stale when core stopped spelling it): it is the mechanism for a
frozen contract id that embeds a REAL extension package name. The identity surfaces above embed virtual scopes / object-type namespaces
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

**Words**: the `vendor` list of the border words (see "Border words — declared
by the extensions" below); the gate names no word. Words match path /
specifier sub-tokens exactly (camelCase-split, so `wordpressApi` counts);
words of five or more characters also match as a segment substring (so a
squashed `wordpressapi.ts` evasion counts). Explicit NON-members, mirroring
the epic's non-goals: `nango` (the sanctioned credential-broker MECHANISM —
the model core code is pointed AT) and the LLM-provider names
`openai`/`anthropic`/`gemini` (the `packages/llm` provider layer plus its
`/configuration` + `/setup` surfaces are core-owned model mechanism, not
connector vendor code; extension-package coupling there is still policed by
the pinned-empty lexeme gates): no pack declares them as vendor words.

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
  grew vs the base branch, failing CLOSED on flag-like/unresolvable refs;
- one growth is admitted, by `--write-baseline` run with `VENDOR_TOKEN_BASE`
  set and by the base guard, exactly as class 1 of the application border
  gate admits one: a NEW key whose file is byte-identical at the base — the
  code did not change, only the words did (a pinned pack newly declaring a
  word core already spells). A key already on the floor never grows this way.

As the epic waves (#974–#977, #979) evict each cluster into its owning
extension, the floor ratchets toward the sanctioned-surface set; the baseline
file is the authoritative current count.

## Border words — declared by the extensions (cinatra#4848)

The vendor gate and class 2 of the application border gate find a crossing by
a word. Those words belong to the extensions, so each extension declares its
own in its manifest, and the gates read them; neither gate names a word.

- **The declaration.** `cinatra.borderWords` =
  `{ "vendor": [...], "domain": [...] }`, or two empty lists and a `reason`
  for a pack that owns no word. Each word is one lower-case token of letters
  and digits (at least two characters), not a kind word (`agent`, `connector`,
  `artifact`, `skill`, `extension`, `cinatra` and their plurals), not a host
  port name, not repeated and not in both lists. The SDK contract is
  `packages/sdk-extensions/src/border-words.ts` (`borderWordsIssues`); the
  gates read its data (word pattern, kind words, host port names) from that
  source text and mirror its rules in `scripts/audit/lib/border-words.mjs`,
  and a test runs both over the same cases.
- **What the gates read.** The union, over the packs the two locks and
  `cinatra.devExtensions` pin, of their declared words and the bridge below:
  the `vendor` list for the vendor gate, the `domain` list for class 2. A word
  declared a vendor word by one pack and a domain word by another fails.
  Completeness is by identity: every pinned package must be found under
  `extensions/` by its manifest `name` (the folder name does not matter). A
  pinned package not found, two directories naming one pinned package, an
  absent tree, an unreadable manifest or a malformed bridge is a scanner error
  (exit 2), never a pass. A directory the locks do not pin is ignored for words
  and never stands in for a missing one; a symlinked pack directory is not
  followed, so its package counts as missing. Both CI jobs (`perpetual-core`
  for the vendor gate, `gates-pnpm` for class 2) run the `clone-extensions`
  action (`sync-dev-extensions.mjs --pinned`), which materializes every
  `cinatra.devExtensions` entry, and the two locks are a subset of that set,
  so both jobs have the whole pinned set on disk and no workflow changes.
- **The bridge (temporary).** `scripts/audit/border-words-bridge.json` holds
  the words no pinned pack declares yet: at introduction the 10 vendor and 16
  domain words the gates held in their code before cinatra#4848, so the
  findings on `main` did not change (49 vendor occurrences in 37 files; 72
  class 2 entries in 71 files). It only shrinks: a word both in the bridge
  and declared by a pinned pack fails (the pull request that advances that
  pack's pin removes the word), a bridge that grew against the base
  (`VENDOR_TOKEN_BASE`, `APPLICATION_BORDER_BASE`) fails, and a word that left
  the bridge against the base fails unless a pinned pack declares it in the
  SAME list at the head. So a word leaves the bridge only into a declaration,
  never out of the words the gates read: removing it, moving it to the other
  list, emptying the bridge, or unpinning the pack that declares it in the
  same change all fail, naming the word. A deleted bridge is a scanner error,
  and an unresolvable base fails, as the other base guards do. **The bridge
  must reach empty; cinatra#4848 tracks it.**
- **A pack without the declaration** fails unless the bridge's `packages`
  list names it; a named pack is listed as a warning. The list holds the
  118 packs that were pinned without the declaration when the bridge came in,
  and it only shrinks: a list that grew against the base fails, like the word
  lists. So a newly pinned pack must declare, a renamed pack too (a new name
  is a new pin), and a pack that declared cannot drop its declaration (it is
  not in the list and cannot be added). A pack re-pinned to a new commit keeps
  its name and stays listed. A listed pack that declares (even invalidly) or
  is no longer pinned fails until the same pull request removes it from the
  list. The base's grandfathered set is this committed list, read at the base
  with `git show`, because the packs' manifests are not in git (`extensions/`
  is cloned at the head's pins); an unreadable or malformed base bridge fails.
  Without a base variable (a local run) the list is enforced as committed and
  only its growth goes unchecked, as for the word lists. An invalid
  declaration fails whether or not the pack is listed.
- **A pin advance that adds a word** can find a module core already holds; the
  word-born admission (a new key whose file is byte-identical at the base,
  above and below) lets that pull request record it on the floor with its
  owner instead of turning `main` red.

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
2. **Class 2 (`names`)** — a module whose path carries a domain word (the
   `domain` list of the border words, see "Border words — declared by the
   extensions" below; the gate names no word) as a whole sub-token of a
   directory or file segment (split on non-alphanumerics and camelCase, as the
   vendor gate splits). The segments read are those after `src/`; for a
   package, its directory name plus those after `packages/<name>/src/`. Key
   `file :: name :: token`, with the number of segments. The words are not
   derived from the package names of the locks: such words (`client`, `mcp`,
   `server`, `list`, ...) read mostly generic modules and miss words no
   package name holds. A word is in one list only, so one path segment is
   counted by one gate.
3. **Class 3 (`ceilings`)** — growth of a module already on the class 1 or
   class 2 floor. Each such module carries a ceiling: its count of top-level
   value declarations (the names of top-level functions, classes and
   variables, exported or not). A count above the ceiling is refused; a count
   below it is a stale entry. A new top-level function in
   `src/lib/artifacts/page-capture-policy.ts` is refused; a fix inside
   an existing declaration adds no name, so a listed module stays maintainable
   while its surface cannot widen.

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
  that reads a `globalThis` property with no `entries` each fail.
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
- one growth of the class 1 and class 2 floors is admitted, by
  `--write-baseline` run with `APPLICATION_BORDER_BASE` set and by the base
  guard: a new class 1 or class 2 key (and the new ceiling its module then
  needs) whose file is byte-identical at the base reference — the code did not
  change, only the vocabulary did (an extension newly claiming an id, or newly
  declaring a domain word, the application already spells); a key already on
  the floor never grows this way, and a count that is not a non-negative
  integer fails;
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
- a module whose path holds no border word;
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

## The rendering gate — blocking mode (cinatra#3871, flipped by cinatra#3092)

`extension-rendering-gate.mjs` is the rendering gate of cinatra#3036's
acceptance row 2. Its rule: "The rendering gate: every kind of work draws
itself, the binary base included, whose display is the download card."

**The unit is the extension.** A CLAIMING extension is an artifact extension of
the materialized tree (a directory named `*-artifact` or `*-artifacts` at the
root of `extensions/` or one vendor level below it, whose manifest says
`cinatra.kind === "artifact"`) that declares at least one artifact-writable
claim in `cinatra.artifact.objectTypes[]`: a claim with a well-formed type id
that is either self-namespaced (the bridge registers it as an artifact type) or
declares `dispositions.projection === "artifact-safe"` (a claim-backed host
type), and that the host may pin (see "Never a review target" below). A
claiming extension that is not drawn is a finding. It is drawn in one
of two ways, read in this order. By its own display: the build map's entry
`<package>::detail` in `GENERATED_ARTIFACT_RENDERERS`
(`src/lib/generated/artifact-renderers.ts`), read with the floor gate's own
fail-closed reader; the build map, never a manifest's `ui` block, is the
authority. Or by a content-type display (cinatra#3092): the extension's
`cinatra.artifact.accepts` declares at least one form, names no key the SDK's
contract does not name (`file`, `connectorRef`, `dashboard`), and every
declared form is served — the form is in the application's preview-inline MIME
allowlist (`src/lib/artifacts/artifact-read.ts`) and a build-map entry of
`resolution: "required"` in the `detail` slot declares a representation that
matches it exactly or by type wildcard, which is what the runtime binds as a
system representation provider for every organization. The report prints each
such extension on a `drawn by a content-type display` line with every form and
the display that serves it. The gate reads the allowlist, the dashboard MIME
and the build map through the floor gate's own readers, and names no
extension and no type in code.

**Outside the gate by construction.** An artifact extension that declares no
writable claim (no `objectTypes`, or only malformed claims or claims of
projection `none` on a foreign namespace) is printed on every run and never
counted: the chart extension claims no type and is shown outside the gate
(cinatra#3092, row 7).

**Never a review target** (cinatra#3092 item 1). A writable claim whose
`dispositions.pinnable` is `false` is never pinned, so no review can land on
it, on its own display or on the fallback. Such a claim does not make its
extension claiming: an extension whose every writable claim is non-pinnable is
printed as `outside the gate by construction: <package> — never a review
target (not pinnable)`. An extension with at least one pinnable writable claim
stays claiming, and its finding names only the pinnable types. The rule is
read from the manifest; the gate names no extension, so it is not an exception
list. Only the boolean `false` takes a claim out. The pointer extension, whose
one claim is `pinnable: false` and which draws the generic floor by design, is
outside the gate by this rule.

**Nothing is counted twice.** `host-display-floor-gate.mjs` counts the
application's own displays and reads no extension tree.
`artifact-review-floor-gate.mjs` counts artifact TYPES whose review lands on
the metadata floor. An extension whose every declared form is drawn by a
required content-type display is drawn and off this gate's deficit; a form
drawn only by the host's handler, a catch-all (`*/*`), an optional
(`guardedOptional`) display, another slot or the generic fallback is not, and
its extension stays in this gate's deficit. The two gates report different
units side by side.

**The mode is blocking** (`GATE_MODE = "blocking"`). Every live finding fails,
whether the floor holds it or not, and every floor entry that no longer
applies fails. A floor that grew against the base, an unreadable base on a pull
request, and a scanner error fail as well. Exit codes: 0 clean; 1 a live
finding, a stale floor entry, a grown floor or an unreadable base on a pull
request's run; 2 a scanner error (no artifact extension, a partial fleet
against the two clone-back locks, an unreadable manifest, an unparseable build
map, an absent or unparseable allowlist or dashboard MIME source, an absent or
unreadable floor file).

**The flip** is cinatra#3092 (item 1: every pinnable artifact-writable
claiming type resolves a display its own extension owns, and no review can land
on the fallback, with no exception list): one constant,
`GATE_MODE = "blocking"`, the never-a-review-target rule above, and an empty
floor. The dashboard extension left the floor when it shipped its own detail
display; the pointer extension left it by the rule. There is no exception
list.

**The introducing rule.** The floor is compared with the base branch through
the shared helper below. The change that introduces the gate has a base that
holds neither `extension-rendering-gate.baseline.json` nor
`extension-rendering-gate.mjs`; that one case passes with one line saying so.
A base that holds the gate script but not its floor fails closed.

**How the floor moves.** The floor is empty and only shrinks, so it stays
empty: a new entry fails against the base branch, and in blocking mode a live
finding fails whatever the floor holds. The gate's own writer
(`node scripts/audit/extension-rendering-gate.mjs --write-baseline`) removes
entries that no longer apply and never adds one; it emptied the floor at the
flip. A test of record pins the checked-in floor as empty.

## Core tests and fixtures that name a pinned pack (cinatra#4853)

**Limits first.** `core-pack-pin-gate.mjs` is a LEXICAL check: it reads
single strings and does not understand what code does with them. It does not
see:

- a name or path that code assembles from separate strings
  (`path.join(ROOT, "extensions", "scope", "name")`, `"@scope/" + name`,
  a name split across two JSON strings): segments joined by code are out of
  scope;
- a pack reached through a helper outside the test locations (a module under
  `src/` that a test calls);
- Python tests (`docker/wayflow/tests/*.py` and every other `*.py` file);
- YAML fixtures.

These remain open in cinatra#4853, which stays open after this check lands.

**The rule.** The files are every git-tracked TypeScript/JavaScript test file
and JSON fixture under `src/`, `packages/` or `docker/` that lies in a test or
fixture directory (`__tests__`, `__fixtures__`, `__mocks__`, `tests`, `test`,
`fixtures`) or is named `*.test.*`, `*.spec.*` or `*.fixture.*`, as
`git ls-files` lists them. A test file is read with the TypeScript parser only
to list its string literals and the cooked text of its template parts
(comments are not read); a JSON fixture is read parsed, every string value and
every key, after its escapes decode. A string is a finding when it CONTAINS,
without case and at a token boundary (no letter, digit, `.`, `_` or `-` before
it; none after it, a `.` only when a name character follows), one of: a pinned
pack's package name `@scope/name`; its tree path `extensions/scope/name` with
`/` or `\` separators; or 7 or more leading hex digits of a pinned commit
(`resolvedSha`). The pinned packs are the rows of the two extension locks. One
substring test per string replaces every earlier special case: a sub-path, a
template, a test title, a module mock and a flow fixture's package name or pin
are all a string that contains the name. The one exemption is structural: the
module specifier of an `import type` / `export type` declaration and of an
`import("...")` type. A tracked symbolic link is a finding by itself (a linked
fixture cannot be judged; it is never followed). A test file or a JSON fixture
that does not parse fails the check (exit 2), as does a missing lock and a
listed file that is missing on disk. The names come from `git ls-files -z`
(each NUL-delimited entry is one path, nothing is parsed); a symbolic link is
decided on the working file (`lstat`). A file name that holds a control
character (a code point below 0x20, or 0x7f, a newline included) is a finding by
itself, because such a name cannot be judged safely; its content is still read
and judged like any other file's.

**The list.** `core-pack-pin-gate.baseline.json` holds, per file, the count of
findings per pinned package (no positions, so moving lines does not change
it). A count above the list fails, so a new mention in a listed file fails; a
count below it fails until `--write-baseline` lowers it. The writer only
shrinks: each count becomes the least of the live count, the committed list's
and, when a base is named, the base list's; a live count above that is refused
and the run exits 1. A list that is missing, unreadable, JSON `null` or
malformed is refused, never read as empty; the one exception is the
introducing change (the base holds neither the list nor the check), whose live
counts seed it. The list is compared with the base branch through
`lib/floor-base-guard.mjs` (`CORE_PACK_PIN_BASE`, else `GITHUB_BASE_REF`): a
raised count or a new entry fails. It runs as the test of record in
`__tests__/core-pack-pin-gate.test.mjs`, inside the root suite of the job
"Perpetual core invariants".

## A declared use of another pack's tool needs a declared dependency (cinatra#4874)

A pack says which host tools (MCP primitives) it uses in
`package.json#cinatra.consumes`. When another pack registers such a tool,
installing the consumer does not install the tool's owner unless the
consumer also declares that owner in `cinatra.dependencies`. The rule is a
finding class of `scripts/audit/extension-produces-deps-gate.mjs` (CI: job
`perpetual-core`, step "Produced-artifact dependency gate", with its tests in
the next step; no own workflow step). The gate's code names no pack and no
tool; a test of record checks that no string in it is a tool of the inventory
or a package name.

| Reading | Where it comes from |
| --- | --- |
| A pack USES a tool | each entry `{ primitive, requirement }` of `cinatra.consumes` in the pack's `package.json`, read as `parseConsumedPrimitives` (`packages/sdk-extensions/src/consumes.ts`) reads it: `primitive` a non-empty string, `requirement` `required` or `optional`, each tool once. Nothing is read from `cinatra/oas.json` and nothing from code files |
| The tool's OWNER | the row of the generated authz inventory (`src/lib/authz/__generated__/inventory.json`) for the tool: a registering file under `extensions/<scope>/<pack>/` belongs to that pack (its `package.json` name), any other file is core (a tool that core registers on behalf of a pack counts as core's) |
| The DECLARED dependency | the first entry of the consumer's `cinatra.dependencies` whose `packageName` is the owner, judged as `validateDependencyDeclarations` (`packages/extensions/src/dependency-declaration-validator.ts`) judges it: a REQUIRED use needs an install-blocking edge (required and not peer, `isInstallBlockingEdge` in `packages/extensions/src/dependency-closure.ts`); an OPTIONAL use accepts any declared edge. The gate mirrors the rule (a plain `.mjs` cannot load the TypeScript package), and a drift test reads the sources |

The rule judges declared uses only. A tool that a pack uses in a flow or in
code but does NOT declare in `cinatra.consumes` is outside it. Whether every
used tool is declared is the business of the product's own validator and of
the run-time check tracked in cinatra#4894; that is the remaining part of
cinatra#4874, which stays open after this rule merges.

A use of the pack's own tool or of a core tool is no finding. A tool with no
inventory row cannot be judged: the use is printed as "owner not recorded" on
every run, does not fail and is not listed (completing the inventory is
tracked in cinatra#4895). An inventory row that names two owners, or a file
under `extensions/` in no pack of the synced tree, is a contradiction and
fails the gate (never listed). A `consumes` entry the rule cannot read (a
missing or unknown `requirement`, a tool declared twice), a manifest that does
not parse or a missing inventory fails too.

The class `undeclaredToolOwnerDeps`, listed in
`extension-produces-deps-gate.baseline.json` as `{ consumer: { tool: reason } }`:
the owner is another pack, and it is not in the consumer's
`cinatra.dependencies`, or it is there as an optional or peer edge while the
use is required (the validator's `REQUIREMENT_MISMATCH`). Every map the rule
keys by a name from data is a `Map` or an object without a prototype, so a
tool named `constructor` or `__proto__` is a finding like any other.

The list holds today's findings, each with its reason. A NEW finding fails,
a STALE entry (no longer found) fails, an entry without a reason fails, and
the class is never removed (an empty class is written `{}`). The list may only
shrink against the base branch: the shared floor base guard compares it with
the copy on the base (own variable `EXTENSION_PRODUCES_DEPS_BASE`). A class
absent from the base copy is the one-time seed of the change that introduces
it. An entry leaves when the consumer's repository declares the owner (or
stops declaring the tool) and its pin is bumped.

Seeded on 2026-11-26 at the pins of both extension locks: 31 declared tool
uses, 3 `undeclaredToolOwnerDeps` (`list-curator-agent` declares
`crm_account_get`, `crm_list_create` and `crm_list_member_add` as required in
its `cinatra.consumes`; the inventory records them for the CRM connector,
which the agent does not declare). 4 declared uses are printed as "owner not
recorded" (`artifact_content_read`, `email_outreach_send_initial_start`,
`email_outreach_send_initial_status`).

The owner is where the tool is registered, not which pack it needs at run
time. Some tools are registered by core but work only when a pack is
installed (for example the blog publish facades that core's blog code
registers and the LinkedIn or WordPress connector backs). This rule counts
them as core's and does not judge their use. The product records those
backing packs in the ownership registry of the private engineering
repository, which the central declared-vs-used closure gate reads; that
registry is private by design and is not restated here. No pack at the
pinned shas declares a use of such a facade today, and core's blog facades
are being removed (cinatra#4862 to cinatra#4864).

What it cannot see: a tool used but not declared in `cinatra.consumes`
(cinatra#4894); a tool core registers on behalf of a pack (above); the owner of a tool the inventory has no row for (until
cinatra#4895); a pack outside both extension locks.

## Agent extensions ship no program code (cinatra#4885)

**Limits, first.** The check RECORDS ITEMS; it does not judge what a file does. A
new file of a content kind (a `.json` or a `.md`) is not counted even if
something executes it. Code inside a connector, code in a skill extension
and code in core are out of its scope.

Owner: "functionality that should be done by agents has been built as code,
which totally goes against the whole purpose of Cinatra." and "Of course,
skills could also include scripts and here code is ok." A skill, with its
scripts, is its own extension of kind `skill` that the agent depends on: core
refuses a skill inside a non-skill extension (`validateNonSkillExtensionPackage`
in `scripts/audit/_lib/skill-packaging-verdict.mjs`, reason
`skill-md-in-non-skill-package`, in `skill-packaging-gate.mjs`, at store
install and at publish). So an agent extension ships no program code at all,
and a file under a `skills/` folder of an agent pack counts like any other.

`scripts/audit/agent-extension-code-gate.mjs` runs in job `perpetual-core`
of `.github/workflows/build-image.yml` directly after the companion
repositories are cloned and BEFORE `pnpm install`, followed by its
`node --test` step: an install can run lifecycle scripts of companion
packages, and the check imports only node built-ins and files of this
repository (its own library, and `scripts/extensions/conformance-gate.mjs` for
class 8, which imports node built-ins only). It needs no judgement about a
file: no folder reading but `.git`, and no "build" or "bin" reading; only class 8
reads what a pack ships, by the manifest `files` list. It classifies nothing
beyond one closed content rule, one test-file name rule and one agent rule, and records items.

**The universe** is the pinned extensions: every `packageName` of both
extension locks plus every key of `cinatra.devExtensions`. **Each pack is
read from its pinned commit**, never from the working tree or the index: the
commit is the lock's `resolvedSha` (a `cinatra.devExtensions` key that no lock
pins is a scanner error); the checkout is `extensions/<scope>/<name>`, a git
repository of its own (CI materialises it with `clone-extensions`, i.e.
`sync-dev-extensions.mjs --pinned --shallow`: depth 1, detached at the pin);
the file list is `git ls-tree -r --full-tree <sha>`; the manifest and the
flow files are read with `git cat-file blob <sha>:<path>`. Git runs with no
replace refs, no lazy fetch and no `GIT_*` variable of the caller. A pack
that is not checked out, a directory that is not its own git checkout, a
checkout that lacks the pinned commit, a manifest at that commit naming
another package, a lock, manifest or `cinatra/*.json` file that is not a
regular file or does not parse, and a pack whose `cinatra.kind` cannot be
read are scanner errors (exit 2), never a pass. Classes 2 to 4 apply to every
pinned pack. Class 1 applies to every pack the product treats as an agent
(the constant `AGENT_DEFINITION_PATHS`): its manifest says kind `agent`, OR
its pinned tree holds an entry at (or below) `cinatra/oas.json`, the one
definition file the product's discovery reads at a pack root
`extensions/<scope>/<name>`: `collectDefinitions` in
`src/lib/git-native-agent-ingest.ts` and the production seed
`scripts/extensions/build-required-oas-seed.mjs` (cinatra#4920). The old
`cinatra/agent.json` and `agent.json` (`OLD_DEFINITION_PATHS`) are reported by
the product and not loaded: a pinned pack that holds one of them and no
`cinatra/oas.json` fails the gate (exit 1, also for `--write-baseline` and
`--seed`) with the file to move to `cinatra/oas.json`; `--report` lists it.
Stated limit: a pack that is not of kind `agent` and holds its flow under any
other name is not judged as an agent. The
ingest's two fallback layouts lie one level higher, outside any pack root. A
test reads both source files and fails when their condition changes. So a
connector, artifact or skill pack that adds a flow is judged as an agent; its
program files are recorded like an agent's (the list records them; the
connector's code is not judged here).

**The eight classes**, each a set of items that may only shrink:

1. `nonContentFiles` (per pack) — every entry of the pinned commit's tree,
   EXCEPT content by this closed rule (the constant `CONTENT`): a file whose
   extension is one of `.json .md .txt .yaml .yml .svg .png .jpg .jpeg .gif
   .webp .ico .csv`, whose exact name is `LICENSE`, `NOTICE`, `.gitignore`,
   `.gitattributes`, `.npmignore` or `.editorconfig`, or that lies under the
   pack's top-level `.github/` (the CI of the pack's own repository).

   A symbolic link (mode 120000) or a gitlink (160000) counts even with a content
   extension, unless its base name is a test name (below).
   Everything else counts: source of any language, extension-less files,
   files under a `skills/` folder, `.npmrc`, config scripts, vendored check
   scripts, helpers and fixtures, and any file under a `test/`, `build`, `dist`
   or `out` folder: the product loads files from any folder of the pack (a
   tool module under `cinatra/tools/test/`, source the host bundles from a
   `build/` folder), so no folder name decides.

   Two things leave a file out. A file under a folder named `.git`
   (`isSkippedDir`) is never consumed source (a git tree holds none). A
   committed `node_modules` is counted: the product requires every runtime
   dependency to be bundled in the package and accepts it
   (`src/lib/extension-package-store-core.ts`), so a bundled dependency is
   code the agent ships. The listing is the pinned commit's tree (`git
   ls-tree`), so an installed but untracked `node_modules` on a disk is never
   seen. A file whose BASE NAME is
   `*.test.<ext>` or `*.spec.<ext>` (`isTestFile`) is a test file; a link named
   so is left out too. Stated limit: runtime code that is named `*.test.*` or
   `*.spec.*` on purpose is not counted; the check records items and does not
   judge what a file does.
2. `toolDeclarations` (per pack) — every value of `cinatra.tools`, whether
   the product (`parseDeclaredTools` in
   `packages/sdk-extensions/src/manifest.ts`) accepts it or not; only an
   absent or `null` value declares nothing. Items: a name in the product's
   vocabulary seen first; `cinatra.tools[<i>]` for any other entry;
   `cinatra.tools.<key>` per key of an object map; `cinatra.tools` for any
   other value.
3. `extensionToolSteps` (per pack and `cinatra/*.json` file) — one walk over
   the parsed file visits every object once; an object counts when its own
   `data` (an object, or a string that parses to one) has `tool` equal to
   `extension_tool`. No URL, node kind or id is read for the count.
4. `unreadableSteps` (per pack and file) — an object of ApiNode shape (`url`,
   `http_method` or `component_type: "ApiNode"`) whose `data` is a string that
   does not parse as JSON (fully or partly templated, such as
   `"{{ payload }}"`), or whose `tool` is not a plain string or holds `{{`.
   Recorded, not failed outright; the count only goes down.
5. `uiDependencies` (per pack, cinatra#4532) — an agent, a skill or a
   workflow has no screen of its own: core draws an agent's HITL step with its
   generic gate from the `cinatra.fieldRenderers` declaration. So such a pack
   declares no dependency on `react`, `react-dom`, `@cinatra-ai/sdk-ui` or
   `@cinatra-ai/design-primitives` (the constant `UI_PACKAGES`). The class
   applies to a pack the agent rule above judges an agent, and to a pack whose
   manifest kind (`cinatra.kind`, as the product reads it) is `skill` or
   `workflow` (the legacy kind the product's record still carries). The rule
   is about the DECLARATION, not about where a package ends up: a bundler can
   inline any declared package into what is published
   (`scripts/extensions/build-server-entry.mjs` inlines react reached from a
   TypeScript `cinatra.serverEntry`, and the run time imports that packed
   entry), so a development-only declaration counts too; such a pack has no
   good reason to declare a UI package even for its tests. Read, in the
   manifest at the pinned commit (the packed `package.json`): a key of
   `dependencies`, `peerDependencies`, `optionalDependencies` (the fields
   `sdkOnlyManifestDeps` and `hostServedManifestDeps` in
   `scripts/extensions/inventory.mjs` read; a test fails when they change) and
   `devDependencies`; the target of an `npm:<name>` or `workspace:<name>@`
   alias value in any of those four; a name in `bundledDependencies` or
   `bundleDependencies` (`true` bundles the declared dependencies, already
   read). Not read: `overrides` and `resolutions`, which pin versions of what
   something else declares and declare no dependency of the package. An
   absent or `null` field declares nothing; a dependency field that is not an
   object, or a bundle field that is neither a boolean nor a list of names, is
   a scanner error. Items: `<field>: <name>`, or `<field>: <key> -> <name>`
   for an alias. Stated limit: a UI package reached under another name than
   its own or an alias above (a `file:` or `link:` path, a git URL, a
   tarball, a fork with another name) is not counted; the manifest does not
   say which package such a value holds.
   On the day it landed (pins of main at c2662f78b): 10 items in 4 agent
   packs, 7 `peerDependencies` and 3 `devDependencies`; no skill pack
   declares one, and no workflow pack is pinned.
6. `rendererComponents` (per pack, cinatra#4532) — an agent, a skill or a
   workflow declares no `cinatra.fieldRenderers` entry that carries a
   `component`. It is judged for the same packs as class 5. Read, in the
   manifest at the pinned commit, as the product reads it
   (`validateFieldRendererDeclarations` in
   `scripts/extensions/agent-binding-kinds.mjs`): `cinatra.fieldRenderers` is
   an array of plain objects; an entry counts when it carries the key
   `component` (the product's own test is `component !== undefined`; a value
   it rejects is counted too). Absent or `null` declares nothing; a value that
   is not an array, or an entry that is not an object, is a scanner error that
   names the package. Items: `fieldRenderers: <id>` (`[<position>]` for an
   entry without a string id). On the day it landed (pins of main at
   ab9a95143): 4 items in 3 agent packs. A list may omit the class as it may
   omit class 5 (`LATER_CLASSES`).
7. `hitlDeclarations` (per pack, cinatra#4532) — a HITL step declaration
   (`cinatra.fieldRenderers`) belongs to an agent, and to an artifact pack
   that hosts the HITL renderers of agents (ruling 133-1: the artifact kind
   admits the key in `packages/sdk-extensions/src/artifact-contract.ts`, and
   the generator reads it from every record, whatever its kind). A pinned
   pack of kind `skill`, `workflow` or `connector` declares no entry at all,
   with or without a `component`. The kind is decided as for the classes
   above: the manifest kind, and the agent rule, so a pack the agent rule
   judges an agent (a connector whose pinned tree holds `cinatra/oas.json`
   too) and an artifact pack are not read by this class. Read as class 6
   reads it: an array of plain objects; absent, `null` and an empty array
   declare nothing. **Both classes apply to a skill or workflow pack:** an
   entry there that carries a `component` is one item of class 6 and one item
   of class 7, and each class is recorded and shrunk on its own. A connector's
   entry is an item of class 7 only, as class 6 does not read connectors. The
   shape is read for EVERY pinned pack, whatever its kind: a value that is not
   an array, or an entry that is not a plain object, is a scanner error that
   names the package. Items as in class 6. Stated limit: a screen shipped
   without a `fieldRenderers` declaration is not seen, and a pack of any other
   kind is not judged for its entries. On the day it landed (pins of main at 9d2bd5f29): 0 items; the
   class is recorded empty, so any entry that appears fails. A list may omit
   the class as it may omit class 5 (`LATER_CLASSES`).
8. `jsxFiles` (per pack, cinatra#4532) — an agent, a skill or a workflow
   ships no `.tsx` or `.jsx` file: it has no screen of its own. It is judged
   for the same packs as class 5. Read, in the file list of the pinned commit
   (`git ls-tree`, a link too): a path that ends in `.tsx` or `.jsx` (any case)
   and is not a test file by the base-name rule of class 1 (`isTestFile`: a
   `*.test.<ext>` or `*.spec.<ext>` name; no folder name decides, so a helper
   under `tests/` counts when it ships). Items: the path inside the pack.
   **What ships** is the manifest `files` list, read by `isInScope` of
   `scripts/extensions/conformance-gate.mjs`, the reading that gate applies to
   the published scope (its fallback for npm's packlist, the declared logo and
   the declared renderer entries): an entry names a file or a folder, a `!`
   entry leaves out. A pack with no usable list (absent, `null` or `[]`) is
   read by all its tracked files, as npm packs every file it does not ignore.
   `npm pack --dry-run`, the conformance gate's first choice, needs a
   materialised tree, and this check reads git objects only. The list is read
   only when a file would count, and then it fails closed: a value that is not
   a list of strings, or an entry that is a pattern (`*`, `?`, `[`, `{`, `(`)
   or begins with `./` or `/`, is a scanner error that names the pack, because
   `isInScope` matches plain paths and cannot place such an entry. On the day
   it landed (pins of main at bea855b35): 5 items in 2 agent packs, 3 in
   `blog-linkedin-publish-agent` (two of them primitive copies under
   `src/components/ui/`) and 2 in `list-curator-agent`; no skill pack ships
   one and no workflow pack is pinned; for all 58 agent and skill packs the
   `files` reading and `npm pack --dry-run` name the same files. **Overlap:**
   class 1 reads every non-test file of an agent, a `.tsx` included, so a
   screen of an agent is an item of class 1 and of this class, and each class
   is recorded and shrunk on its own; this class adds the skill and workflow
   packs, which class 1 does not read, and leaves out what an agent does not
   ship (a `.tsx` under a folder outside its `files` list). Stated limits: a
   screen written in a `.ts` or `.js` file (a renderer built with
   `createElement`), a file that npm packs because `main` or `bin` names it
   outside `files`, and a screen that no file name shows are not seen. A list
   may omit the class as it may omit class 5 (`LATER_CLASSES`).

**The recorded list** (`agent-extension-code-gate.baseline.json`) holds per
class `key -> { count, items }`. The ITEMS are compared, as a multiset:
class 1 the sorted non-content paths of the pack, class 2 the declaration keys
above, classes 3 and 4 per pack and flow file the `id -> module` lines and the
`id: reason` lines (duplicates kept). The head's items must be contained in
the recorded ones: an item the list does not hold fails whatever the count,
so a same-count substitution (one test file removed, one runtime file added;
one step replaced by another) fails, and so does a second copy of a recorded
step. A recorded item that is gone fails as stale until
`node scripts/audit/agent-extension-code-gate.mjs --write-baseline` removes
it. `count` is the number of items, kept as information (a list whose
`count` differs from its items is malformed). That writer refuses a missing
or malformed list and any item the list does not hold; `--seed` writes the
first list only when none exists. A class added after the list was seeded
(`LATER_CLASSES`: `uiDependencies`, `rendererComponents`, `hitlDeclarations`, `jsxFiles`) may be absent from a list, which then
holds none of its items; a base list that does not carry such a class seeds
it once, in the change that adds the class, and a head list that drops it
after it reached the base fails as a removed class. The list is compared with its copy on the
base branch through the shared floor base guard by the same items: an item
the base does not hold, or a removed class, fails. The change that introduces
the gate has a base holding neither the list nor the script; that one case
seeds. `--report` prints every count and item.

On the day it landed (pins of main at 12cf13c9f): 254 `nonContentFiles` in
30 agent packs, 12 `toolDeclarations` in 9 manifests, 17
`extensionToolSteps` in 9 flows, 0 `unreadableSteps`. Of the 254: 12 tool
modules under `cinatra/tools/` and 10 runtime files under `src/` (the 22 of
the issue), 167 files under test folders (`test/`, `tests/`,
`src/__tests__/`), 30 vendored `extension-kind-gate.mjs`, 30
`.npmrc`, 3 `vitest.config.ts` and 2 other check scripts. No agent pack's
pinned tree has a `skills/` folder, so counting such files changed none of
these numbers. The agent rule (kind `agent`, or a pinned tree with
`cinatra/oas.json`; then also `cinatra/agent.json`) adds no pack on these pins: every
pinned pack with such a file is of kind `agent` (117 pinned packs: 30 agent,
30 connector, 30 artifact, 27 skill), so the 254 files stay. The test-file name rule then leaves out the `*.test.*`
and `*.spec.*` files: the list holds 95.

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
| `extension-rendering-gate.mjs` | `extension-rendering-gate.baseline.json` | a new extension in the floor | `EXTENSION_RENDERING_GATE_BASE` |
| `agent-extension-code-gate.mjs` | `agent-extension-code-gate.baseline.json` | an item the base does not hold in any class (as a multiset), or a class removed | `AGENT_EXTENSION_CODE_BASE` |
| `extension-produces-deps-gate.mjs` (tool-owner class only) | `extension-produces-deps-gate.baseline.json` | a new (consumer, tool) entry in a class the base holds; a class absent from the base is the one-time seed | `EXTENSION_PRODUCES_DEPS_BASE` (set by the workflow) |

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
- A package added to the system set passes only with its record in the same
  pull request (the record road below); without it, it fails against the base.
  The equality `extensions == systemExtensions == lock` is still checked on the
  tree.

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

**Step-screen kinds named after a pack (cinatra#4852).** The core/extension
border gate (`scripts/ci/core-extension-border-gate.mjs`, step "Core/extension
border — base guard" of `gates-pnpm`) has the rule `pack-step-kind-in-core`: a
key of a step-screen kind table in product code (found by its shape,
`const <NAME>KIND_TABLE = { ... }`) may not carry a pack's word run. The runs
come from the two locks: every run of two or more consecutive words of a
pack's stem (the package name without scope and role suffix), plus the one
word of a one-word agent or connector stem and a connector's first word (its
vendor word); a one-word artifact or skill stem is a type word and does not
count. The gate reads each file with the TypeScript parser and judges only
the table's declaration: a key it cannot read to a literal name (a computed
key other than a string or a same-file `const` string, a spread, a method or
accessor, a non-object or missing initializer) and a file that does not parse
are findings too. The table must be declared in the frozen shape, `const` and
typed `Readonly<...>` (`const RENDERER_KIND_TABLE: Readonly<Record<...>> =
{ ... }`), so that `TABLE[k] = v`, `TABLE.k = v` and `delete TABLE[k]` are
compile errors under the repository's `tsc`; a table in any other shape is a
finding. The gate does not follow the table after its declaration. Code that
defeats the typing on purpose (a cast to `any` or a mutable type, reflection
such as `Object.assign` or `Object.defineProperty`) is outside the rule, and
`Readonly` is shallow: it holds the keys, not the fields of an entry.
Each finding names the pinned package(s) whose words it carries
(`gmail-sender (@cinatra-ai/gmail-connector)`), so the ledger keeps such a
pack in the universe after it leaves the locks and the row stays until the
kind is gone. A tree with no kind table fails closed. Today's kinds are held in the
gate's ledger, each naming the issue that removes it; the ledger's `rules`
list names the rules it ratchets, a rule missing from the base's list is
seeded once in the pull request that adds it, and a listed rule never gains an
entry against the base. The rule set is append-only: every rule the base
ratchets (its ledger's list, or for an older ledger the base copy of the gate
script) must still be in the head's `KNOWN_RULES` and the head ledger's list,
or the base guard fails and names it; renaming a rule (dropping its rows and
seeding them under the new name) would otherwise reset its floor. A rule is
retired only by a change to the guard itself. A listed rule whose rows all
leave is a full shrink and stays listed, so it can never gain a row again;
removing its scanner while keeping the id is a change to the gate's code,
which the ledger ratchet does not judge. The rule reads names only: a pack-specific kind whose
words match no pack (`final-list-review`, `send-confirmation`) is not seen.

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
and only shrink. The route graph's ceilings are no such floor: a raise passes
with its `absorbs` record in its own pull request, as described above.

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
CORE_PACK_PIN_BASE=origin/main node scripts/audit/core-pack-pin-gate.mjs

# regenerating a pinned-empty baseline REFUSES non-empty output
node scripts/audit/core-extension-instance-coupling-ban.mjs --write-baseline
node scripts/audit/core-extension-import-ban.mjs --write-baseline
node scripts/audit/extension-import-ban.mjs --write-baseline
```

The extension source tree must be cloned back first
(`node scripts/ci/sync-dev-extensions.mjs`) or the gates fail closed.
