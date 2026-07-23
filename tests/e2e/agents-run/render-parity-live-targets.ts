// ---------------------------------------------------------------------------
// Live render-parity targets (2) + (3): the generic Cinatra embedded
// conversation-view and the WordPress/Drupal CMS iframe (cinatra#1222 +
// cinatra#1998, epic #1216 S6 — the LIVE-RUN slice).
//
// Target (1), live `/chat`, ships in chat-render-parity-target.ts (S2). This
// module adds the other two of the three targets the issue names, BOTH driving
// the SAME shared content renderer (`@cinatra-ai/chat/renderer`) the reference
// target and the goldens are anchored to — so a divergence is a real
// shell/bridge regression, not two renderers that were never meant to match.
//
// HOW THE EMBED RENDERS DETERMINISTICALLY (cinatra#1998 (a)+(b)). The merged
// `/embed/assistant` is a live-bridge broker: it mounts the shared renderer only
// after (i) a parent postMessage BOOTSTRAP and (ii) a `token-broker` stream-
// contract negotiation against `/api/assistants/chat/capabilities`. Lane A (a)
// makes that capabilities surface advertise `token-broker` AND serve the
// advertisement to a sessionless broker-auth caller, so the negotiation reaches
// `ok`. The deterministic corpus-render SEAM (b) — the server-gated
// `EMBED_PARITY_SEAM` env + the `?parityThread=` param — makes the embed, AFTER
// reaching `active` through that REAL mount path, render a seeded thread's
// assistant message through its OWN mounted `ConversationTurn` (now wired to the
// S3 `renderMarkdown`) IN PLACE OF a live LLM turn. The seed reuses the SAME
// `/api/assistants/threads` persistence route the `/chat` reference target
// seeds, so all live targets share ONE deterministic, no-live-LLM content path
// and ONE compare. The content block carries a stable `[data-embed-content]`
// hook the compare scrapes.
//
// AVAILABILITY IS EXPLICIT, NEVER SILENT. Each factory returns a target plus a
// `probe()` that resolves the surface's readiness against the running stack:
//   - the embedded view (`/embed/assistant`) needs, to reach `active`: the
//     Lane-A `token-broker` advertisement (LANDED, cinatra#1998 (a)), the
//     `EMBED_PARITY_SEAM` server gate + `?parityThread=` seam (LANDED (b)), AND
//     a live parent-bootstrap DRIVER that mints a valid `cit_`/`cwu_` pair for a
//     configured widget site and performs the embed bridge handshake. That
//     driver (`bootstrapEmbed`) is injected by the spec; until it is wired the
//     leg reports a LOUD, tracked skip (never a silent skip, never a false
//     green). The whole leg is additionally gated behind the explicit opt-in
//     `E2E_EMBED_PARITY_LIVE=1`.
//   - the CMS iframe target (3) frames the SAME `/embed/assistant` INSIDE the
//     WordPress/Drupal admin (the S5 widget cutover, wordpress-plugin#87 /
//     drupal-module#86), so it additionally exercises the postMessage bridge +
//     the CMS shell CSP and needs the docker CMS + wayflow compose profile (host
//     port 3010). It inherits the SAME Lane-A interlock + seam; its bootstrap
//     driver is the live CMS iframe itself. Its render-parity spec lives on the
//     wp-drupal-uat suite path (blocked additionally on the iframe cutover being
//     live in that stack).
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import type { APIRequestContext, Page } from "@playwright/test";

import type {
  AsyncRenderTarget,
  ContentRenderResult,
  RenderTheme,
} from "../design/conformance/render-parity/targets/target";

/** Opt-in flag that ENABLES the live embedded/CMS render-parity legs. Default
 *  (unset) → a loud, tracked skip. Set to "1" only against a stack that has BOTH
 *  the Lane-A `token-broker` capabilities advertisement (a) and the
 *  `EMBED_PARITY_SEAM` deterministic corpus-render seam (b), AND a wired parent-
 *  bootstrap driver; the probe then enforces for real (fails loud on any drift),
 *  never a silent skip. cinatra#1216 S6 / #1222 / #1998. */
