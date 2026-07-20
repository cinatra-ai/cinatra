# Render-parity conformance (epic S6, cinatra#1222)

Automates render-parity so **"exactly like `/chat`" cannot silently drift**.
One fixture corpus is rendered through the S3 packaged renderer
(`@cinatra-ai/chat/renderer`, merged in #1228) — the exact code path `/chat`
renders through — and the harness fails on any DOM divergence from committed
goldens.

This is the **static-fixture slice** the epic authorizes to start now
(fixtures against the S1 contract + S3 renderer). The live-run three-target
compare comes after S2/S5 — see [Scope](#scope).

## How it rides existing CI (no `.github` edits)

The spec lives under `tests/e2e/design/conformance/**`, which the
`design-conformance-functional` Playwright project matches
(`tests/e2e/config/design.config.ts`) and `design-visual-verify.yml`
path-gates on (`tests/e2e/design/**`). It rides that workflow exactly as the
header-rule gate did — no workflow file is added or edited. The parity checks
are pure Node + a headless DOM parse; they do not navigate the app, so they run
regardless of the app web server.

## Layout

```
render-parity/
  corpus.ts                     # the corpus: content + hostile cases + the reused S1 AG-UI corpus
  normalize.ts                  # domNormalize(): in-browser DOM canonicalization for compare
  render-parity.spec.ts         # the conformance spec (rides design-conformance-functional)
  targets/
    target.ts                   # RenderTarget seam — WP/Drupal/embedded targets plug in here later
    packaged-renderer-target.ts # the S3 packaged renderer = the reference target
  fixtures/
    content/*.md                # well-formed checklist content (tables, code, math, lists, links, embeds)
    hostile/*.md                # unsafe links, raw HTML, broken fences, incomplete embeds, streaming-partial
  __goldens__/
    content/<case>.<theme>.html # DOM goldens (the reference target's output), per theme
    embeds.detection.json       # chart/mermaid detection + schema-validation golden
  __screenshots__/              # opt-in visual baselines (see below)
```

The **AG-UI event sequences + the change-diff `DATA_PART`** are not duplicated
here — they are reused verbatim from the S1 conformance surface
(`@cinatra-ai/agent-ui-protocol/conformance` `CONFORMANCE_CORPUS`), whose authors built it
for this stage. This slice schema-locks that corpus against the S1 wire
contract.

## What is enforced (deterministic — safe on any OS)

1. **Content render parity** — every content + hostile fixture, both themes,
   DOM-normalized-compared against its golden. Any drift in the shared S3
   renderer turns this red.
2. **Embed-detection parity** — chart/mermaid detection + schema validation
   locked to `embeds.detection.json`.
3. **AG-UI corpus schema conformance** — every corpus event validates against
   the S1 contract (`isAgUiEvent`/`analyzeEventLog`); the change-diff
   `DATA_PART` validates as a well-formed renderable view; an unknown `viewType`
   is a safe forward-compat fallback.

"DOM-normalized" is genuine: `domNormalize` parses both the golden and the
freshly rendered candidate in the browser's own HTML parser, then re-serializes
canonically (attributes sorted, insignificant whitespace collapsed, `pre`/`code`
whitespace preserved).

## Regenerating baselines

DOM + detection goldens (regenerate after an **intentional** renderer change):

```
RENDER_PARITY_UPDATE=1 pnpm test:e2e:design
```

Visual snapshot baselines (opt-in — see below):

```
RENDER_PARITY_VISUAL=1 pnpm test:e2e:design:update
```

### Why visual snapshots are opt-in

The visual layer is gated behind `RENDER_PARITY_VISUAL` and does **not** run in
CI by default. Text-dense fixtures accumulate cross-OS anti-aliasing drift that
can exceed the pixel threshold and flake, and this slice renders through a
minimal self-contained stylesheet rather than the full app shell (full-fidelity
token styling is part of the live-run slice, which drives the real surface). The
**DOM-normalized compare is the hard gate**; visual snapshots are regenerable
supporting evidence you can turn on locally.

## Scope

**In scope (the static-fixture slice):** the fixture corpus, the DOM-normalized
compare harness against the S3 packaged renderer as the reference target, wiring
into the existing design-conformance CI, and documented + regenerable baseline
generation.

### Live-run target (1): `/chat` — LANDED (S2-enabled)

S2 (#1218, delivered by #1752) put `/chat` on the unified wire + the first-class
structured-thread persistence route, which unblocks the **first** live-run
target. It is implemented as an async target against the same seam
(`AsyncRenderTarget` in `targets/target.ts`) and lives in the agents-run live
suite (it needs the real authenticated app), NOT this static dir:

```
tests/e2e/agents-run/
  chat-render-parity-target.ts   # the live /chat AsyncRenderTarget: seed a thread
                                 # via POST /api/assistants/threads, load /chat/<id>,
                                 # scrape the rendered assistant content block
  chat-render-parity.spec.ts     # drives the SAME corpus + goldens; DOM-normalized
                                 # compare of the RUNNING surface vs the S3 golden
```

It is a **gated** live spec (peer to `chat-mcp` / `chat-prompt-hitl`): it needs
the canonical schema + a real session, so it runs on the stack, not per-PR.
Unlike those it is **deterministic and cost-free** — the content is a SEEDED
thread, not a live LLM turn. Run it on the verify stack or via the
`e2e-app-suites` dispatch:

```
pnpm exec playwright test --config tests/e2e/config/agents-run.config.ts \
  --project chat-render-parity
```

Ten of the eleven content/hostile fixtures compare byte-identically to the
committed goldens (the live surface calls the SAME `renderMarkdown`); the one
exception — `code`, which `/chat` async-hydrates via shiki — is reconciled by
`canonicalizeCodeBlocks` (`normalize.ts`), whose invariance is proven
**server-free in per-PR CI** by `render-parity-live-normalize.spec.ts` in this
dir (it rides `design-conformance-functional`, no app boot).

### Three-target compare engine + live targets (2)/(3) — LANDED (this lane, #1222 live-run)

The three-target divergence gate now rides a target-agnostic engine:

```
render-parity/
  cross-target-compare.ts        # PURE divergence engine: compare N targets' DOM-normalized
                                 # renders vs the reference; report WHICH target/fixture/theme drifted
  cross-target-compare.spec.ts   # per-PR (design-conformance-functional): proves the gate
                                 # FAILS on any divergence — normalization robustness (no false RED),
                                 # a real drift caught + localized, a missing render = hard failure
tests/e2e/agents-run/
  render-parity-live-targets.ts  # generic embedded view (target 2) as a seeded-thread AsyncRenderTarget,
                                 # with an explicit probe() — never a silent skip
  render-parity-cross-target.spec.ts  # gated live: embedded view vs the S3 reference via the engine
```

The compare depth (converged with Codex): **structural DOM equality is the hard
gate**; the visual screenshot layer stays opt-in (`RENDER_PARITY_VISUAL`) so
cross-OS anti-aliasing never blocks the deterministic gate. The per-PR engine
spec proves the gate's core promise ("fails on ANY divergence") **without any
live surface**, so both epics (#1216 + #1037) are gated deterministically today.

**Target (2) — generic embedded conversation-view (`/embed/assistant`):** the
async target + gated spec are implemented and wired
(`render-parity-cross-target` project). They drive the SAME shared renderer as
`/chat` and compare via the engine. The embed CORE (bridge protocol +
frame-ancestors) merged **INERT in #1848 ("library-only, no route")**; until the
`/embed/assistant` page slice lands, `probe()` reports the route unavailable and
the spec **skips with that exact reason** — honest, never a false green. The leg
enforces automatically the moment the route is live.

**Target (3) — WordPress / Drupal CMS iframe** + the **#1214 no-direct-egress
assertion**: the egress assertion is LANDED live inside the embedded E2E — see
`tests/e2e/wp-drupal-uat/helpers.ts` (`trackNoDirectCmsEgress`), wired into the
WordPress + Drupal edit round-trips. It proves the CLIENT half a browser can
observe (the widget issues **zero** direct `/wp/v2` · `/jsonapi` content
mutations on the agent timeline — the edit routes server-side over MCP) while
the sanctioned cinatra `/stream` POST fires (positive control). The AUTHORITATIVE
server-side ban is the static AST guard
(`src/lib/__tests__/in-admin-cms-egress-guard.test.ts`). The full CMS-iframe
render-parity leg additionally needs the docker WP/Drupal + wayflow compose
profile (host port 3010) AND the `/embed/assistant` iframe it frames; it enforces
once that route lands.

### CI wiring

- **Per-PR hard gate** (no `.github` edit): the corpus compare + the three-target
  ENGINE conformance + the AG-UI schema locks ride `design-visual-verify.yml`
  via this `tests/e2e/design/conformance/**` path — this is the gate for **both**
  epics.
- **On-demand lane**: `.github/workflows/render-parity.yml`
  (`workflow_dispatch`-only, stock `ubuntu-latest`, no paid runner) runs the
  deterministic leg; never a second required check.
- **Local runner**: `node scripts/render-parity/run.mjs [static|live|all]`
  (`pnpm test:render-parity`).
- **Live legs**: the gated `agents-run` projects `chat-render-parity` +
  `render-parity-cross-target`; the CMS iframe + egress legs ride the
  `wp-drupal-uat` gate.

**Still out of scope — after S4 (#1220):** the DOM/visual render-compare of the
AG-UI interactive layer (tool-call chips, HITL forms, `RUN_ERROR`, the
change-diff component). Those components land in S4; this corpus schema-locks
their wire fixtures now so they cannot drift from the S1 contract before the
components exist.
```
