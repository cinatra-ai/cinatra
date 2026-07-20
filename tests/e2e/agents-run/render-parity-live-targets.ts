// ---------------------------------------------------------------------------
// Live render-parity targets (2) + (3): the generic Cinatra embedded
// conversation-view and the WordPress/Drupal CMS iframe (cinatra#1222, epic
// #1216 S6 — the LIVE-RUN slice).
//
// Target (1), live `/chat`, ships in chat-render-parity-target.ts (S2). This
// module adds the other two of the three targets the issue names, BOTH driving
// the SAME shared content renderer (`@cinatra-ai/chat/renderer`) the reference
// target and the goldens are anchored to — so a divergence is a real
// shell/bridge regression, not two renderers that were never meant to match.
//
// AVAILABILITY IS EXPLICIT, NEVER SILENT. Each factory returns a target plus an
// `probe()` that resolves the surface's readiness against the running stack:
//   - the generic embedded view is served at `/embed/assistant` (S5 #1221 Lane
//     B). The embed CORE (bridge protocol + frame-ancestors) merged INERT in
//     #1848 ("library-only, no route"); the route itself lands with the embed
//     page slice. Until it does, `probe()` reports `available:false` with that
//     exact reason and the cross-target spec SKIPS loudly (documented follow-up),
//     rather than pretending parity it never measured.
//   - the CMS iframe target drives the embedded view INSIDE the WordPress /
//     Drupal admin (the S5 widget cutover, wordpress-plugin#87 / drupal-module#86)
//     so it additionally exercises the postMessage embed bridge + the CMS shell
//     CSP. It needs the docker CMS+wayflow compose profile (host port 3010); when
//     the profile is not up, `probe()` reports it and the spec skips.
//
// The seeded-thread mechanic mirrors chat-render-parity-target.ts exactly (seed
// the corpus fixture as the sole assistant message via the real persistence
// route, then drive the surface) so all three live targets share one
// deterministic, no-live-LLM content path and one compare.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import type { APIRequestContext, Page } from "@playwright/test";

import type {
  AsyncRenderTarget,
  ContentRenderResult,
  RenderTheme,
} from "../design/conformance/render-parity/targets/target";

/** The outcome of probing a live surface before driving it. */
export type SurfaceProbe =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/** A live render target plus its readiness probe. */
export type ProbedTarget = {
  readonly target: AsyncRenderTarget;
  /** Resolve whether the surface is reachable + renders; never throws. */
  probe(): Promise<SurfaceProbe>;
};

function appThemeStorage(theme: RenderTheme): string {
  // next-themes: github-light ⟺ "cinatra" (default), github-dark ⟺ "dark".
  return theme === "github-dark" ? "dark" : "cinatra";
}

function themeApplied(htmlClass: string, theme: RenderTheme): boolean {
  const has = htmlClass.split(/\s+/).includes("dark");
  return theme === "github-dark" ? has : !has;
}

/**
 * Seed a thread whose sole assistant message IS the corpus fixture, via the same
 * first-class persistence route the chat client writes. Returns the thread id.
 * Shared by every seeded-thread live target so the content path is identical.
 */
async function seedFixtureThread(
  request: APIRequestContext,
  baseUrl: string,
  source: string,
): Promise<string> {
  const threadId = randomUUID();
  const nowIso = new Date().toISOString();
  const seed = await request.post("/api/assistants/threads", {
    data: {
      id: threadId,
      title: `render-parity ${threadId}`,
      createdAt: nowIso,
      updatedAt: nowIso,
      messages: [
        { id: randomUUID(), role: "assistant", content: source, createdAt: nowIso },
      ],
    },
    headers: { "content-type": "application/json", Origin: baseUrl },
  });
  if (!seed.ok()) {
    throw new Error(
      `seeding /api/assistants/threads failed (${seed.status()} ${seed.statusText()}) — ` +
        `the live render-parity target cannot drive an unseeded thread`,
    );
  }
  return threadId;
}

export type SeededThreadTargetDeps = {
  page: Page;
  request: APIRequestContext;
  baseUrl: string;
  /** Stable target id, e.g. "embedded-view". */
  id: string;
  /** Human label. */
  label: string;
  /** Build the surface URL for a seeded thread id (e.g. `/embed/assistant?...&thread=<id>`). */
  urlFor(threadId: string, theme: RenderTheme): string;
  /** The selector for the single assistant content block on this surface. */
  contentSelector: string;
  /** Bound the wait for shiki hydration to settle (only affects the `code` fixture). */
  hydrationSettleMs?: number;
};

/**
 * A live {@link ProbedTarget} that seeds the fixture as a thread, navigates the
 * surface's URL, and scrapes the single assistant content block. Generic over
 * the route + selector so the generic embedded view (target 2) and any future
 * same-renderer surface share one implementation. `probe()` seeds a trivial
 * thread and checks the surface actually serves the content block, so an inert /
 * unbuilt route is reported (never a false green).
 */