const EMBED_PARITY_LIVE_ENV = "E2E_EMBED_PARITY_LIVE";

/** The stable content-block hook the embed's `renderText` renders the seeded
 *  corpus into (`[data-embed-content]`, embed-assistant-client.tsx). Its
 *  innerHTML is the S3 `renderMarkdown` output — byte-comparable to the
 *  reference target's output after the shared DOM normalization. */
const EMBED_CONTENT_SELECTOR = "[data-embed-content]";

/** A non-secret disambiguator the embed shell reads; the AUTHORITATIVE write
 *  target is re-derived server-side from the tokens (never this value). */
const PARITY_INSTANCE_ID = "render-parity";

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

/**
 * Drive the parent side of the embed bridge so the mounted `/embed/assistant`
 * reaches `active`: mint a valid `cit_`/`cwu_` pair for a configured widget
 * site, then perform the postMessage BOOTSTRAP handshake (READY nonce echo,
 * correlationId, the retained MessagePort or the legacy window path). Injected
 * by the spec/stack because it needs real broker credentials + (for target 3)
 * the live CMS iframe. Resolves once the bootstrap has been delivered.
 */
export type EmbedBootstrapDriver = (
  page: Page,
  ctx: {
    threadId: string;
    assistant: "wordpress" | "drupal";
    instanceId: string;
    theme: RenderTheme;
  },
) => Promise<void>;

function parityThemeParam(theme: RenderTheme): string {
  // The embed reads `?parityTheme=` and passes it straight to `renderMarkdown`
  // (github-light ⟺ light shiki, github-dark ⟺ dark) — no ThemeProvider on the
  // embed shell, so the theme rides the URL, not an html-class the harness sets.
  return theme === "github-dark" ? "github-dark" : "github-light";
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
  /** The bound assistant handle the embed frames + the tokens bind. */
  assistant: "wordpress" | "drupal";
  /** Build the embed URL for a seeded thread id + theme (the (b) seam contract:
   *  `/embed/assistant?...&parityThread=<id>&parityTheme=<theme>`). */
  urlFor(threadId: string, theme: RenderTheme): string;
  /** The selector for the single assistant content block on this surface. */
  contentSelector: string;
  /** The parent-bootstrap driver (see {@link EmbedBootstrapDriver}). When absent
   *  the leg is not drivable and `probe()` reports a loud, tracked skip. */
  bootstrapEmbed?: EmbedBootstrapDriver;
  /** Bound the wait for shiki hydration to settle (only affects the `code` fixture). */
  hydrationSettleMs?: number;
};

/**
 * A live {@link ProbedTarget} that seeds the fixture as a thread, navigates the
 * embed's (b)-seam URL, drives the real parent bootstrap so the embed reaches
 * `active`, and scrapes the single assistant content block the seam rendered.
 * Generic over the route + selector so the generic embedded view (target 2) and
 * the CMS iframe (target 3) share one implementation. `probe()` fails loud on an
 * inert/unbuilt/undrivable surface, so a regression never passes as a green.
 */
