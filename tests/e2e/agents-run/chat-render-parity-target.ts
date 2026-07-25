// ---------------------------------------------------------------------------
// Live `/chat` render-parity target (cinatra#1222, epic #1216 S6 — the LIVE-RUN
// slice S2 unblocked).
//
// S2 (#1218, delivered by #1752) put `/chat` on the unified AG-UI wire and the
// first-class structured-thread persistence surface. That makes `/chat` the
// first live-run render target the epic authorizes (target (1) of the three;
// the generic embedded view + the WordPress/Drupal iframes are targets (2)/(3),
// still gated on S5 #1221). This module drives the REAL running `/chat` — no
// stub, no fixture route — and returns the surface's rendered content so the
// harness can DOM-normalized-compare it against the SAME committed goldens the
// static reference target (the S3 packaged renderer) locked.
//
// HOW IT STAYS DETERMINISTIC (no live LLM). Render-parity needs FIXED content,
// so this seeds a chat thread whose sole assistant message IS the corpus
// fixture markdown — through `POST /api/assistants/threads`, the exact
// first-class persistence route the `/chat` client itself writes
// (`saveChatThreadViaFetch`, packages/chat/src/ag-ui-chat-client.ts) — then
// navigates the thread's CANONICAL `/chat/<vendor>/<slug>/<titleSlug>` URL, the
// exact shape the app itself links a thread by (`chatPathForThread` →
// `buildChatPath`, packages/chat/src/chat-client-url.ts). The page's route guard
// (`resolveChatRouteForCurrentActor`, cinatra#1878 W3) resolves that URL back to
// the thread id and passes it as `initialThreadId`, which the client fetches
// (`GET /api/assistants/threads/<id>`) and renders through the legacy content
// path (chat-messages-view: a single `renderMarkdown(content, theme,
// detectWidgets)` div), which is the SAME `renderMarkdown` the reference target
// calls. Seed + view run as the SAME authenticated user, so owner access is
// granted.
//
// WHY WE BIND + SLUG THE SEEDED ROW (cinatra#1878 W3 drift, fixed here). The bare
// `POST /api/assistants/threads` mirror-save writes the thread row WITHOUT an
// `assistant_package` binding or a `title_slug` (`buildAssistantThreadMirrorUpsertQuery`
// projects neither), so the W3 route guard — which resolves a titleSlug URL via
// `getAssistantThreadBySlug(<package>, <instance>, <titleSlug>)` — could never
// map any URL back to the seeded thread, and the pre-#1878 bare-UUID URL this
// target used is now a dead legacy path the guard 404s (chat-path-codec
// `splitChatSegments`: a lone segment is `invalid`). So, using the harness's
// established test-only direct-DB seam (see ag-ui-chat.ts / seed.ts), we stamp
// the row with the builtin assistant's package + the app's own
// `slugifyTitle`-minted slug — reproducing exactly what the app's W3 store
// primitives (`bindAssistantThread` + `ensureThreadSlug`) would persist — then
// address the thread by the canonical URL `buildChatPath` yields for that
// binding. No product code is touched; the seeded state is what a bound, titled
// thread looks like at rest.
//
// WHY THE CONTENT MATCHES THE GOLDEN. Ten of the eleven content/hostile
// fixtures produce byte-identical inner HTML on the live surface: the corpus is
// widget-free by design (so the live widget detector ≡ the reference's empty
// detector), math renders synchronously inside `renderMarkdown` (no client
// mutation), and charts/mermaid render as SEPARATE components OUTSIDE the
// content div (so the extracted content HTML is the same stripped markdown the
// golden captures). The ONE exception is `code`: `/chat` asynchronously
// hydrates each `.chat-code-block` placeholder into shiki markup — reconciled by
// `canonicalizeCodeBlocks` in the compare (see render-parity/normalize.ts and
// the server-free proof in render-parity-live-normalize.spec.ts).
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import type { APIRequestContext, Page } from "@playwright/test";
import { Client } from "pg";

// The canonical /chat URL builder + the default (builtin) assistant route —
// the SAME zero-dep codec the app links a thread with (cinatra#1878 W3).
import { buildChatPath, DEFAULT_ASSISTANT_PACKAGE, DEFAULT_CHAT_ROUTE } from "@cinatra-ai/chat/chat-path-codec";
// The app's own pure title→slug normalizer (the base an atomic slug mint uses).
import { slugifyTitle } from "@cinatra-ai/chat/thread-slug";

