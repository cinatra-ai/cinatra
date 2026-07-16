# Artifact-UI boundary gates (G1–G5)

Epic **#1620** (artifact extensions own their UI) · sub-issue **#1624 (S6)**.

These gates make the corrected core/extension artifact-UI boundary **CI-enforced
and permanent**, so the migration waves (S4/S7/S8/S9) can shrink the host-side
surface without ever inverting the boundary again. They land **before** the first
migration — a gate protects the boundary *during* migration.

## The boundary (normative)

- **Extension-owned**: the type's detail **view** subtree, representation
  previews, presentational registry items.
- **Core-owned**: routing / authz / chrome of `/artifacts/[id]`, the **dispatch
  mechanism**, and the **never-blank floor** (generic fallback, escaped
  plain-text, markdown while deferred).
- **Violation predicate**: any production-core dependency, comparison, lookup,
  import, or data transformation **keyed by a concrete extension-owned
  presentation identity** for type-specific presentation — artifact/object type
  ids, representation forms, HITL field-renderer binding ids, and chat
  renderable-view viewTypes. **Core treats identity as an opaque input to generic
  dispatch.**

## The narrow module boundary (opaque dispatch seam)

Raw type-id / MIME / viewType access in core lives ONLY behind the **dispatch
seam** — the S2 spine: the two arbitration registries
(`@cinatra-ai/objects/artifact-renderer-registry`), the generated build map
(`src/lib/generated/artifact-renderers.ts`), and the pure precedence leaf
(`src/app/artifacts/[id]/renderer-dispatch.ts` → `pickArtifactRenderer`). Core UI
consumes an **opaque** `ArtifactRenderDispatch` and branches on `dispatch.kind`,
never on a concrete identity. Every current identity-keying site is enumerated in
the G1 baseline with a disposition; new core code must route through the seam, not
add an identity branch.

## G1 — type-identity gate (`artifact-ui-boundary-gate.mjs` + baseline)