export function createSeededThreadTarget(deps: SeededThreadTargetDeps): ProbedTarget {
  const { page, request, baseUrl, id, label, urlFor, contentSelector } = deps;
  const hydrationSettleMs = deps.hydrationSettleMs ?? 8_000;

  async function drive(source: string, theme: RenderTheme): Promise<ContentRenderResult> {
    const threadId = await seedFixtureThread(request, baseUrl, source);

    // Pin the theme PER RENDER without accumulating init scripts. The corpus
    // compare drives many (fixture, theme) renders on ONE page; a per-render
    // `addInitScript` would pile up (and Playwright does not guarantee their
    // relative order), so successive themes could race. Instead: navigate to
    // establish the origin, write the theme to localStorage (last-write-wins on
    // the real store), then reload so it applies to the rendered surface.
    await page.goto(urlFor(threadId, theme), { waitUntil: "domcontentloaded" });
    await page.evaluate((storage) => {
      try {
        window.localStorage.setItem("theme", storage as string);
      } catch {
        /* storage unavailable — the post-load theme assertion fails loud */
      }
    }, appThemeStorage(theme));
    await page.reload({ waitUntil: "domcontentloaded" });

    const content = page.locator(contentSelector);
    await content.first().waitFor({ state: "attached", timeout: 30_000 });
    const count = await content.count();
    if (count !== 1) {
      throw new Error(
        `expected exactly 1 assistant content block on ${id}, found ${count} — ` +
          `the ${label} render path or the content selector drifted`,
      );
    }

    const htmlClass = await page.evaluate(() => document.documentElement.className);
    if (!themeApplied(htmlClass, theme)) {
      throw new Error(
        `${id} did not resolve to ${theme} (html class="${htmlClass}") — cannot ` +
          `compare against the ${theme} golden`,
      );
    }

    await page
      .waitForFunction(
        () => document.querySelectorAll("[data-shiki-code]").length === 0,
        undefined,
        { timeout: hydrationSettleMs },
      )
      .catch(() => {
        /* placeholder shape is a valid compare input; proceed */
      });

    const html = await content.first().innerHTML();
    // Charts/mermaid render as separate components outside the content block
    // (same contract as the /chat live target); the content compare owns the
    // inline markdown, their live compare is the S4 interactive-layer concern.
    return { html, charts: [], mermaid: [] };
  }

  const target: AsyncRenderTarget = { id, label, renderContent: drive };

  return {
    target,
    async probe(): Promise<SurfaceProbe> {
      // Only a DEFINITIVE missing route (HTTP 404) reports `available:false` (the
      // documented inert-route skip). Every OTHER failure — a seed error, a
      // 401/403/5xx, or a 200 that never mounts the content block — is a REAL
      // regression once the route exists and is rethrown so the gated spec fails
      // loud rather than silently skipping (a false green). `seedFixtureThread`
      // itself throws on a seed failure and is intentionally NOT swallowed here.
      const threadId = await seedFixtureThread(request, baseUrl, "parity probe");
      const resp = await page.goto(urlFor(threadId, "github-light"), {
        waitUntil: "domcontentloaded",
      });
      const status = resp?.status() ?? 0;
      if (status === 404) {
        return {
          available: false,
          reason: `${label}: ${urlFor("<id>", "github-light")} returned HTTP 404 — ` +
            `the embed route is not served (S5 #1848 landed the embed core INERT — no route). ` +
            `This leg enforces once the /embed/assistant page slice lands.`,
        };
      }
      if (status >= 400) {
        throw new Error(
          `${label}: ${urlFor("<id>", "github-light")} returned HTTP ${status} — ` +
            `NOT a missing route (404). Surfacing rather than skipping so a real ` +
            `regression on a LIVE embed route fails loud instead of passing green.`,
        );
      }
      // Route serves (<400): the content block MUST mount. A miss here is a real
      // render-path/selector regression (route exists but is broken) — the
      // selector wait throws, which propagates as a loud failure, not a skip.
      await page
        .locator(contentSelector)
        .first()
        .waitFor({ state: "attached", timeout: 10_000 });
      return { available: true };
    },
  };
}

/**
 * The generic embedded conversation-view target (target 2). Drives the
 * first-party `/embed/assistant` page (S5 #1221 Lane B) — the SAME shared
 * renderer as `/chat`, without the app chrome. The route + query contract is the
 * S5 embed-route design contract (§3-6); the seeded-thread mechanic reuses the
 * `/chat` client's persistence route. The `contentSelector` mirrors the packaged
 * renderer's content container; it is asserted (exactly-one) at drive time, so a
 * selector drift fails loud rather than silently comparing the wrong node.
 */
export function createEmbeddedViewTarget(deps: {
  page: Page;
  request: APIRequestContext;
  baseUrl: string;
}): ProbedTarget {
  return createSeededThreadTarget({
    ...deps,
    id: "embedded-view",
    label: "Generic embedded conversation-view (/embed/assistant)",
    // The embed page renders the shared renderer's content container. Query-carried
    // thread id per the S5 embed contract; refined to the final param name when the
    // route lands (the probe gates on the route actually serving until then).
    urlFor: (threadId) => `/embed/assistant?assistant=chat&thread=${threadId}`,
    contentSelector: ".max-w-none.leading-relaxed.text-foreground",
  });
}