import type {
  AsyncRenderTarget,
  ContentRenderResult,
  RenderTheme,
} from "../design/conformance/render-parity/targets/target";

// Test-only direct-DB seam, identical to the one ag-ui-chat.ts / seed.ts use to
// stage fixture rows the running app then serves. Used here ONLY to stamp the
// seeded thread's binding + title-slug (the app's W3 store primitives at rest),
// never to bypass any product path under test.
const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";

// The assistant content block chat-messages-view renders for a legacy
// (no-`parts`) message: `renderMarkdown(...)` inside this div. `max-w-none` /
// `leading-relaxed` / `text-foreground` are plain, stable Tailwind utilities
// (unlike the arbitrary `text-[15px]` / `[&_table]:my-0` tokens); a seeded
// single-assistant-message thread yields exactly one such block.
const CONTENT_SELECTOR = ".max-w-none.leading-relaxed.text-foreground";

// next-themes maps to the shiki ThemeName via chat-page.tsx:
//   resolvedTheme === "dark" ? "github-dark" : "github-light"
// and the app ThemeProvider (src/app/providers.tsx) uses attribute="class",
// themes ["cinatra","dark"], default "cinatra". So:
function appThemeFor(theme: RenderTheme): { storage: string; htmlClass: string } {
  return theme === "github-dark"
    ? { storage: "dark", htmlClass: "dark" }
    : { storage: "cinatra", htmlClass: "cinatra" };
}

export type ChatLiveTargetDeps = {
  page: Page;
  request: APIRequestContext;
  /** The running surface origin (used for the Origin header on the seed POST). */
  baseUrl: string;
  /** Bound the wait for shiki hydration to settle. Non-fatal: the compare's
   *  canonicalizer handles the placeholder shape too, so a slow/absent shiki
   *  load never wedges or falsifies the run. */
  hydrationSettleMs?: number;
};

/**
 * Build the live `/chat` {@link AsyncRenderTarget}. One instance per test (it
 * closes over that test's `page`/`request`).
 */
