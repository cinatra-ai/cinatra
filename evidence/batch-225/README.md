# Batch 225 — combined browser UAT (PR #2563)

Browser UAT for the five fixes in PR #2563, run on a real Chromium against a
real dev boot of this branch. One dev server, one browser, `workers=1`.

- Branch head under test: `c87db639d4b2e3068842d35d79e96647d1e04d98`
  (base `b07cca458`).
- Surface: `pnpm dev` on a lane port, dedicated database on the standing verify
  Postgres, dedicated Redis, the pinned companion extension tree
  (`sync-dev-extensions.mjs --pinned`, 111/111).
- Result: **4 PASS, 1 NOT REPRODUCIBLE.** Item 4 (#2546) could not be verified in
  the browser at all — the condition the fix addresses does not arise on this
  build, so this run neither confirms nor refutes it. Item 3 passed on the only
  branch a browser can reach today. Detail per item below.

## Item map

| # | Issue | Assertion | Verdict | Captures |
|---|-------|-----------|---------|----------|
| 1 | #2526 | An assistant/chat error naming an in-app route renders it as a clickable SAME-TAB link that navigates; a provider URL in the same message still opens externally. | PASS | `2526-chat-error-card.png`, `2526-after-same-tab-navigation.png` |
| 2 | #2528 | The Setup title and the Cinatra mark render on one line at both acceptance widths. | PASS | `2528-setup-header-1440.png`, `2528-setup-page-1440.png`, `2528-setup-header-390.png`, `2528-setup-page-390.png` |
| 3 | #2534 | The tunnel tab's flyout renders the paste remediation on the reachable branch, with the old "tailnet not resolved — reconnect" sentence absent from that branch. | PASS (reachable branch only) | `2534-tunnel-tab.png`, `2534-tunnel-flyout.png` |
| 4 | #2546 | The collapsed-sidebar tooltip on the top rail item renders fully visible above the sticky header. | **NOT REPRODUCIBLE** — not verifiable in the browser on this build | `2546-collapsed-tooltip-vs-header.png` |
| 5 | #2548 | With an injected fetch rejection on the threads endpoint the panel shows the error state with "Try again", and a subsequent successful fetch recovers the list. | PASS | `2548-threads-error-state.png`, `2548-threads-recovered.png` |

## What each item actually asserted

### 1 — #2526 (`2526-chat-error-card.png`, `2526-after-same-tab-navigation.png`)

Error text delivered over the endpoint's own documented pre-stream rejection
shape (HTTP 400 + `code: "llm-provider-unavailable"`), which
`turnRejectionMessage()` admits and surfaces verbatim into the shipped
`ErrorCard` / `FriendlyErrorBody`. Only the transport is stubbed — the
linkification, the anchor attributes and the navigation are entirely the app's.

Message used:

```
Cinatra MCP public URL is not configured for hosted MCP access.
Set it at /configuration/development?tab=tunnel.
Provider status: https://status.openai.com/incidents/uat2563.
```

- `a[href="/configuration/development?tab=tunnel"]` is present and its `target`
  attribute is **null** (same tab).
- `a[href="https://status.openai.com/incidents/uat2563"]` carries
  `target="_blank"` and a `rel` containing `noopener`.
- Clicking the in-app link navigated the SAME tab to
  `/configuration/development?tab=tunnel`; the browser context page count was
  unchanged across the click.

### 2 — #2528 (`2528-setup-header-*.png`, `2528-setup-page-*.png`)

Measured on `/setup/account` in the zero-user state — the only state in which a
`/setup/*` route renders its own chrome (an authenticated visitor is redirected
forward and a sessionless one is bounced to `/sign-in` once an account exists),
and the fresh-instance surface the issue was filed on.

Acceptance widths: **1440** (the width the setup-acceptance suite pins) and
**390** (narrowest supported mobile).

| Width | title centre Y | mark centre Y | delta | vertical overlap |
|-------|----------------|---------------|-------|------------------|
| 1440  | 62.70 | 62.70 | **0.00 px** | 22.08 px |
| 390   | 62.70 | 62.70 | **0.00 px** | 22.08 px |

Pass condition was delta <= 2 px and a strictly positive vertical overlap of the
two boxes.

### 3 — #2534 (`2534-tunnel-tab.png`, `2534-tunnel-flyout.png`)

Precondition seeded: the `tailscale-connector` extension activates from the
pinned companion tree and registers the `dev-tunnel-status` capability; its own
persisted local settings row (`connector_config:tailscale`) was seeded to
`{"connected":true}` with **no tailnet**, which is exactly issue #2534's reported
condition (Tailscale connected, no Funnel URL preview). Nothing about the copy
under test is stubbed.

Rendered flyout state was `data-funnel-preview-state="unknown"` — the
cause-agnostic branch, which is the branch reachable today because the connector
does not yet emit a reason code. Copy rendered:

> TAILSCALE: No Funnel URL is available for this instance. The tailnet may not be
> resolved yet, or this instance may have no sanctioned Tailscale identity —
> reconnecting the connector does not help in the second case. Paste an
> externally reachable HTTPS URL below — for example a Funnel you already run on
> this host.

- Contains the paste remediation.
- Does **not** contain the old sentence "tailnet not resolved yet — reconnect the
  Tailscale connector to refresh".

Scope limit: this checks the `unknown` branch only — the one branch a browser can
reach today. The three reason-coded branches were not exercised in the browser
because the connector does not emit a reason code yet; they are covered by
`src/app/configuration/development/__tests__/funnel-preview-notice.test.tsx`.
The precise-reason legs stay out of scope until the connector emits the code (the
PR says the same, and uses `Refs #2534`, not `Closes`).

### 4 — #2546 (`2546-collapsed-tooltip-vs-header.png`)

Sidebar collapsed, top rail item hovered, tooltip measured against the sticky
header (`[data-testid="app-shell-topbar"]`).

```
top rail item  = "Chat"
tooltip box    = x 47.74, y 74.19, w 49.86, h 27.63
header box     = x 48.00, y 0.00,  w 1392.00, h 64.00
intersects header = false
computed z-index  = tooltip 210, header 140
hit-test probes   = 9/9 resolve to the tooltip, 0/9 resolve to the header
```

**Verdict: NOT REPRODUCIBLE — this item is not verified by this UAT.**

The issue named Approvals and Configuration as the clipped top-of-rail items.
Both have since moved out of the sidebar to the top-bar cog (cinatra#1563), so
today's top rail item is "Chat", which sits below the 64 px header band. The
tooltip does not geometrically overlap the header at all, so the browser can
never observe which of the two paints on top: the clipping the fix addresses
cannot occur on this build, and a run that cannot produce the failure cannot
prove the fix either. The z-index and hit-test numbers above are real
measurements, but with zero overlap they are trivially satisfied and are NOT
evidence that the stacking fix works where it matters.

What this run does establish: nothing about the tooltip renders wrong today, and
no regression was introduced on the surface as it currently stands.

The actual pin for this fix is the unit test
`src/components/__tests__/tooltip-stacking.test.ts`, which asserts the tooltip
sits above every layer that can host a trigger and fails if the header is
re-banded above it. That test — not this item — is what should carry the
merge decision for #2546.

### 5 — #2548 (`2548-threads-error-state.png`, `2548-threads-recovered.png`)

`fetchChatThreads` is a server action, so the "threads endpoint" on the wire is
the POST to the chat route carrying a `next-action` header. Exactly **one** such
request was failed — the first, fired when the Threads panel opens; the retry ran
against the real server.

- After the injected rejection: the panel renders "Couldn't load your threads."
  plus a **Try again** control, and zero occurrences of "Loading…".
- After clicking Try again: the seeded thread row appears and the error copy is
  gone.

A single durable thread was seeded for the viewer so the recovery leg lands on a
populated list rather than the empty state.

## Harness

The Playwright config and specs that produced these captures were lane-local and
are deliberately not committed — this PR carries evidence only, no test-surface
changes. They lived at `tests/e2e/config/uat-2563.config.ts` and
`tests/e2e/uat-2563/*.spec.ts`, built on the repo's existing e2e patterns
(`tests/e2e/config/base.ts`, the render-smoke auth setup, and the agents-run
`waitForHydration` + `insertText` composer pattern).
