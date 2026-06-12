# The runtime-store `serverEntry` contract (built artifacts only)

Normative contract for `cinatra.serverEntry` in **runtime-store-installed**
extension packages (cinatra#161). The runtime package store activates
**BUILT artifacts only** — a TypeScript source mirror is refused loudly at
install (materialize) time, never deferred to an opaque activation failure.

## The contract (normative)

A runtime-store package that declares `cinatra.serverEntry` MUST satisfy:
resolving the declared value

- through the package `exports` map (exact-key match; conditional entries
  pick `import` → `default` → `require`) when the key is declared,
- else taking it as a literal `./`-relative path,

yields a path that

- **(a)** stays inside the package dir (no absolute path, no `..` segment —
  applied to the exports TARGET as well as the literal; a path like
  `./dist/../register.mjs` is refused even though it normalizes back inside),
- **(b)** names an existing regular file in the materialized package, and
- **(c)** carries a Node-importable extension: `.mjs`, `.cjs`, or `.js`.

`.ts`/`.tsx`/`.mts`/`.cts`, extensionless resolutions, and missing files are
refused. `serverEntry` absent/null stays a valid no-server-entry package
(agents, skills, artifacts — skipped, as today).

### Pinned Cinatra resolver semantics (NOT full Node `exports` resolution)

Exact-key lookup only. A conditional entry is ONE level deep: a plain object
whose `import` / `default` / `require` value is a STRING starting with `./`.
Everything else is out of contract and refused when `serverEntry` depends on
it: array targets, wildcard/`./*` patterns, nested condition objects, `null`
targets, and any target not starting with `./`. A DECLARED key whose target
is out of contract never silently falls back to the literal path — it is
refused on both sides (install and activation). Wildcard support is
explicitly out of contract until the host-peer import scanner can follow the
same forms — the resolver and the scanner must always accept the same
language.

The single resolver implementation lives in `@cinatra-ai/sdk-extensions`
(`resolveExportsSubpath` / `resolveDeclaredServerEntry` /
`classifyServerEntryArtifact` in `packages/sdk-extensions/src/runtime-loader.ts`);
the host materializer imports it, and the standalone release builder inlines
it with a parity test pinning the two against a shared case table.

## Recommended published shape

A top-level built ESM bundle:

```jsonc
{
  "name": "@acme/crm-connector",
  "type": "module",
  "files": ["register.mjs", "README.md"],
  "cinatra": {
    "kind": "connector",
    "serverEntry": "./register.mjs"
  }
}
```

An `exports`-map key targeting a built file also works:

```jsonc
{
  "exports": { "./register": "./dist/register.mjs" },
  "cinatra": { "serverEntry": "./register" }
}
```

Two non-negotiables for the published artifact:

- **Self-contained bundle (inline mode — the default).** The store does not
  materialize your `node_modules` unless the tarball bundles them — and the
  materializer's bundled-dependencies gate requires every `dependencies`
  entry to be present under the tarball's `node_modules`. Bundling the
  entry's runtime graph into `register.mjs` (and pruning the inlined
  `dependencies` from the published manifest) satisfies the gate with a
  strictly smaller artifact. See
  [Dependency modes](#dependency-modes-inline-and-prune-vs-declare-and-closure)
  for the declare-and-closure alternative (cinatra#181).
- **Host ABI peers stay external.** The host-PROVIDED packages
  (`@cinatra-ai/sdk-extensions`, `@cinatra-ai/sdk-ui`, `@cinatra-ai/mcp-client`
  — `HOST_PROVIDED_PACKAGES` in `src/lib/extension-package-store-core.ts`)
  are never inlined: extensions keep them type-only and reach every
  privileged surface via the injected `ctx` ports (a host-peer VALUE import
  in the entry's graph is refused by the materializer's host-peer gate).
  In INLINE mode everything ELSE the entry's graph reaches must be inlined —
  including `react`/`react-dom` (their `react-server` builds — the host RSC
  layer's view) and Next's server-layer module views — because the store
  provides no module resolution beyond Node builtins. Those are build-time
  inputs, not runtime peers. In CLOSURE mode declared runtime `dependencies`
  additionally stay external (materialized at install from the signed plan);
  the host-peer rule is identical in both modes.

First-party connectors do not hand-maintain this shape: the release pipeline
builds it (`scripts/extensions/build-server-entry.mjs` — the canonical
builder; the release workflow and the marketplace wave-runner both run it).
For a SOURCE-shaped entry the builder stages a temp pack dir, esbuild-bundles
the resolved source entry into a top-level `register.mjs`, rewrites the
manifest IN THE STAGED DIR ONLY (`serverEntry: "./register.mjs"`,
`register.mjs` appended to `files`, and — in inline mode — the inlined
`dependencies` pruned; closure mode keeps them), and `npm pack` runs from
that stage — the source tree is never touched, and every downstream consumer
reads the PACKED manifest from the tarball bytes. An ALREADY-BUILT entry
passes through verbatim (no bundle, no manifest rewrite — the package is
packed as-is; closure mode residual-validates its import graph without
re-bundling). The in-tree source-mirror shape
(`exports["./register"] → "./src/register.ts"`) stays canonical for the
static-bundle path.

## Dependency modes: inline-and-prune vs declare-and-closure

`cinatra.dependencyMode` (cinatra#181) selects how a package's npm LIBRARY
dependencies reach the runtime store. The builder reads it from the manifest;
the `--mode` CLI flag overrides it for TESTS ONLY.

| | `"inline"` (default — field absent) | `"closure"` |
|---|---|---|
| esbuild externals | host ABI peers only | host ABI peers + declared runtime `dependencies` (incl. subpaths) |
| packed `dependencies` | PRUNED | KEPT (basis of the signed plan; registry specs only — `npm:` aliases of host peers and git/file/link/workspace/URL specs refused) |
| residual-import rule | node builtins ONLY | node builtins ∪ declared `dependencies`; host peers refused; self-references traced INTO the scanned graph (never blanket-allowed) |
| already-importable entry | verbatim passthrough | verbatim passthrough + residual VALIDATION (never re-bundled) |
| no `serverEntry` | verbatim copy | verbatim copy (legal — the plan alone covers the deps) |
| built `register.mjs` + packed-manifest self-check | mandatory | mandatory |

In closure mode the dependencies are materialized at INSTALL time from the
package's publish-time **signed canonical materialization plan** (exact node
identities, parent→child edges, exact `node_modules` placement paths,
per-node sha512, `closureHash` over the canonical plan; the installer
executes it verbatim — zero install-time resolver decisions). Until the
host's relaxed install gate ("every declared dep is bundled OR in the signed
plan") and the publish-time signer ship, adoption is FAIL-CLOSED by
construction: a closure tarball is refused by the current bundled-deps gate,
and no signed plan can exist. No package may declare
`dependencyMode: "closure"` before the mode-aware builder and the relaxed
gate are deployed; host ABI peers can never be closure libraries (the builder
and the install gate both refuse them in `dependencies`).

## Error families and their fixes

Same classifier everywhere; three places it can fire, earliest first.

### 1. Submit time — release-tooling preflight (publisher-facing)

This gate lives OUTSIDE this repo, in the release pipeline:
`release-submit.mjs`, published alongside `build-server-entry.mjs` under
[cinatra-ai/.github `scripts/v622/templates/release/`](https://github.com/cinatra-ai/.github/tree/main/scripts/v622/templates/release)
— the tools the reusable extension release workflow fetches (and the
marketplace wave-runner shells out to). It refuses to submit a tarball whose
PACKED manifest (read from the tarball bytes) violates the contract. Message
head:
`serverEntry preflight FAILED — refusing to submit <pkg>: <violation>`, where
the violation is one of: a source/extensionless resolution
(`… The runtime store activates BUILT artifacts only (.mjs/.cjs/.js)`), an
exports key `whose target is outside the supported exports forms`, a path
that `escapes the package dir`, or a resolved entry where
`the tarball carries no such file`.

**Fix:** publish through the standard release workflow (it runs the builder
when `cinatra.serverEntry` is declared), or for a hand-rolled tarball ship a
built ESM entry per the shape above. Never point `serverEntry` at `.ts`
source in a published manifest.

### 2. Install time — the materializer gate (the PRIMARY gate)

`[package-store] <pkg>: cinatra.serverEntry "…" resolves to "…" — <reason>.
The runtime store accepts BUILT artifacts only: ship a built ESM entry
(top-level "register.mjs" with cinatra.serverEntry "./register.mjs" is the
convention; an exports key targeting a built file under dist/ also works).
Refusing to materialize.`

Reasons: `a TypeScript source entry`, `has no importable extension
(.mjs/.cjs/.js)`, `does not exist in the tarball`, `escapes the package dir`,
or a declared exports key `whose target is outside the supported exports
forms`. The install fails and **nothing is written to the store**; an
already-active old digest stays active.

**Fix:** the artifact is broken at the source — republish a built artifact
(family 1's fix), then install the new version. For a first-party connector
this means the package predates the built-artifact pipeline; wait for (or
ask for) its republish.

### 3. Activation time — loader defense in depth (legacy store dirs only)

Store dirs written by OLDER installers (before the install-time gate) get the
same classification at activation instead of an opaque ENOENT:
`[runtime-package-loader] serverEntry "…" for <pkg> resolves to "…" which is
TypeScript source / not a concrete importable file … publish a built ESM
entry … and reinstall the package from the marketplace.` A missing built
entry's `realpath` ENOENT is wrapped into the same actionable shape. The
activation is recorded `failed`; nothing crashes the boot.

**Fix:** reinstall/update the package from the marketplace — the reinstall
runs the new install-time gate, so it either materializes a valid built
artifact or refuses with family 2's actionable error.

## Static bundle vs runtime store (loader matrix)

| | Static bundle (first-party, in-image) | Runtime package store |
| --- | --- | --- |
| Acquisition | `cinatra-required-extensions.lock.json` (SHA-pinned source tarballs) baked into the image build; dev trees clone workspace members ([pinning doc](./extension-clone-pinning.md)) | Marketplace install: SRI-verified tarball → materialized store dir → trusted anchor |
| Entry shape | TS SOURCE (`exports["./register"] → "./src/register.ts"`); compiled by Next/webpack at image build via the generated import map + tsconfig aliases | BUILT ESM artifact (`.mjs`/`.cjs`/`.js`) per this contract |
| Who resolves `serverEntry` | the build toolchain (workspace + aliases) | the shared SDK resolver — exports-key first, literal fallback, pinned semantics |
| serverEntry contract enforcement | n/a (compiler errors at build) | materializer gate at install (primary) + loader classification at activation (defense in depth) |
| Import mechanism | compiled-in `import()` thunks (`src/lib/generated/extensions.server.ts`) | realpath-bound `file://` dynamic `import()` from the verified store dir |
| Integrity | image provenance + pinned lock SHAs | tarball SRI → content hash over materialized files → realpath containment |
| Failure surface | host CI / image build | install refusal (loud, actionable) or `failed` activation record |

This contract changes NOTHING on the static path.

## Operator runbook: refreshing a stale runtime-store digest

A runtime-store digest installed before a host **capability re-point** keeps
activating but fails at CALL time with a capability-resolution miss naming
the retired capability id. Concrete case: the retired
`@cinatra-ai/host:nango-connection-storage` id (cinatra#151 Stage 7) — a
pre-re-point digest resolves it to nothing and throws when first used; every
current package resolves the connector-authored `nango-system` surface
directly.

There is deliberately no boot-time heuristic for "predates the re-point" —
the call-time miss is already a precise, loud signal. The remediation is a
marketplace refresh:

1. **Sequence it correctly.** A first-party connector refresh is only
   meaningful AFTER that connector has been republished as a built artifact
   (the cinatra#161 republish wave). Refreshing earlier hits the
   install-time refusal (family 2) — loud, correct, and harmless: the
   install fails, nothing is written, **the old digest stays active**.
2. **Trigger a reinstall/update of the package from the marketplace** (the
   normal in-product extension install/update flow for the new version).
3. **The hot-update path keeps you safe** (`extension-runtime-activate.ts`):
   the NEW digest is proven importable + integrity-verified FIRST
   (`verifyNewDigestActivatable`) — the old digest is only torn down/GC'd
   after the new one proves activatable; a bad refresh aborts before
   teardown and the old digest stays active. No restart required.
4. **Verify:** the package's activation record shows `registered` for the
   new digest, and the call path that previously hit the capability miss
   resolves.

## See also

- [Pinned extension clone-back (CI)](./extension-clone-pinning.md) — how the
  static path acquires and pins extension SOURCE.
- `packages/sdk-extensions/README.md` — the author-facing SDK ABI, including
  `register(ctx)` and the manifest contract.
- `scripts/extensions/build-server-entry.mjs` — the canonical builder
  (library + CLI) that turns the in-tree source shape into the published
  built shape.
