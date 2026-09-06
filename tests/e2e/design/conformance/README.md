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

**The seed endpoint needs a presented capability.** Its writes are real
lifecycle writes and it is exempt from the sign-in redirect, so reachability
is not authorization: the endpoint answers 404 to every caller unless
`CINATRA_CONFORMANCE_SEED_TOKEN` (at least 32 characters) is armed on the
server AND presented by the caller as `Authorization: Bearer ...`, from a
request whose forwarded chain names no hop from off the machine. CI mints one
per run; to run this suite locally, arm the same value in the server's
environment and in the shell running Playwright:

```sh
export CINATRA_CONFORMANCE_SEED_TOKEN="$(openssl rand -hex 32)"
```

The fence and the reasons for each of its three refusals live in
`src/lib/test-support/conformance-seed-fence.ts`.

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

**A pin that stops matching what is published is a distinct, separately gated
fact** (cinatra#3057): the `design-pin-drift` job in `gates.yml` fetches every
published manifest on each pull request and on every push to `main` and reports
`drift` / `http-failure` / `invalid-json` / `schema-failure` / `match` per pin,
so a moved upstream manifest can no longer sit unnoticed behind a `source:
\"repo\"` pin. It never moves a pin: a pin moves only in the issue that ADOPTS
the change, drivers and harness mounts included, and a hash-only re-pin is
refused. See
[`docs/internals/contracts/design-conformance-pin-drift.md`](../../../../docs/internals/contracts/design-conformance-pin-drift.md).

## Committed but not yet pinned: what a wave may drive

A drawing whose manifest is committed under `manifests/` but is NOT named in
`conformance-pins.json` is mid-adoption: one wave at a time lands its drivers,
and the pin — the ratchet — is granted only once every surface of that drawing
is covered. Until then `functional-acceptance.spec.ts` generates the same
battery for the surfaces that DO have a driver, and a surface no wave has
reached yet simply has no test.

That is not a licence to write a driver for a surface the product does not have
yet. The standing rule for every adoption wave:

- **Ground first.** Before driving a surface, check each of its declared
  fields, actions and states against the DEFAULT BRANCH's shipped behaviour.
- **Never approximate.** A surface whose behaviour is still on an open pull
  request is not stubbed, not monkeypatched, and not driven through a different
  control that happens to exist. It goes on that wave's surface-readiness list,
  named with the pull request that lands it, and is driven in a later wave.
- **A driver that cannot fail is worse than no driver.** A green test over a
  surface the product does not draw reports coverage the pin is later granted
  for.

The mechanical check for the second rule is already here: every control a driver
presses is a required literal in `testid-contract.json` against the source file
that ships it, so a driver naming a control the product does not ship is red in
`scripts/design/check-conformance-testids.mjs` before a browser opens.

### The artifact-kind review cards

Worth knowing before planning a wave over the in-conversation review cards. The
review-gate card draws NO DOM until an authorised server resolve has answered,
and every per-kind reading of a review target is drawn by a SERVER component
inside the card's own credentialed island frame. Neither is reachable from a
props-only harness mount, and no transport substitution is permitted in this
harness. So a per-kind review card becomes drivable only once its own display
ships AND the floor action it declares ships; until then it is
surface-readiness work rather than driver work, however complete the drawing
around it is.

What IS drivable over these cards today is the part that is not per-kind at all:
the immutable target header, which the card draws itself above the island and
draws identically over every kind. W1 drives it for seven of the eight surfaces
through one family factory over one fixture list, mounted props-only over the
shipped header component. The rows seed a stored artifact row and never a
finished reading — the product's own surface model words the type tag, elides
the pinned revision and composes the authorized row facts — so the driver
exercises the chain composer to component rather than a component printing back
what it was handed. The eighth surface stays out of the family on purpose: a
pointer's drawn identity says it is not pinnable and is never a review target,
while the shipped header draws the pinned marker unconditionally, so driving it
here would assert of it a header the drawing says it never has. It takes no
driver and no allowlist entry.

### The readiness list is data, and it is checked

A readiness list is a claim about the PRODUCT — "no control carries this action
today" — so it goes stale the moment the product moves, and a stale one quietly
tells the next wave to skip a surface that is now real. So the list lives in
[`surface-readiness.json`](surface-readiness.json), one entry per aspect a wave
grounded and could not drive, and
`scripts/design/__tests__/surface-readiness.test.mjs` re-proves every entry
against the tree on every root run:

- a listed surface is a real surface of the manifest its wave names;
- a listed surface is never ALLOWLISTED — a whole-surface exemption is the one
  thing no driver makes acceptable — and never carries a driver written for it
  alone, which could bind any aspect it liked;
- a listed surface MAY be driven for a reading that is not one of the aspects it
  lists. W1 is the first case: seven of its eight surfaces are driven for the
  immutable target header the review screen's drawing declares at §IV, the one
  reading those kinds share and the one the default branch already draws. Where
  that happens the guard re-proves three things from source — the driver is the
  shared header-only family, the surface's testid coverage is that family's
  shared anchor and nothing of its own, and the family declares no field, action
  or state binding whatsoever — so a driver that ever grew one goes red here
  instead of quietly contradicting an entry that still calls the aspect
  unshipped. The wave records what it drives in its `driven` block, and that
  block is held to the family's actual registration in both directions, so it
  can neither miss a surface the family took nor claim one it did not;
- a listed action is genuinely unshipped: no first-party product module spells
  out the action-and-outcome attribute the manifest declares, in the same
  literal form the testid contract requires everywhere else. The moment one
  does, the test goes RED and the wave that landed it has to drive the surface
  or restate the entry;
- a listed non-action aspect names a reason from a closed set, so "not yet" can
  never be free text — and the two reasons the tree can decide are DECIDED, not
  taken on trust: a kind said to register no display is re-proved against the
  generated artifact-renderer registry, and a surface said to be drawn nowhere
  is re-proved against the conformance anchors in first-party source;
- a wave that names its surfaces accounts for every field, action and state
  those surfaces declare, and records nothing the manifest does not declare, so
  an aspect can be dropped neither by omission nor by invention — outcomes and
  field sources are compared, not just names.

The list therefore retires itself rather than being forgotten.

What it does NOT prove, so that no reader credits it with more: the source scan
is textual and reads the conformance attribute exactly as the testid contract
spells it, so a control written against a different convention is caught by the
testid-contract check rather than here; and `island-rendered` is an
architectural reading no text scan can decide, left as prose on purpose.

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
pnpm test:e2e:design        # runs the families your diff can affect
pnpm test:e2e:design:plan   # prints that selection without running anything
DESIGN_SELECT=all pnpm test:e2e:design   # every family, as CI runs it on main
```

`pnpm test:e2e:design` no longer runs every family every time. It first runs
`scripts/ci/design-select.mjs`, which diffs against the merge base with
`origin/main` and picks the spec families whose own graph (the spec file, the
`/design-fixtures` routes it drives, and everything those import) contains a
changed file. That graph follows the ROOT layout and the tsconfig aliases
back into the workspace packages, so a module a fixture reaches only
indirectly still selects its families. A change with no UI in it runs no
Playwright at all; a shared
primitive, a workspace package, a stylesheet, a dependency, a pinned manifest,
an app layout or an unresolvable diff base runs every family. `DESIGN_SELECT=all`
forces the whole suite, and a golden-refresh run (`RENDER_PARITY_UPDATE=1`,
`RENDER_PARITY_VISUAL=1`, `test:e2e:design:update`) is never narrowed.

The seeded data-contract surfaces additionally need a reachable
`SUPABASE_DB_URL` (the suite auto-provisions the "local" run namespace via
the seed endpoint). Without one, the seeded harness renders an explicit
`installed-extensions-store-unreachable` panel and only the DB-backed
surfaces fail (with that diagnosable reason); the dataless surfaces still
pass.