An AST/type-aware gate (`typescript` compiler API) over **all core packages**
(`src/**`, `packages/*/src/**`; fixtures/tests/generated excluded — generated maps
are authenticated by their own manifest drift check). It detects a presentation-identity
literal (curated vocabulary from the epic's migration inventory) used in a
**keying** context (equality / `switch` case / `.startsWith|endsWith|includes|
has|get|match` / element-access key / object-literal key), plus the distinctive
chat renderable-view identifier keys.

Each arm is enumerated in `artifact-ui-boundary-gate.baseline.json` with a
**disposition**:

| disposition | carries        | meaning |
|-------------|----------------|---------|
| `MIGRATE`   | `owner`,`wave` | moves INTO its claimant extension in an S4/S7/S8/S9 wave; drop the entry in the SAME PR that removes the arm |
| `DEFER`     | `owner`,`wave` | a deferred family (markdown / mermaid) held core-side until its unblock condition |
| `STAY`      | `rationale`    | legitimately core-owned (never-blank floor, content-type sniffing, host-owned portlet React) — an allowlist disposition |

**Ratchet:** live findings must equal the baseline **exactly** (an unbaselined
live arm = UNKNOWN → fail; a baseline entry with no live arm = STALE → fail;
duplicate fingerprints fail; a hand-edited entry whose fingerprint no longer
authenticates fails). With `ARTIFACT_UI_BOUNDARY_BASE` set (CI base ref) the
committed baseline's fingerprint set must be a **subset** of the base branch's —
it may only ever **shrink**; the introducing PR (no baseline at the base ref)
carries no constraint; fail-closed on an unresolvable ref. The gate is wired into
`build-image.yml` with the SAME `steps.base.outputs.base` the sibling ratchet
gates use (core-extension-import-ban, file-size-ratchet); the absolute checks
(live == baseline, all-dispositioned, fingerprint authentication, no duplicates)
run **unconditionally**, so even in the org-wide degenerate case where the base
ref resolves to `HEAD` (self-compare), the boundary is still enforced — only the
cross-branch growth delta self-compares, exactly as for every other ratchet gate.

**Detector scope + limitations (deliberate truthfulness tradeoff).** The
vocabulary is the *enumerated* presentation identities from the epic's migration
inventory, matched in *dispatch-keying* shapes: equality / `switch` case /
`.startsWith|endsWith|includes|has|get|match` / element-access key / object key,
(all **global** across every core package), plus an **array-element**
(lookup-table) shape. The array shape is scoped to avoid false positives: for the
`.tsx`-confined **viewType / object-type** classes it is global; for
**representation MIMEs** it is confined to the artifact **rendering /
preview-serving surface** (`isRepresentationArraySurface`: `src/app/artifacts/`,
`src/app/api/artifacts/`, `src/lib/artifacts/artifact-read.ts`,
`src/lib/dashboards/portlet-`). There a MIME array IS a presentation allowlist, so
sweeping it **closes the reshape bypass** — moving an arm from `mime ===
"application/pdf"` to `["application/pdf"].includes(mime)` inside the surface is
caught as a new UNKNOWN arm. A representation-MIME array OUTSIDE that surface (LLM
attachment support in `packages/llm`, A2A protocol content in `packages/a2a`,
authoring/template lists) has the SAME vocabulary but a different purpose and is
deliberately NOT swept (it would baseline non-presentation code).

**Residual limitations (inherent to a literal-scan ratchet — shared by every
sibling gate, e.g. splitting a file past file-size-ratchet).** The gate cannot
see, and does not claim to:
- **const-aliased** comparisons (`const PDF = "…"; mime === PDF`) — needs
  data-flow, out of an AST-literal scan.
- a **genuinely new** presentation identity not yet in the vocabulary — extending
  the vocabulary is part of adding a new always-effective representation.
- an arm **reshaped into an array AND relocated to a brand-new file OUTSIDE the
  declared surface** — every CURRENT presentation arm lives in the surface (so a
  reshape-in-place is caught), but a determined author could author the reshape in
  a new non-surface file. Extending the surface is a reviewed step; a new
  presentation module is exactly what review adds it for.

The design **chooses truthfulness over completeness on these edges** — a
false-positive (blocking an unrelated LLM/A2A/authoring PR by baselining its MIME
list) is a worse failure for a CI gate than a rare, review-visible bypass, and
the AC's predicate is explicitly scoped to *type-specific presentation*, which a
fully-complete literal scan cannot honor without category-erroring non-
presentation code into the baseline. **Defense-in-depth** covers the residual: G4
+ the zero-tolerance `core-extension-import-ban` gate catch the *import* coupling a
new renderer needs; S1/S5 conformance is the extension/publish-side arm; the
migration workflow REQUIRES dropping an arm's baseline entry in the same PR that
removes it (a STALE entry fails), so a wave cannot silently keep the coupling; and
any new core→identity keying in a *recognized* shape/vocabulary still fails as
UNKNOWN. The gate's primary job — enumerate today's arms and let them only shrink
as the migrations land — is fully met.

```
node scripts/audit/artifact-ui-boundary-gate.mjs            # gate (CI)
node scripts/audit/artifact-ui-boundary-gate.mjs --report   # live arms vs baseline
node scripts/audit/artifact-ui-boundary-gate.mjs --write-baseline  # re-seed (preserves dispositions; shrink-only)
```

## G2 — per-arm cutover matrix (`@cinatra-ai/objects/artifact-ui-cutover-matrix`)

The **consumable** contract every migration wave runs an arm through BEFORE it
deletes the legacy host-side arm (and drops the G1 entry). Ten world-states:
provider-registered · enabled-and-selected · selected-via-the-correct-registry
(never cross-applied) · precedence · disabled · uninstalled · incompatible ·
failing · deterministic floor recovery · only-the-resolved-module-executes. A
viewer must resolve via the **representation-provider registry**; a semantic
renderer via **effective identity**; the two systems never share a keyspace.

```ts
import { evaluateArmCutover } from "@cinatra-ai/objects/artifact-ui-cutover-matrix";
const report = evaluateArmCutover({ system: "representation-viewer", arm: "application/pdf", observe });
expect(report.ready).toBe(true);   // only then delete the legacy arm
```

The artifact-detail surface (S4/S7) has a ready-made probe bound to the real
`pickArtifactRenderer`:
`src/app/artifacts/[id]/boundary/artifact-detail-cutover-probe.ts`.

## G3 — golden dispatch conformance (positive extensibility proof)

A synthetic fixture extension renders through the registries + generated map with
**zero core diffs** — adding a type/representation is a registry entry + a
generated-map key, never a core edit. (The **negative** — no new core→identity
keying — is owned by G1.) Tests:
`src/app/artifacts/[id]/__tests__/golden-dispatch-conformance.test.ts` (S2) and
`src/app/artifacts/[id]/boundary/__tests__/g3-golden-conformance.test.ts` (S6, end-to-end through the cutover matrix).

## G4 — import boundary (generated-maps-only)

ESLint `no-restricted-imports` layer (`eslint.config.mjs`,
`ARTIFACT_RENDERER_ENTRY_BAN`): a core module must not import an
artifact-extension renderer **entry** (`@<scope>/<x>-artifact` + subpaths). The
**sole** carve-out is the generated map `src/lib/generated/artifact-renderers.ts`
— **no** shell/floor/dispatch-seam exception. Its dynamic-`import()` path and the
authoritative all-imports enforcement are held by the sibling
`core-extension-import-ban` .mjs gate (generated-manifest-exempt, pinned zero).

## G5 — publish-side (the extension-side arm)

G1–G4 are the **host-side** arm. The **extension / publish-side** arm is the
conformance + publish checks already shipped by S1/S3/S5 — referenced here so the
boundary is closed on both sides:

- **S1** (#1621): the `cinatra.artifact.ui` sub-schema in the sdk-extensions leaf
  (`packages/sdk-extensions/src/artifact-contract.ts`) + its conformance branch —
  a `ui` key rejects at the publish gate, degrades-with-diagnostic at runtime.
- **S3** (#1622): the companion-repo fleet conformance workflow — the extension
  conformance gate (`scripts/extensions/conformance-gate.mjs`,
  `.github/workflows/extension-conformance-gate.yml`).
- **S5** (#1623): the marketplace registry publish pipeline (registryItems
  validation, per-item clean-consumer smoke, digest-pinned immutable serving).

## Gate error messages are first-class authoring guidance

Every gate names the offending construct (file:line, the concrete identity, the
keying kind / the banned import) and links this doc + the S10 authoring pack
(`docs.cinatra.ai/extensions/artifact-ui/boundary`, #1627).
