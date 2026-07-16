# The artifact-renderer RSC contract

Normative contract for how an **extension-shipped artifact renderer** is
**declared**, **fed**, **mounted**, and **failure-isolated** across the React
Server Component → client boundary. It is the runtime-facing companion to the
[artifact-UI boundary ADR](../decisions/artifact-ui-boundary-adr.md): the ADR
fixes *which side owns the pixels*; this contract fixes *the ABI those pixels are
loaded and rendered against*.

**Landed surface (this document describes it as normative):** the renderer entry
ABI (`cinatra.artifact.ui`), the serializable props snapshot, the failure-isolated
**server-side** loader, and its diagnostics/quarantine — all shipped in the S2
dispatch spine (#1629, epic #1620) and gated by the S6 boundary gates (#1664,
`72aab923`).

**Planned surface (marked `PLANNED` inline, NOT yet landed):** the **main-realm
dynamic** client loader that runs a marketplace-installed renderer with zero host
rebuild. Its plan of record is the ratified final comment on **#1630**
(2026-07-16); Slice A is on PR #1672 (unmerged). Every `PLANNED` note below is
the plan of record, not landed code.

## 1. Entry ABI — `cinatra.artifact.ui`

The canonical v1 schema is `packages/sdk-extensions/src/artifact-contract.ts`
(imported by both byte-mirrored strict manifest schemas so a renderer extension
depends only on `@cinatra-ai/sdk-extensions`).

- **`abiVersion`** — the `ui`-block ABI, **distinct from the SDK ABI**.
  `ARTIFACT_UI_ABI_VERSION = 1`; v1 is the only shape the schema accepts. A future
  v2 is an additive, versioned migration.
- **`sdkAbiRange`** — **generated, never hand-written**; a caret range pinning the
  compatible host SDK ABI (`generateArtifactUiSdkAbiRange`). The **host** verdict
  (`parseArtifactUi`) checks *satisfaction* (a renderer built against an earlier
  host-compatible SDK must still render); the **exact generated pin** is enforced
  one layer up at the extension-repo publish conformance gate.
- **`renderers`** — a **non-empty partial map** over the closed v1 slot enum
  `ARTIFACT_UI_SLOTS = ["detail","preview"]` (`detail` = the artifact detail view;
  `preview` = the neutral inline-preview capability core reuse sites consume). The
  reserved slots `listRow` / `card` / `inline` are **rejected** in v1. The HITL
  field-renderer system and the chat renderable-view system are **separate
  channels with their own declaration surfaces**, not slots of this enum.
- **Per-slot renderer** (`ArtifactUiRenderer`, `.strict()`):
  - **`entry`** — a package-relative, path-contained subpath (`"./…"`, no `".."`,
    no absolute path, no protocol/URL, no backslash; `isContainedEntryPath` pins
    the shape, the publish gate resolves it against `exports`/`files`).
  - **`propsApiVersion`** — the props-contract version the renderer expects
    (integer ≥ 1). See §2.
  - **`representations?`** — optional MIME patterns the slot renders
    (e.g. `["application/pdf"]`).

**Port-less by construction.** The renderer schema is `.strict()` **specifically
because a v1 renderer requests NO host ports** — any extra key (a
`ports` / `requestedHostPorts` request, or any other field) is rejected. A
renderer has nothing to *call*; it renders only from the host-supplied snapshot
(§2). A read-only renderer port is out of scope pending an ABI-major process.

**Tolerant parse, fail-closed at publish.** `parseArtifactUi` is
degrade-never-reject at boot/runtime and fail-closed at the gate: the mirror
schemas carry `ui` as raw `unknown`, so a malformed `ui` **never fails the whole
manifest** and never drops the extension's type registration or `objectTypes`
claims — it is dropped (generic rendering) with a **sanitized diagnostic** at boot
and **rejected fail-closed** at the publish/conformance gate. The diagnostic
echoes only the failing zod PATH + issue CODE, **never a received value**, so a
hostile manifest cannot smuggle content into host logs.

## 2. The serialization boundary — the props snapshot

The renderer receives exactly one input: a versioned, normalized,
**JSON-serializable** props snapshot, `ArtifactRendererProps`
(`src/lib/artifacts/artifact-renderer-props.ts`;
`ARTIFACT_RENDERER_PROPS_API_VERSION = 1`). This IS the RSC contract's load-bearing
invariant.

