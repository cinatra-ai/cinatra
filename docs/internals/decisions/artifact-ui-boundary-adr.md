# ADR — The artifact-UI core/extension boundary

- Status: ACCEPTED (owner ruling on the corrected artifact-UI boundary, epic
  #1620; CI-enforced by the S6 boundary gates, merged in #1664 at `72aab923`,
  2026-07-16)
- Scope: WHICH side of the host/extension line owns type-specific artifact
  presentation, and the CI machinery that keeps that line from re-inverting —
  NOT the runtime loader that executes an extension renderer (that is the
  companion [artifact-renderer RSC contract](../contracts/artifact-renderer-rsc-contract.md)
  and the M1 dynamic-loader work, still landing)
- Supersedes: the earlier **"metadata-only artifact extension / core owns every
  renderer"** boundary that the public docs, glossary, and objects-layer
  reference still taught before epic #1620 (the S10 rewrite, #1627, retires that
  guidance)
- Source: epic #1620 ("artifact extensions own their UI"); the S6 gate reference
  `scripts/audit/artifact-ui-boundary-gate.md`; the ratified M1 plan of record on
  #1630 (the dynamic loader). Companion: the
  [no-sandbox third-party-trust ADR](./no-sandbox-third-party-trust-adr.md)
  (execution-trust posture) and the
  [artifact-renderer RSC contract](../contracts/artifact-renderer-rsc-contract.md)
  (the entry ABI + serialization boundary).

## Context

An artifact extension used to be **declarative only** — representation forms,
matchers, and skills — and the **host** owned every renderer: opening a row on
`/artifacts/[id]` routed through host-side code that branched on the row's
concrete type / MIME / viewType to pick a hard-coded viewer, and core files
registered detail renderers directly. Under that boundary, adding a viewer meant
editing core and shipping a new host; a third-party extension could never own
the pixels for its own type.

Epic #1620 **inverts** that: an artifact extension **owns its own detail /
preview UI**, declared in a versioned `cinatra.artifact.ui` manifest block, and
core is reduced to **generic dispatch** — it routes, authorizes, frames the
page, and guarantees a never-blank floor, but it does not know or branch on what
a given type looks like.

