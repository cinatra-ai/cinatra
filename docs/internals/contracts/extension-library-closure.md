# Library dependency closure — signed materialization plans (host side)

Status: shipped (cinatra#181). Extensions may DECLARE npm library dependencies
instead of bundling them; the host materializes the publish-time SIGNED
MATERIALIZATION PLAN verbatim at install. Whole-bundle inlining (the #161
builder default) stays the default and is byte-for-byte unchanged.

The cross-side BYTE contract (canonical plan bytes, closureHash, v2 signature
payload + transport) is pinned by the committed fixtures under
`src/lib/__tests__/fixtures/materialization-plan/` — those bytes are
normative; this page is descriptive.

## The shape

```
publish time (marketplace, sibling lane)        install time (this repo)
─────────────────────────────────────────       ──────────────────────────────
lockfile ──► canonical PLAN ──► closureHash ──► v2 signature
                  │                                   │
                  ▼                                   ▼
   packument versions[v].cinatraMaterializationPlan   dist.cinatraSignature ("v2:"+b64)
                  │                                   │
                  ▼                                   ▼
        parseMaterializationPlan (fail-closed)  resolveSignatureVerdict(closureHash)
                  │                                   │ downgrade refusal
                  ▼                                   ▼
        executeMaterializationPlan (step 4.7) ─► contentHash over the POST-closure tree
                  │                                   │
                  ▼                                   ▼
        real nested node_modules dirs           InstallTrustAnchor{contentHash, closureHash}
        (plain Node file:// resolution —        boot/activation re-verify, zero loader changes
         the loader has ZERO plan knowledge)
```

## Builder modes (`cinatra.dependencyMode`)

> **Stability: `cinatra.dependencyMode` is a PUBLIC field** (the extension
> ruling (e), 2026-06-13). It is **not** gated behind a separate experimental
> flag: the package is still **v0.1.x**, and the version number already conveys
> that the contract is not stable. Treat the field as public-but-pre-stable —
> publishers may declare `"closure"`, but the closure-signing PRODUCER is not
> shipped yet (see [Signer authority](#signer-authority--which-tool-signs-a-closure-package)),
> so a closure package cannot actually be signed-and-trusted through any tool
> available today.

| | `"inline"` (absent = default) | `"closure"` |
|---|---|---|
| runtime deps | inlined into the bundle | kept EXTERNAL |
| packed `dependencies` | PRUNED | KEPT (the basis of the signed plan) |
| residual imports | node builtins only | builtins ∪ declared deps (host peers refused) |
| dependency specs | any | PLAIN registry range/tag ONLY — every `npm:` alias refused (plan/v1 carries ONE identity per node: placement name == registry name) |
| built `register.mjs` + self-check | mandatory (when a serverEntry is declared) | mandatory (when a serverEntry is declared; a closure package with NO serverEntry is legal — the plan alone covers its deps) |

See `docs/extension-server-entry-contract.md` for the full builder contract.

## Plan format `cinatra-materialization-plan/v1`

- All fields required, extras refused. Node identity = `placementPath`
  (the same `name@version` nested at two points = two nodes).
- `placementPath` grammar: `node_modules/<pkg>(/node_modules/<pkg>)*`,
  scope-aware; traversal impossible by construction; name-tail == node name.
- Every edge is NODE-RESOLUTION-VALID (hoisted/deduped placements legal,
  arbitrary cross-tree references refused); unreachable nodes refused;
  duplicate dependency NAMES within one set refused; host ABI peers are never
  plan nodes; exact versions + strict canonical single-sha512 SRI only.
- Caps: ≤ 500 nodes, ≤ 1 MiB canonical bytes (parse); ≤ 256 MiB summed node
  tarball bytes, per-node 64 MiB / 10k entries declared-unpacked (execute).
- `closureHash` = lowercase-hex sha512 over the canonical bytes (keys sorted,
  `nodes` by placementPath, dep arrays by name, zero whitespace, UTF-8). The
  host always re-canonicalizes parsed transport before hashing.

## Signature protocol v2 + downgrade refusal

- v2 payload (UTF-8, LF, no trailing newline, 5 lines):
  `cinatra-extension-signature/v2\n<name>\n<version>\n<integrity>\n<closureHash|none>`
- Transport: `dist.cinatraSignature` = `"v2:" + base64` for v2; bare base64 =
  v1; any other prefix refused (never strip-and-retry).
- Plan present ⇒ the verdict is NEVER `undefined`: absent signature, no
  trusted key, v1 signature, invalid v2, v2 binding `none` — all hard `false`.
  A closure package can never reach ANY trusted tier (incl. trusted-bootstrap)
  without a verified v2 binding of the host-recomputed hash. Closure-less
  packages keep v1 semantics byte-for-byte.

## Signer authority — which tool signs a closure package

The host side (this repo) is **complete**: it verifies a v2 closure signature,
recomputes the `closureHash`, and fails closed on anything less. The **producer**
side is **pending** — host-side complete, producer pending:

- The **future marketplace publish pipeline's v2 signer is the authoritative
  closure signer.** When it lands it will emit the v2 payload above
  (`signExtensionV2`, `src/lib/extension-signature.ts`) and bind the
  host-recomputed `closureHash`. Until then, **no shipped tool can produce a
  trusted closure signature.**
- The marketplace broker signer (`ExtensionSigner.php`,
  `marketplace/packages/verdaccio-core`) is **v1-only today** — it is NOT yet a
  v2 closure signer. Do not treat the current broker as the closure authority.
- The standalone owner tool (`extension-release-tooling/scripts/extension-signer.mjs`)
  is **v1-only and is NOT a closure signer.** Signing a closure-mode package
  with it would emit a v1 signature, which the host **rejects** (a closure
  package can never reach any trusted tier on a v1 signature — see the verdict
  rule above). To make that failure loud at sign time rather than silent at
  install time, the standalone signer **refuses** a closure-mode manifest and
  points at this section (extension-release-tooling change, the closure
  half).

End-state statement: **closure verification is host-side complete; closure
SIGNING is producer-pending** until the marketplace v2 signer ships. When it
lands, its acceptance tests MUST consume the cinatra normative fixture bytes
(`src/lib/__tests__/fixtures/materialization-plan/`) verbatim.

## Install flow (both paths: registry pipeline AND workflow saga)

1. `resolveIntegrity` returns the raw packument plan; the host parses it
   FAIL-CLOSED (`extension-materialization-plan-core.ts`), binds
   `plan.package` to the RESOLVED `(name, version)`, recomputes `closureHash`.
2. The verdict threads `closureHash` (downgrade refusal above). An untrusted
   refusal is fully INERT: no journal write, no grant mutation, no probe code
   execution.
3. `materializePackageToStore` step 4.7 (after the built-artifact gate 4.6,
   BEFORE the step-5 content hash) runs `executeMaterializationPlan`
   (`extension-materialization-plan-executor.ts`): per node, in
   parents-before-children order — fetch through the SAME injected
   `fetchTarball` seam (broker/grant identity preserved) → strict SRI →
   hardened extract → refusal battery → rename into the exact placement.
4. Step 4.8 residual coverage: every bare value-import reachable from the
   built serverEntry must be a node builtin, bundled (pre-plan set), or a plan
   ROOT. Unresolvable self-imports refuse too.
5. The step-5 content hash walks EVERYTHING incl. the materialized
   `node_modules` → the sidecar + `InstallTrustAnchor` + the
   `installed_extension.source` JSONB record `contentHash` AND `closureHash`
   (additive field, no SQL migration). Boot re-verify covers the libraries
   with zero loader changes.

## Refusal battery (test-pinned)

| refusal | where |
|---|---|
| tar entry types other than File/Directory (symlink/HARDLINK/device/FIFO) | tar-header filter, extension AND node tarballs |
| `node_modules/` segments inside a plan-node tarball | tar-header filter |
| decompression bombs (declared unpacked bytes / entry count, EVERY header counted) | tar-header filter (plan nodes) |
| lifecycle scripts (preinstall/install/postinstall/prepare) | per-node battery |
| native addons (`*.node`, `binding.gyp`, node-gyp/node-pre-gyp/prebuild-install in scripts) | per-node battery |
| extracted package.json name/version != plan node | per-node battery |
| placement collision (target exists) | executor (never overwrites) |
| per-node SRI mismatch / caller-threading closureHash drift | executor |
| declared dep neither bundled nor planned; bundled AND planned; plan root undeclared | evolved bundled-deps gate (bundled XOR planned) |
| uncovered bare import / unresolvable self-import from the built entry | step 4.8 |
| plan-bearing reuse-dir closureHash mismatch | FAIL-LOUD + NON-DESTRUCTIVE (operator remediation; a possibly-live same-digest dir is never auto-deleted) |

## Determinism

`contentHash` folds sorted `(relPath, sha512(bytes))` — no mtimes/perms; the
plan pins exact bytes (SRI) and exact placements; execution order cannot
affect the hash. Acceptance is golden-pinned in
`src/lib/__tests__/extension-library-closure-e2e.test.ts`
(+ `fixtures/library-closure-golden/golden-hashes.json`): two store roots ⇒
identical hash == the committed pin; transport shuffle ⇒ same canonical
bytes/hash/tree; plan tamper ⇒ v2 refusal; v1-signed closure ⇒ refusal;
library tamper ⇒ boot refusal; closure-less fixture ⇒ its own golden
(today's behavior unchanged).

## Out of scope

Extension-to-extension dependencies (the #180 lane — the two closures never
mix); inter-extension npm deps stay banned by the coupling gates;
devDependencies never resolved; `npm:` aliases not expressible in plan/v1.