- **Snapshot-only, no ports.** Every field is plain JSON data: row metadata (a
  projection of the authorized `ArtifactSummary`), the resolved
  representation/content ref, **host-authorized** URLs (already access-checked
  before the snapshot is built — the renderer just references them), the flattened
  effective identity, and sanctioned actions **as navigational hrefs**.
- **Non-serializable host context never crosses.** DB handles, the request,
  server-action closures over `ctx`, functions, symbols, bigints — **none** cross
  this boundary. Actions are host-authorized **links**, never server-action
  closures.
- **Why it must hold: the renderer may mount as a client component.** Even though
  today's loader mounts server-side (§3), the props are designed to survive the
  **RSC → client serialization boundary** so the same snapshot works when the
  renderer runs on the client. `assertSerializableRendererProps` is the
  enforcement helper — it walks the snapshot and throws on any function / symbol /
  bigint / circular ref. Today the invariant is pinned by a **unit test** and the
  type system: the landed load path builds the snapshot
  (`buildArtifactRendererProps`, called in `src/app/artifacts/[id]/page.tsx`) and
  mounts server-side, so it does **not** yet run the assertion as a runtime
  pre-crossing guard — wiring the assert in as a pre-mount check belongs to the
  `PLANNED` client mount (§5). A non-serializable field is a contract violation,
  not a render-time surprise. `buildArtifactRendererProps` is pure data assembly
  (imports nothing server-only, closes over nothing).
- **`propsApiVersion` compat.** A renderer declares the `propsApiVersion` it
  expects; the host refuses to mount a renderer whose expected version this
  snapshot does not satisfy (an `abi-incompatible` degrade, §3).

> The port-less contract limits what the **host hands** the renderer (a
> data-minimized snapshot). It does **not** limit what in-page code can reach on
> its own once a renderer executes in the main realm — that is the
> `PLANNED` main-realm residual (§5), a runtime-trust concern owned by the
> boundary ADR and the no-sandbox trust ADR, not by this serialization contract.

## 3. Failure isolation — the loader taxonomy

The **landed** loader is `src/lib/artifacts/artifact-renderer-loader.ts`
(`server-only`; mounts the resolved component in the **server** render tree —
SSR/RSC). The dispatch spine resolves a row to a **key** into
`GENERATED_ARTIFACT_RENDERERS`; the loader turns that key into either a mounted
component or a **deterministic degrade**. Two failure regimes:

**Pre-render failures → deterministic degrade** (`ArtifactRendererLoadResult`
`{ ok: false, failureClass }`; the caller renders the generic renderer + a
sanitized diagnostic):

| `failureClass` | meaning |
|----------------|---------|
| `not-built` | the key is absent from this build (never built) — the defensive belt if a caller loads a stale key (dispatch already routes this to `requires-rebuild`) |
| `absent` | the guarded loader resolved the standardized degraded result (a post-build marketplace uninstall removed the module) → generic + "requires rebuild" |
| `invalid-export` | the module loaded but exports no component `default` |
| `abi-incompatible` | the build entry's `propsApiVersion` ≠ the host snapshot's — a deterministic pre-render check, **no module executed** |
| `quarantined` | the key crossed the repeat-failure threshold; the host stops loading it and renders generic until restart (§4) |

**A present-but-broken module (a top-level throw) is NOT degraded here — it
RETHROWS** (the `guardedExtensionImport` fail-loud contract), surfacing to the
**route-segment error boundary** (the render-time half). Its failure is still
counted toward quarantine so a persistently-throwing renderer eventually stops
throwing and renders generic.

**Only the resolved module executes.** The loader invokes **only** the resolved
key's loader — no other renderer module is imported or evaluated.

**Never-blank is total, across two surfaces.** The precedence leaf
`pickArtifactRenderer` is total — never throws, never returns "no renderer" — so
every dispatch resolves to a render. A **pre-render degrade** renders the generic
read-only structured-data floor **inline** (plus the sanitized diagnostic). A
**present-but-broken rethrow** is instead contained by the route-segment error
boundary `src/app/artifacts/[id]/error.tsx` — a destructive panel ("This view
could not be rendered") offering the **generic view** (`?renderer=generic`, which
the page honors by forcing the generic floor and never mounting the extension
renderer) plus a retry. Both surfaces are never-blank; neither is a raw error
page, and the detailed error stays telemetry-only.