The danger is **re-inversion**: the migration that moves each host-side viewer
into its claimant extension (waves S4/S7/S8/S9) runs against a large surface, and
any new core code can quietly re-introduce a type-specific branch. The S6 gates
(this ADR's enforcement half) land the boundary as a **CI-enforced, shrink-only
ratchet BEFORE the first migration**, so the migrations can only ever remove
host-side coupling, never add it back.

## Decision

### 1. The boundary (normative)

- **Extension-owned**: the artifact type's detail **view** subtree, its
  representation **previews**, and its presentational registry items.
- **Core-owned**: routing / authz / chrome of `/artifacts/[id]`, the **dispatch
  mechanism** itself, and the **never-blank floor** (the generic
  structured-data fallback, escaped plain-text, and markdown while that family is
  deferred).

### 2. The violation predicate

> Any production-core dependency, comparison, lookup, import, or data
> transformation **keyed by a concrete extension-owned presentation identity**
> for type-specific presentation is a violation.

The keyed-on identities are: artifact / object **type ids**, **representation
forms** (MIME patterns), **HITL field-renderer binding ids**, and chat
**renderable-view viewTypes**. The corollary is the whole rule in one line:

> **Core treats presentation identity as an opaque input to generic dispatch —
> it branches on the *shape* of a resolved dispatch, never on a concrete
> identity.**

### 3. The opaque dispatch seam (the two-registry model)

Raw type-id / MIME / viewType access in core lives ONLY behind the **dispatch
seam** (the S2 spine, landed under #1629):

- **Two arbitration registries** in `@cinatra-ai/objects/artifact-renderer-registry`:
  - a **semantic-type registry** keyed by `objectTypeId` → the per-org
    effective-identity **winner**;
  - a **representation-provider registry** keyed by `(pattern, slot)`,
    org-scoped, precedence `exact > type-wildcard > catch-all`, extension
    providers bound under a monotonic activation-generation floor with
    first-party host defaults beneath.
  - Both resolve a row to an opaque `generatedKey` (`<pkg>::<slot>`). A **viewer
    resolves via the representation-provider registry; a semantic renderer via
    effective identity — the two systems never share a keyspace** (the G2 cutover
    matrix enforces they are never cross-applied).
- **The generated build map** `src/lib/generated/artifact-renderers.ts` — the
  literal dynamic-import table of the renderer modules that shipped in **this**
  build (Turbopack rejects computed import templates, so entries are literal
  `() => import("…")`).
- **The pure precedence leaf** `src/app/artifacts/[id]/renderer-dispatch.ts` →
  `pickArtifactRenderer`: total over every row, never throws, never returns "no
  renderer". It emits an **opaque `ArtifactRenderDispatch`** union
  (`semantic | representation | mime | requires-rebuild | fallback`); core UI
  branches on `dispatch.kind`, never on a concrete identity. The server-only
  resolver `renderer-resolution.ts` binds the registries + build map into this
  pure leaf's inputs.

New core code must route through this seam, not add an identity branch. Every
current identity-keying site is enumerated in the G1 baseline with a disposition
(below).

## Gate contracts (G1–G5)

The full normative reference is `scripts/audit/artifact-ui-boundary-gate.md`;
this ADR records what each gate is FOR. G1–G4 are the host-side arm; G5 is the
publish/extension-side arm.

- **G1 — type-identity gate** (`scripts/audit/artifact-ui-boundary-gate.mjs` +
  `lib/artifact-presentation-identity.mjs` + `…-boundary-gate.baseline.json`).
  A `typescript`-compiler-API AST detector over all core packages
  (`src/**`, `packages/*/src/**`; fixtures/tests/generated excluded) that finds a
  curated presentation-identity literal used in a **keying** shape (equality /
  `switch` case / `.startsWith|endsWith|includes|has|get|match` / element-access
  key / object-literal key; plus lookup-array shapes, scoped to the
  rendering/preview-serving surface for representation MIMEs to close the
  reshape bypass without false-positiving LLM/A2A/authoring MIME lists). This is
  the **negative** proof — "no new core→identity keying".
- **G2 — per-arm cutover matrix**
  (`@cinatra-ai/objects/artifact-ui-cutover-matrix`, `evaluateArmCutover`). The
  consumable contract each migration wave runs an arm through (10 world-states)
  BEFORE it deletes the legacy host-side arm and drops the G1 baseline entry.
  The artifact-detail surface has a ready-made probe bound to the real
  `pickArtifactRenderer`
  (`src/app/artifacts/[id]/boundary/artifact-detail-cutover-probe.ts`).
- **G3 — golden dispatch conformance**. A synthetic fixture renders through the
  registries + generated map with **zero core diffs** — the **positive**
  extensibility proof that adding a type/representation is a registry entry plus
  a generated-map key (never a core edit).
- **G4 — import boundary** (`eslint.config.mjs`, `ARTIFACT_RENDERER_ENTRY_BAN`).
  A core module MUST NOT import an artifact-extension renderer **entry**
  (`@<scope>/<x>-artifact` + subpaths). The **sole** carve-out is the generated
  map `src/lib/generated/artifact-renderers.ts` — no shell / floor / dispatch-seam
  exception. The authoritative all-imports enforcement is the sibling
  zero-tolerance `core-extension-import-ban` gate.
- **G5 — publish-side arm**. The extension / publish-side conformance and
  publish checks already shipped by S1 (`cinatra.artifact.ui` sub-schema in the
  sdk-extensions leaf), S3 (the companion-repo conformance workflow), and S5
  (the marketplace registry publish pipeline). Referenced here so the boundary is
  closed on both sides.

Every gate error names the offending construct (file:line, the concrete
identity, the keying kind / the banned import) and links this ADR's reference
doc plus the S10 authoring pack — gate messages are first-class authoring
guidance.

## Inventory → baseline

The boundary is enforced by **enumerate-then-shrink**, not by a clever universal
detector. The G1 baseline (`scripts/audit/artifact-ui-boundary-gate.baseline.json`)
is the **inventory of every identity-keying arm that exists in core today**, each
carrying a **disposition**:

| disposition | carries | meaning |
|-------------|---------|---------|
| `MIGRATE` | `owner`, `wave` | moves INTO its claimant extension in an S4/S7/S8/S9 wave; the entry is dropped in the SAME PR that removes the arm |
| `DEFER` | `owner`, `wave` | a deferred family (markdown/mermaid) held core-side until its unblock condition |
| `STAY` | `rationale` | legitimately core-owned (the never-blank floor, content-type byte-sniffing, the host-owned portlet React) — an allowlist disposition |

The seeded baseline at S6 landing is **60 arms — `MIGRATE 45 / DEFER 6 /
STAY 9`**, by wave/disposition:

- **MIGRATE ×45** — S4 viewers + preview-serving ×40 (pdf/image/video/audio in
  `pick-handler.ts`, the preview route per-MIME caps, the
  `PREVIEW_INLINE_MIME_ALLOWLIST`), S8 HITL field-renderer ×1 (the
  `ai-review-panel` x-renderer binding), S9 chat ×4 (the renderable-view
  registry viewType→card keys).
- **DEFER ×6** — the markdown family (`text/markdown` / `text/x-markdown`) across
  pick-handler + preview route + allowlist, held core-side until the
  sanitization-family claimant lands.
- **STAY ×9** — the `text/plain` floor ×3, the host-owned portlet React ×2 (an
  epic non-goal), and content-type byte-sniffing in `local-disk-blob-store.ts`
  ×4.

**The ratchet (shrink-only):** live findings must equal the baseline **exactly**
(an unbaselined live arm → UNKNOWN → fail; a baseline entry with no live arm →
STALE → fail; duplicate fingerprints fail; a hand-edited entry whose fingerprint
no longer authenticates fails). With `ARTIFACT_UI_BOUNDARY_BASE` set (the CI base
ref, the same `steps.base.outputs.base` the sibling `core-extension-import-ban` /
`file-size-ratchet` ratchets use), the committed baseline's fingerprint set must
be a **subset** of the base branch's — it may only ever shrink. So each migration
wave can only DELETE arms; nothing can add a new host-side identity branch and
survive CI.

**Accepted residual (on the record).** A literal-scan ratchet cannot see
const-aliased comparisons, a genuinely new presentation identity not yet in the
vocabulary, or an arm reshaped-into-an-array AND relocated to a brand-new file
outside the declared rendering/preview-serving surface. This residual is inherent
to the gate class (shared by every sibling ratchet). The design deliberately
chooses **truthfulness over completeness** on these edges — false-positiving an
unrelated LLM/A2A/authoring MIME list is a worse CI failure than a rare,
review-visible bypass. Defense-in-depth covers it: G4 + `core-extension-import-ban`
catch the import coupling a new renderer needs, the STALE-entry rule forces each
migration to drop its arm in the same PR, and S1/S5 is the extension-side arm.

## The `-artifact` naming ruling

A **renderer artifact** and a **meaning-type artifact** are **both**
`kind:"artifact"`; there is **no** separate `kind:"renderer"` and no `-renderer`
suffix (owner ruling 4 on #1630). The distinction is a **manifest fact**: a
renderer declares `cinatra.artifact.ui.renderers[*].representations` and ships no
matcher / `objectTypes` claim. The **`-artifact` suffix is kept** for every
package (`image-artifact`, `pdf-artifact`, `json-artifact`, …); the role is
surfaced in docs and marketplace labeling, never in the package name. This keeps
the bundled discovery scan
(`scanDirForArtifacts` → `endsWith("-artifact")` in
`packages/objects/src/integration/register-artifact-extensions.ts`) working
as-is; marketplace installs register by manifest `cinatra.kind === "artifact"`,
dir-name-agnostic.

## Relationship to the dynamic renderer loader (PLANNED — plan of record #1630)

This ADR is the **boundary**; it is deliberately silent on HOW an extension
renderer executes at runtime, which is the M1 dynamic-loader work. That work is
**not yet landed** (Slice A is on PR #1672, unmerged; the ratified plan of record
is the final comment on #1630, 2026-07-16). Recorded here only so the boundary is
read in the right frame:

- The four **system bases** (image/pdf/audio/video) stay **build-bundled** and
  mount through `GENERATED_ARTIFACT_RENDERERS` (the SSR/RSC fast path). A
  marketplace-installed renderer is **planned** to execute in the **main realm**
  (the host page), loaded by a client seam via a native `import(runtimeURL)` — a
  *runtime URL*, not a static/computed specifier, so **G4 stays structurally
  intact**: the ESLint renderer-entry ban is not engaged, and the plan adds a
  second sanctioned seam (a `no-variable-url-dynamic-import` ratchet confining
  variable-URL `import()` to that one client loader).
- Because main-realm code has the page's authority, the plan's ratified security
  posture is the **admission chain, not an execution boundary**; a malicious
  renderer that survives admission is **XSS-equivalent**. That accepted risk is a
  runtime-trust decision that belongs with — and extends — the
  [no-sandbox third-party-trust ADR](./no-sandbox-third-party-trust-adr.md), not
  this boundary ADR.
- Under the plan the `renderer-resolution.ts` `built` predicate widens to
  `loadable = inBuildMap OR inRuntimeAssetRegistry`, and `requires-rebuild` is
  reclassified as a transient/error alias carrying side-data reasons. **None of
  that has landed at the SHA this ADR is written against** (`72aab923` + the S6
  merge); the boundary and its gates above are landed and CI-enforced today.

## Consequences

- The corrected boundary is **permanent and CI-enforced** before the first
  migration; a migration wave can only shrink the host-side surface, never
  re-invert it.
- Every host-side identity-keying arm is **inventoried with a disposition** and a
  named destination wave, so the migration program is auditable against the
  baseline.
- Core stays **type-agnostic**: adding a new artifact type or representation is a
  registry entry + a generated-map key (G3), never a core edit; new core code that
  reaches for a concrete identity fails G1/G4.
- The public docs, glossary, and authoring pack that still teach the superseded
  "metadata-only / core owns renderers" boundary are corrected by the S10 rewrite
  (#1627) and pinned against regression by the corpus contradiction gate.