export function createSeededThreadTarget(deps: SeededThreadTargetDeps): ProbedTarget {
  const { page, request, baseUrl, id, label, assistant, urlFor, contentSelector, bootstrapEmbed } =
    deps;
  const hydrationSettleMs = deps.hydrationSettleMs ?? 8_000;

  async function reachActiveContent(threadId: string, theme: RenderTheme): Promise<void> {
    // 1. Navigate the embed shell (the seam params ride the URL; tokens NEVER do).
    await page.goto(urlFor(threadId, theme), { waitUntil: "domcontentloaded" });
    // 2. Drive the REAL parent bootstrap → the embed negotiates broker-auth and
    //    mounts the renderer (`active`); the seam then renders the seeded corpus.
    //    `bootstrapEmbed` is guaranteed present here (probe gates on it).
    await bootstrapEmbed!(page, { threadId, assistant, instanceId: PARITY_INSTANCE_ID, theme });
  }

  async function drive(source: string, theme: RenderTheme): Promise<ContentRenderResult> {
    const threadId = await seedFixtureThread(request, baseUrl, source);
    await reachActiveContent(threadId, theme);

    const content = page.locator(contentSelector);
    await content.first().waitFor({ state: "attached", timeout: 30_000 });
    const count = await content.count();
    if (count !== 1) {
      throw new Error(
        `expected exactly 1 assistant content block on ${id}, found ${count} — ` +
          `the ${label} render path or the content selector drifted`,
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
      if (process.env[EMBED_PARITY_LIVE_ENV] !== "1") {
        return {
          available: false,
          reason:
            `${label}: gated OFF (set ${EMBED_PARITY_LIVE_ENV}=1 to enable). The Lane-A ` +
            `token-broker capabilities advertisement (cinatra#1998 (a)) and the ` +
            `EMBED_PARITY_SEAM deterministic corpus-render seam (b) have LANDED; enabling ` +
            `this flag runs the real bootstrap + content-mount assertion, which fails LOUD ` +
            `on any drift. #1216 S6 / #1222 / #1998.`,
        };
      }
      // The parent-bootstrap driver must be wired (mint cit_/cwu_ + perform the
      // bridge handshake). Without it the embed can NEVER reach `active`, so the
      // leg reports a LOUD, tracked skip rather than a timeout masquerading as a
      // failure — the remaining flip-work.
      if (!bootstrapEmbed) {
        return {
          available: false,
          reason:
            `${label}: ${EMBED_PARITY_LIVE_ENV}=1 but no parent-bootstrap driver is wired. ` +
            `The embed reaches its renderer ONLY after a real postMessage bootstrap that ` +
            `mints a valid cit_/cwu_ pair for a configured widget site and performs the ` +
            `bridge handshake; supply \`bootstrapEmbed\` (the live CMS iframe for target 3). ` +
            `Tracked: #1216 S6 / #1998.`,
        };
      }
      // ENABLED + drivable. The route MUST serve, the bootstrap MUST reach
      // `active`, and the seam-rendered content block MUST mount — ANY miss is a
      // REAL regression, thrown LOUD (never a skip / false green).
      const threadId = await seedFixtureThread(request, baseUrl, "parity probe");
      await reachActiveContent(threadId, "github-light");
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
 * renderer as `/chat`, without the app chrome — through the cinatra#1998 (a)+(b)
 * broker-auth + deterministic-seam path. The `contentSelector` is the stable
 * `[data-embed-content]` block the seam renders the corpus into; it is asserted
 * (exactly-one) at drive time, so a selector drift fails loud rather than
 * silently comparing the wrong node.
 */
export function createEmbeddedViewTarget(deps: {
  page: Page;
  request: APIRequestContext;
  baseUrl: string;
  bootstrapEmbed?: EmbedBootstrapDriver;
}): ProbedTarget {
  return createSeededThreadTarget({
    ...deps,
    id: "embedded-view",
    label: "Generic embedded conversation-view (/embed/assistant)",
    assistant: "wordpress",
    // The (b) seam contract: the embed reads `parityThread` (seeded corpus,
    // read back via the same persistence route) + `parityTheme` (renderMarkdown
    // theme) ONLY when the server `EMBED_PARITY_SEAM` gate is on. Tokens never
    // ride the URL — they arrive via the parent bootstrap the driver performs.
    urlFor: (threadId, theme) =>
      `/embed/assistant?assistant=wordpress&instanceId=${PARITY_INSTANCE_ID}` +
      `&parityThread=${threadId}&parityTheme=${parityThemeParam(theme)}`,
    contentSelector: EMBED_CONTENT_SELECTOR,
  });
}