## 4. Diagnostics & quarantine

- **Sanitized, telemetry-safe diagnostics.** `artifactRendererDiagnostic`
  produces `package + slot + failureClass` **only** — never a raw error message,
  never a manifest value. The detailed error is telemetry
  (`console.error`), not surfaced to the user.
- **Process-local 3-strike quarantine.** A renderer key is quarantined after
  `ARTIFACT_RENDERER_QUARANTINE_THRESHOLD = 3` **counted** failures. Only the
  *broken-module* classes increment the counter — `abi-incompatible`,
  `invalid-export`, and a present-but-broken top-level throw; the
  *structural-absence* classes `not-built` and `absent` do **not** (a missing
  build entry / a post-build uninstall is not a broken module). The counter is
  anchored on `Symbol.for("@cinatra-ai/host:artifact-renderer-quarantine/v1")` so
  it survives duplicated module instances across bundler compilations (the same
  anchor discipline as the object-type registry).
- **Best-effort robustness, NOT a security or revocation control.** Quarantine is
  **process-local and best-effort by design**: a stale worker that never saw the
  failures simply renders the renderer (or its own floor) — the **floor is the
  safety net, not this counter**. Under the `PLANNED` dynamic path, revocation is
  a *separate* concern handled by the existing extension archive/delete lifecycle
  (plan of record #1630, owner ruling 8); this quarantine stays a
  persistently-broken-module recovery mechanism only.

## 5. Two dispatch paths

**Landed — the server-side fast path.** A resolved key present in
`GENERATED_ARTIFACT_RENDERERS` mounts through the `server-only` loader in the
SSR/RSC tree. `renderer-resolution.ts` sets `built = generatedKey in
GENERATED_ARTIFACT_RENDERERS`; a runtime-installed claimant whose key is absent
from this build degrades to `requires-rebuild` (generic + diagnostic, never
blank). This is the only path that exists at the SHA this contract documents.

**`PLANNED` — the main-realm dynamic client path** (plan of record #1630; Slice A
on PR #1672, unmerged). A marketplace-installed renderer is compiled to a
React-externalized client bundle, served from the content-addressed store at a
**digest-pinned immutable URL**, and mounted **client-only** in the **main realm**
via a native `import(runtimeURL)`, sharing the host's single React instance
through a host module-registry shim. Its contract deltas (all `PLANNED`):

- The predicate widens to `loadable = inBuildMap OR inRuntimeAssetRegistry`; the
  runtime asset registry binds the **exact admitted tuple** `<packageName, slot,
  digest, entry, propsApiVersion, sdkAbiRange, reactPeerSet, tokenModuleAbi>` — a
  per-process **cache** over a DB-authoritative active digest, never
  "package is installed".
- The server **resolves and serializes** an admitted runtime descriptor
  (`{ digestPinnedUrl, tuple, reason? }`) down to the client — a server-side
  registry is not browser-visible, so the client loader consumes serialized props.
- `pickArtifactRenderer` stays **byte-unchanged**: new incompatibility reasons
  (`react-peer-incompatible`, `signature-unverified`, `materializing`,
  `not-active/archived`, `import-failed`, …) are carried as **resolution side
  data** and classified after precedence; `requires-rebuild` becomes the
  transient/error alias. The requires-rebuild vocabulary is not made to lie.
- A **fail-closed freshness preflight** re-checks digest + signature + still-
  installed/active before the cached `import()`; a bounded, timeout-capped
  skeleton covers latency; a React error boundary catches render/lifecycle throws
  and degrades to the same never-blank floor (**logical containment only** — not a
  security or execution boundary; an unavoidable final TOCTOU window and
  already-executed top-level effects are stated honestly in the plan).
- **G4 stays intact**: the runtime-URL `import()` is the one sanctioned client
  seam (a `no-variable-url-dynamic-import` ratchet confines it), and the generated
  map remains the sole static-import carve-out.

When Slice A lands, the `PLANNED` deltas above become normative and this section
moves them out of `PLANNED`.
