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
//     B — LANDED on origin/main: core 1e0d8d0e0 + §12 MessagePort 2d4482682).
//     But the merged route is a LIVE-BRIDGE BROKER, not a seeded-thread viewer:
//     it mounts the shared renderer ONLY after a parent postMessage bootstrap +
//     a `token-broker` stream-contract negotiation, then drives content via a
//     LIVE turn (embed-assistant-client.tsx). Until Lane A advertises
//     `token-broker` at /api/assistants/chat/capabilities the embed fails closed
//     to the gated card and can render NO corpus content; AND the merged page has
//     no deterministic seeded-corpus path (reads only instanceId+assistant, no
//     thread). So `probe()` is gated OFF behind an explicit opt-in flag
//     (E2E_EMBED_PARITY_LIVE=1) and reports a loud, tracked skip by default —
//     never a silent skip, never the stale 404-only guard that would ERROR on the
//     now-landed route. Enabling it (after BOTH deps land + the drive is
//     redesigned) makes the probe enforce for real, failing loud on any drift.
//     The #1216 S6 / #1222 embed-parity follow-up.
//   - the CMS iframe target drives the embedded view INSIDE the WordPress /
//     Drupal admin (the S5 widget cutover, wordpress-plugin#87 / drupal-module#86)
//     so it additionally exercises the postMessage embed bridge + the CMS shell
//     CSP. It frames the SAME /embed/assistant, so it inherits the SAME Lane-A
//     interlock above AND needs the docker CMS+wayflow compose profile (host port
//     3010). No render-parity CMS spec is wired yet — it is the second half of
//     the same follow-up, blocked on the same deps.
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

/** The chat capability surface the embed negotiates against (§8). It advertises
 *  the `token-broker` auth mode only once Lane A lands; until then the embed
 *  fails closed to the gated card. Named in the gated-OFF skip reason below. */
const CHAT_CAPABILITIES_ENDPOINT = "/api/assistants/chat/capabilities";

/** Opt-in flag that ENABLES the live embedded/CMS render-parity legs. Default
 *  (unset) → a loud, tracked skip (the legs cannot render corpus content until
 *  the Lane-A `token-broker` advertisement AND a deterministic embed
 *  corpus-render path land — the #1216 S6 / #1222 embed-parity follow-up). Set
 *  to "1" only after both land AND `drive()`/`urlFor` are redesigned to reach the
 *  embed's "active" state; the probe then enforces for real (fails loud on any
 *  drift), never a silent skip. */
const EMBED_PARITY_LIVE_ENV = "E2E_EMBED_PARITY_LIVE";

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
      // EXPLICIT ENV GATE (opt-in), never a silent or heuristic skip.
      //
      // The embed route LANDED on origin/main (S5 #1221 core 1e0d8d0e0 + §12
      // MessagePort 2d4482682), so the old "HTTP 404 → skip" guard is stale (once
      // the route serves 200 it would proceed to the content wait and THROW —
      // erroring, not skipping). But the merged `/embed/assistant` still cannot
      // render corpus content DETERMINISTICALLY on this branch, for TWO reasons:
      //   (a) LANE-A INTERLOCK. It is a live-bridge broker that mounts the shared
      //       renderer only after a `token-broker` stream-contract negotiation
      //       against `/api/assistants/chat/capabilities`; that surface advertises
      //       only ["session"] here (grep-confirmed: no `token-broker` anywhere),
      //       so the embed fails closed to the gated card.
      //   (b) NO SEEDED-CORPUS PATH. The page reads only `instanceId`+`assistant`
      //       (no `thread`) and starts from `initialConversationState()` with no
      //       injection seam — content arrives ONLY via a live turn.
      // A runtime probe cannot faithfully discriminate (a): it holds no real
      // `cit_`/`cwu_` broker tokens (those require a live CMS bootstrap), so a
      // header-less capabilities fetch could false-skip even after Lane A lands,
      // and non-2xx/parse/network failures could mask a real regression. So the
      // leg is gated OFF behind an explicit opt-in and reports a loud, tracked
      // skip. Enabling it (`${EMBED_PARITY_LIVE_ENV}=1`) — done only once BOTH
      // (a) token-broker AND (b) a deterministic embed corpus-render path land,
      // AND `drive()`/`urlFor` are redesigned to reach the "active" state — runs
      // the real route + content-mount assertion below, which fails LOUD on any
      // drift/regression (never a skip). Tracked: #1216 S6 / #1222 embed-parity.
      if (process.env[EMBED_PARITY_LIVE_ENV] !== "1") {
        return {
          available: false,
          reason:
            `${label}: gated OFF (set ${EMBED_PARITY_LIVE_ENV}=1 to enable). ` +
            `Blocked on the Lane-A interlock — the embed negotiates broker-auth ` +
            `against ${CHAT_CAPABILITIES_ENDPOINT}, which advertises only ` +
            `["session"] (no token-broker) on this branch, so it fails closed to ` +
            `the gated card and renders no corpus content — AND the merged ` +
            `/embed/assistant has no deterministic seeded-corpus path (reads only ` +
            `instanceId+assistant, no thread). Enable once BOTH land and the drive ` +
            `is redesigned to reach the "active" state. #1216 S6 / #1222 follow-up.`,
        };
      }
      // ENABLED (opt-in, post-Lane-A + drive redesign). The route MUST serve and
      // the shared-renderer content block MUST mount — ANY miss is a REAL
      // regression, thrown LOUD (never a skip / false green). `seedFixtureThread`
      // itself throws on a seed failure and is intentionally NOT swallowed.
      const threadId = await seedFixtureThread(request, baseUrl, "parity probe");
      const resp = await page.goto(urlFor(threadId, "github-light"), {
        waitUntil: "domcontentloaded",
      });
      const status = resp?.status() ?? 0;
      if (status >= 400) {
        throw new Error(
          `${label}: ${urlFor("<id>", "github-light")} returned HTTP ${status} — ` +
            `${EMBED_PARITY_LIVE_ENV}=1 but the embed route is not serving. A real ` +
            `regression, surfaced LOUD (not skipped) so it never passes green.`,
        );
      }
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
    // The embed page renders the shared renderer's content container ONCE it can
    // reach its "active" state (Lane-A `token-broker` negotiation). NOTE: the
    // merged /embed/assistant reads only `instanceId`+`assistant` — it does NOT
    // consume `thread`; this URL is the pre-Lane-A placeholder the probe gates on
    // (it skips honestly until token-broker is advertised, so drive() never runs
    // against the wrong contract). When Lane A lands, this drive must be
    // redesigned to reach "active" (parent bootstrap + a deterministic seeded
    // turn) rather than a query-carried thread — the #1216 S6 / #1222 follow-up.
    urlFor: (threadId) => `/embed/assistant?assistant=chat&thread=${threadId}`,
    contentSelector: ".max-w-none.leading-relaxed.text-foreground",
  });
}
