# Design-conformance functional acceptance (cinatra#985)

Manifest-driven functional-acceptance gate for the in-app design surfaces —
the L2b consumer of the conformance manifests generated from the annotated
design specs (cinatra-ai/design, L2a). Runs inside the existing
`design-visual-verify` workflow (same production-standalone boot); pixel-diff
+ axe remain supporting evidence, never the sole gate.

## What is asserted

For every surface in the pinned manifests, either:

- a **driver** exists (`contract.ts`) and the suite
  (`functional-acceptance.spec.ts`) asserts on the harness route
  `/design-fixtures/conformance` that required **fields** render bound to the
  right data, **actions** produce their specified outcomes, and required
  **state variants** exist; or
- the surface is **allowlisted** (`allowlist.json`) — a shrink-only ratchet;
- otherwise the gate is **RED** (unmapped manifest surface).

The harness mounts the REAL components through the REAL state machinery
(`resolveMarketplaceCardCta`, `deriveExtensionCompatState`, the pending-aware
install form); the only substitution is the bound server action. Server-side
install effects are owned by the seeded-fixture gate (cinatra#986).

## Spec pinning (`conformance-pins.json`)

Each manifest is pinned twice: `manifestSha256` (sha256 of the committed
verbatim generated artifact under `manifests/`) and `specContentHash` (the
manifest's embedded spec-source hash). Any mismatch is a distinct
`PIN INTEGRITY` red.

**Repo-pin fallback → published switch (no code change):** while
`source: "repo"`, the suite verifies against the committed artifact only.
Once the docs wave publishes the manifests under
`https://docs.cinatra.ai/references/design/conformance/`, flip `source` to
`"published"` — the suite then also fetches the published manifest and a
byte-hash mismatch is a distinct `UPSTREAM DRIFT` red (upstream regenerated
the manifest: review the spec change, re-pin, and adjust coverage in the same
PR).

Adopting a new upstream manifest = replace the file under `manifests/`
verbatim + update both hashes in `conformance-pins.json` in the same commit. The
committed copies are generated artifacts — **never hand-edit**.

## Stable data-testid contract (`testid-contract.json`)

Each covered surface maps to the real component file(s) that implement it and
the stable attribute literals they must carry. Enforcement:
`scripts/design/check-conformance-testids.mjs` (a design-visual-verify step)
is red when a covered surface loses its id. Renaming a contract attribute is a
**breaking change to this suite by design** — update the contract, the
drivers, and the harness together.

| Surface | Root selector | Notes |
| --- | --- | --- |
| `status-pills` | `[data-slot="status-pill"][data-status]` | real `StatusPill` (src/components/ui/status-pill.tsx) |
| `button-variants` | `[data-slot="button"][data-variant]` | real `Button` (src/components/ui/button.tsx) |
| `extension-listing-card-*` | `[data-testid="extension-listing-card"]` (carries `data-kind`) | name field: `[data-slot="extension-card-name"]`; CTA slot: `[data-testid="extension-card-cta"][data-cta-state]`; pending submit: `[data-testid="extension-card-cta-submit"][data-pending]` |

Harness-only instrumentation (fixture route, not real components):
`data-surface-id` keys one fixture instance per manifest surface;
`data-installed-version` exposes the resolver input for the
`update -> installed-latest` outcome.

## Coverage ratchet (`allowlist.json`)

Shrink-only: `scripts/design/check-conformance-ratchet.mjs` compares HEAD
against the PR base and fails on any added (or re-added) entry. To cover a
surface: add the driver + harness mount + testid contract, and REMOVE its
allowlist entry in the same PR.

## Running locally

```sh
node scripts/design/check-conformance-testids.mjs
node scripts/design/check-conformance-ratchet.mjs origin/main
pnpm test:e2e:design   # runs pixel-diff + this suite (boots pnpm dev locally)
```
