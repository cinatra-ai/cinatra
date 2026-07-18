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

**Still out of scope — after S5 (#1221) / S4 (#1220), called out on the PR:**

- Live-run targets **(2)/(3)** — the generic embedded conversation-view and the
  WordPress / Drupal iframes — and their cross-target DOM + visual equality (the
  full three-target compare). The async seam is here; those targets only
  implement it, **after S5 embeds the widgets**.
- The #1214 no-direct-egress assertion inside the **embedded** E2E (an S5
  surface, not `/chat`).
- The DOM/visual render-compare of the AG-UI interactive layer (tool-call chips,
  HITL forms, `RUN_ERROR`, the change-diff component). Those components land in
  S4 (#1220); this slice schema-locks their wire fixtures now so they cannot
  drift from the S1 contract before the components exist.
```
