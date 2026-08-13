import { test } from "@playwright/test";

import { proveNoCredentialReachesParentSurfaces } from "../credential-egress-harness";

// ---------------------------------------------------------------------------
// cinatra#2674 (epic #2564 S8e) AC-2, REWORKED BY cinatra#2708 — Drupal.
//
// THE DRUPAL HALF EXISTS BECAUSE THE PROPERTY IS PER-PARENT, NOT PER-PRODUCT.
// The credential is held by the Cinatra frame, but "no credential reaches the
// parent origin" is a claim about a HOST PAGE: its DOM, its storage, its
// cookies, its requests. WordPress and Drupal are two different host pages, with
// different admin surfaces, different scripts on the page and different cookie
// jars, and #2708's acceptance asks for the ceremony to complete on BOTH. A
// green on WordPress alone would leave the Drupal parent unexamined.
//
// WHAT THIS SPEC PROVES, exactly: after a REAL protocol-2 sign-in and one real
// turn, no Cinatra credential is on any PARENT-ORIGIN SURFACE — not in a request
// the parent origin issued, not in its DOM, not in its localStorage or
// sessionStorage, not in its cookies (including HttpOnly ones), not in its URL
// or session history, and not in its console or error output. Six classes, each
// asserted separately, each with a UNIQUE credential-shaped canary and a
// positive control proving the check can see that class at all.
//
// WHAT IT DOES NOT PROVE: it does not watch `postMessage` / `MessagePort`
// traffic. "No parent-origin network egress" is not "the parent never SEES the
// credential" — a parent could in principle receive a value and never transmit,
// store, render or log it. That limb is DESCOPED and TRACKED IN cinatra#2708.
//
// ==================== WHY THE postMessage LIMB IS DESCOPED ==================
// THE INSTRUMENT BROKE WHAT IT OBSERVED. Measured on the host2 lane at
// 862cd5ddc (cinatra#2708):
//   • the original harness patched `Window.postMessage`,
//     `MessagePort.prototype.postMessage` and REPLACED `MessageChannel` in every
//     frame via `addInitScript`. Protocol 2 negotiates the session over exactly
//     that transport: with it installed the ceremony NEVER reached `active` —
//     180s timeout on BOTH WordPress and Drupal, against 19.7s for the identical
//     uninstrumented ceremony;
//   • a rewrite that wrapped the app's OWN handler
//     (`MessagePort.prototype.addEventListener` + the `onmessage` setter) instead
//     of adding a listener STILL perturbed: one ceremony ran 120s and stalled at
//     the same point, the port handover after the popup closed, while its own
//     positive control proved the recorder worked.
// DO NOT REINTRODUCE ACTIVE PORT INSTRUMENTATION HERE. Everything this spec uses
// is passive: out-of-process request/console recorders and post-hoc reads.
//
// RUN IT WITH:
//   pnpm exec playwright test -c tests/e2e/config/wp-drupal-uat.config.ts \
//     --project=drupal credential-egress-uat
// ---------------------------------------------------------------------------

test.describe("cinatra#2674 S8e AC-2 — Drupal parent-origin surfaces", () => {
  test("no Cinatra credential reaches a parent-origin surface (network, DOM, storage, cookies, URL/history, console)", async ({
    page,
  }) => {
    // The ceremony has its OWN budget (helpers.CEREMONY_BUDGET_MS) and fails on
    // it; this ceiling only has to be larger than ceremony + turn + six surface
    // proofs, so a real stall is still named by the budget and not by this.
    test.setTimeout(240_000);
    await proveNoCredentialReachesParentSurfaces(page, "drupal");
  });
});
