# Design-conformance functional acceptance (cinatra#985 + cinatra#986)

Manifest-driven functional-acceptance gate for the in-app design surfaces —
the L2b consumer of the conformance manifests generated from the annotated
design specs (the design-system source of truth, L2a) — extended by the
seeded data-contract gate (cinatra#986). Runs inside the existing
`design-visual-verify` workflow (same production-standalone boot); pixel-diff
+ axe remain supporting evidence, never the sole gate.

## What is asserted

For every surface in the pinned manifests, either:

- a **driver** exists (`contract.ts`) and the suite
  (`functional-acceptance.spec.ts`) asserts on a harness route
  (`/design-fixtures/conformance`, or `/design-fixtures/conformance/seeded`
  for the seeded data-contract surfaces) that required **fields** render
  bound to the right data, **actions** produce their specified outcomes, and
  required **state variants** exist; or
- the surface — or, since cinatra#986, an individual **aspect** of it — is
  **allowlisted** (`allowlist.json`) — a shrink-only ratchet;
- otherwise the gate is **RED** (unmapped manifest surface / an annotated
  field binding, action, or state variant with no assertion).

The harnesses mount the REAL components through the REAL state machinery
(`resolveMarketplaceCardCta`, `deriveExtensionCompatState`, the pending-aware
install form, `resolveReadinessFailSoft`, the URL-driven server filters); the
only substitutions are the bound server action (cards/modal), the storefront
detail fetch (injected loader, §V fixture convention), and — on the seeded
harness — the session/actor visibility scoping plus the per-kind display
hydration (native descriptor sources are build-time catalogs, not seedable
data). Every substitution is documented at its mount.

## Seeded fixture kit (cinatra#986)

`src/app/design-fixtures/conformance/seed-data.ts` is the deterministic,
dependency-free kit behind `/design-fixtures/conformance/seeded`:

- **Anti-lookalike seeds** — competing sources get DISTINCT values (every
  `displayName` shares no token with its `packageName`/`slug`), so a
  wrong-source binding (e.g. rendering the package slug where the manifest
  binds `displayName`) is a red, never a lookalike pass.
- **Exact cardinality** — every cardinality-bearing surface (the marketplace
  grid, the installed list per status, the connector grid per connection
  state) asserts an EXACT count against the kit, and counts of confusable
  collections are pairwise distinct (6 / 4 / 2 / 3 / 5).
- **Forced state variants** — empty (empty catalog / never-provisioned
  namespace), loading (the REAL Suspense fallback over a delayed source,
  `?variant=loading`), error (the REAL cinatra#110 fail-soft containment on a
  throwing readiness probe), and per-kind variants (the #985 card surfaces).

**DB-backed surfaces:** installed-extensions-list/-filter render from the
REAL canonical `installed_extension` store. CI runs an ephemeral Postgres
service; `POST /design-fixtures/conformance/seed { runId }` provisions the
`@cinatra-e2e/<runId>--` namespace through the REAL lifecycle primitive.
Provisioning is idempotent and CONVERGING (extra/stale namespace rows are
removed), so retries and shards sharing a run id cannot cross-contaminate
exact-count assertions; `DELETE` with the same body cleans a namespace up.
The run id comes from `CINATRA_CONFORMANCE_RUN_ID` (CI: run id + attempt;
locally "local"). The endpoint refuses to exist in production unless the
documented `CINATRA_E2E_SETUP_BYPASS` e2e switch is set (the same
reachability contract as the fixture routes, `src/lib/auth-route-guard.ts`).

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

Shrink-only, at **(surface, aspect)** granularity since cinatra#986: an entry
without `aspects` exempts the whole surface; an entry with
`aspects: ["field:<name>" | "action:<name>" | "state:<state>", ...]` exempts
ONLY those aspects of an otherwise-covered surface — every other annotated
field binding, action, or state variant with no assertion is a red.
`scripts/design/check-conformance-ratchet.mjs` compares HEAD against the PR
base and fails on any added or WIDENED exemption; narrowing a whole-surface
entry to aspects, and removing entries/aspects, always passes. To cover a
surface (or aspect): add the driver + harness mount + testid contract, and
REMOVE the corresponding exemption in the same PR.

## Running locally

```sh
node scripts/design/check-conformance-testids.mjs
node scripts/design/check-conformance-ratchet.mjs origin/main
pnpm test:e2e:design   # runs pixel-diff + this suite (boots pnpm dev locally)
```

The seeded data-contract surfaces additionally need a reachable
`SUPABASE_DB_URL` (the suite auto-provisions the "local" run namespace via
the seed endpoint). Without one, the seeded harness renders an explicit
`installed-extensions-store-unreachable` panel and only the DB-backed
surfaces fail (with that diagnosable reason); the dataless surfaces still
pass.