export function createChatLiveTarget(deps: ChatLiveTargetDeps): AsyncRenderTarget {
  const { page, request, baseUrl } = deps;
  const hydrationSettleMs = deps.hydrationSettleMs ?? 8_000;

  return {
    id: "chat-live",
    label: "Live /chat (real running surface, seeded thread)",

    async renderContent(source: string, theme: RenderTheme): Promise<ContentRenderResult> {
      const threadId = randomUUID();
      const nowIso = new Date().toISOString();
      // The thread title carries the thread id, so every fixture×theme render
      // gets a globally-unique title-slug (no container collision to resolve).
      const title = `render-parity ${threadId}`;

      // 1. Seed the thread through the real persistence route the /chat client
      //    itself writes. The authenticated caller owns the new thread, so the
      //    same user's page load resolves it (owner access).
      const seed = await request.post("/api/assistants/threads", {
        data: {
          id: threadId,
          title,
          createdAt: nowIso,
          updatedAt: nowIso,
          messages: [
            {
              id: randomUUID(),
              role: "assistant",
              content: source,
              createdAt: nowIso,
            },
          ],
        },
        headers: {
          "content-type": "application/json",
          Origin: baseUrl,
        },
      });
      if (!seed.ok()) {
        throw new Error(
          `seeding /api/assistants/threads failed (${seed.status()} ${seed.statusText()}) — ` +
            `the live /chat render-parity target cannot drive an unseeded thread`,
        );
      }

      // 1b. Bind the seeded row to the builtin assistant + mint its title-slug so
      //     the W3 route guard can resolve the canonical URL back to this thread.
      //     The bare mirror-save (step 1) writes neither `assistant_package` nor
      //     `title_slug`, so without this the route guard's slug→thread lookup
      //     (`getAssistantThreadBySlug`) finds nothing and every fixture 404s.
      //     We reproduce the app's own at-rest state: the package the builtin
      //     assistant registers under (DEFAULT_ASSISTANT_PACKAGE — the resolver
      //     matches the URL's `<vendor>/<slug>` to this entry) and the slug the
      //     app's `slugifyTitle` mints. Local (builtin) assistant → no instance.
      const titleSlug = slugifyTitle(title);
      const db = new Client({
        connectionString: DATABASE_URL,
        connectionTimeoutMillis: 5_000,
      });
      await db.connect();
      try {
        const res = await db.query(
          `UPDATE ${SCHEMA}.assistant_threads
             SET assistant_package = $1, instance_id = NULL, title_slug = $2, updated_at = now()
           WHERE id = $3`,
          [DEFAULT_ASSISTANT_PACKAGE, titleSlug, threadId],
        );
        if (res.rowCount !== 1) {
          throw new Error(
            `binding the seeded thread failed (updated ${res.rowCount ?? 0} rows for id ${threadId}) — ` +
              `the /chat render-parity target cannot address an unbound/unslugged thread`,
          );
        }
      } finally {
        await db.end();
      }

      // The canonical `/chat/<vendor>/<slug>/<titleSlug>` path the app itself
      // links this thread by (buildChatPath, the codec-owned URL builder).
      const chatPath = buildChatPath({
        vendor: DEFAULT_CHAT_ROUTE.vendor,
        slug: DEFAULT_CHAT_ROUTE.slug,
        titleSlug,
      });

      // 2. Pin the app theme BEFORE any page script runs, so the surface renders
      //    at the golden's theme (github-light ⟺ "cinatra", github-dark ⟺ "dark").
      //    CONTRACT: one renderContent call per FRESH page — the spec gives each
      //    test its own page (Playwright's default isolation), so this init
      //    script is registered exactly once and never accumulates across themes.
      //    Even if that contract were violated, the post-load theme assertion
      //    below fails loud rather than compare against the wrong-theme golden.
      const wantTheme = appThemeFor(theme);
      await page.addInitScript((storage) => {
        try {
          window.localStorage.setItem("theme", storage);
        } catch {
          /* storage unavailable — the post-load assertion below fails loud */
        }
      }, wantTheme.storage);

      // 3. Drive the real surface via the thread's canonical /chat URL.
      await page.goto(chatPath, { waitUntil: "domcontentloaded" });

      // The content is client-rendered (ChatMessagesView is dynamic, ssr:false,
      // and the thread is fetched client-side) — wait for the assistant content
      // block to attach.
      const content = page.locator(CONTENT_SELECTOR);
      await content.first().waitFor({ state: "attached", timeout: 30_000 });

      // Exactly one assistant content block for a single-message thread; more
      // (or none) means the render path or selector drifted — fail loud rather
      // than compare an ambiguous block.
      const count = await content.count();
      if (count !== 1) {
        throw new Error(
          `expected exactly 1 assistant content block on /chat, found ${count} — ` +
            `the chat-messages-view render path or the content selector drifted`,
        );
      }

      // 4. Assert the theme actually applied (else we would silently compare
      //    against the wrong-theme golden).
      const htmlClass = await page.evaluate(() => document.documentElement.className);
      const themeApplied =
        theme === "github-dark"
          ? htmlClass.split(/\s+/).includes("dark")
          : !htmlClass.split(/\s+/).includes("dark");
      if (!themeApplied) {
        throw new Error(
          `/chat did not resolve to ${theme} (html class="${htmlClass}") — cannot ` +
            `compare against the ${theme} golden`,
        );
      }

      // 5. Best-effort wait for shiki hydration to settle (only matters for the
      //    `code` fixture). Non-fatal — the compare's canonicalizer handles both
      //    the placeholder and the hydrated shape, so a timeout never falsifies
      //    the result.
      await page
        .waitForFunction(
          () => document.querySelectorAll("[data-shiki-code]").length === 0,
          undefined,
          { timeout: hydrationSettleMs },
        )
        .catch(() => {
          /* placeholder path is a valid compare input; proceed */
        });

      const html = await content.first().innerHTML();

      // Charts/mermaid render as separate components OUTSIDE this content block;
      // the content compare owns the inline markdown. Their live render-compare
      // is the S4 interactive-layer / detection concern, left empty here so the
      // returned shape matches the sync reference target.
      return { html, charts: [], mermaid: [] };
    },
  };
}
