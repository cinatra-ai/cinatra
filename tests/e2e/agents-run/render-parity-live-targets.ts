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

// ---------------------------------------------------------------------------
// The generic-embed (target 2) PARENT-BOOTSTRAP DRIVER (cinatra#1998 (c)).
//
// The `/embed/assistant` page is designed to be FRAMED: its bridge posts READY
// to `window.parent`, transferring a MessagePort, and mounts the renderer only
// after a parent replies with a BOOTSTRAP carrying a valid `cit_`/`cwu_` pair.
// For the generic embedded-view leg there is no CMS parent — so this module IS
// the synthetic parent.
//
// HOW THE TOP-LEVEL SELF-BOOTSTRAP WORKS. The leg registers a render-parity
// widget instance whose `siteUrl` == the Cinatra app origin (the operator/stack
// provisioning step — the SAME kind of connect-site dev-auto-setup registers for
// the CMS sites, just pointed at the embed's own origin), so the embed's
// server-resolved `expectedParentOrigin` == its OWN origin and `window.parent
// === window`. `postReady` therefore posts READY (with the transferred port) to
// this same window; an init-script listener installed BEFORE navigation captures
// the nonce + port. The embed's own window listener also receives that READY and
// briefly fail-closes to a NEUTRAL error card (a READY is not a valid BOOTSTRAP)
// WITHOUT burning the single-use nonce — so when this driver then posts the real
// BOOTSTRAP over the captured port, `onPortMessage` accepts it, the nonce burns
// once, and the phase transitions error → `active`. The content the compare
// scrapes is the top-level embed's own `[data-embed-content]`; no iframe.
//
// TOKENS ARE PROVISIONED, NEVER SYNTHESIZED. Reaching the broker negotiation's
// `ok` requires a REAL `cit_`/`cwu_` pair bound to that parity site+origin — the
// driver cannot mint them (that is the connect-site + hosted-PKCE flow the CMS
// stack owns). The operator/stack that registered the parity connect-site
// supplies the pre-minted pair via `E2E_EMBED_PARITY_CIT` / `E2E_EMBED_PARITY_CWU`
// (exactly as it supplies `E2E_EMBED_PARITY_LIVE=1`). Absent them the leg reports
// a LOUD, tracked skip — never a silent skip, never a synthesized/forged token.
// ---------------------------------------------------------------------------

/** Env: a pre-minted `cit_` site token for the render-parity widget instance,
 *  bound to the embed's OWN origin (== the instance `siteUrl`) and the
 *  `wordpress-content-editor` widget-stream agent. Supplied by the operator/stack
 *  that provisioned the parity connect-site. */
const PARITY_CIT_ENV = "E2E_EMBED_PARITY_CIT";
/** Env: the paired per-user `cwu_` token (same site/origin, dev user). */
const PARITY_CWU_ENV = "E2E_EMBED_PARITY_CWU";

/** A pre-provisioned broker-token pair the parent bootstrap presents. */
export type ParityBrokerTokens = {
  readonly citToken: string;
  readonly cwuToken: string;
};

/**
 * Resolve the operator-provisioned broker tokens for the generic-embed parent
 * bootstrap, or `null` when they are not supplied (→ a loud, tracked skip). Only
 * a well-formed `cit_`/`cwu_` pair is accepted — the driver never synthesizes a
 * token, so an unprovisioned stack skips honestly rather than forging auth.
 */
export function resolveParityBrokerTokens(): ParityBrokerTokens | null {
  const citToken = (process.env[PARITY_CIT_ENV] ?? "").trim();
  const cwuToken = (process.env[PARITY_CWU_ENV] ?? "").trim();
  if (citToken.startsWith("cit_") && cwuToken.startsWith("cwu_")) {
    return { citToken, cwuToken };
  }
  return null;
}

/** The name of the env carrying the token pair (for the skip reason). */
export const PARITY_BROKER_TOKENS_ENV = `${PARITY_CIT_ENV}/${PARITY_CWU_ENV}`;

/**
 * Install the SYNTHETIC PARENT side of the embed bridge as a page init script
 * (runs at document-start on EVERY navigation, BEFORE the embed's own bridge
 * installs). It buffers the FIRST `cinatra.embed.ready` — its nonce + the
 * transferred MessagePort (`event.ports[0]`) — into a window global the
 * per-navigation driver reads. Call ONCE before the fixtures loop; every
 * subsequent `page.goto` re-runs it against the fresh document.
 */
export async function installEmbedParitySyntheticParent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Reset per document; a fresh navigation mints a fresh nonce+port.
    (window as unknown as { __cinatraParityReady?: unknown }).__cinatraParityReady = null;
    window.addEventListener("message", (ev: MessageEvent) => {
      const d = ev.data as { type?: unknown; nonce?: unknown } | null;
      if (
        d &&
        typeof d === "object" &&
        d.type === "cinatra.embed.ready" &&
        typeof d.nonce === "string" &&
        ev.ports &&
        ev.ports.length > 0
      ) {
        (window as unknown as { __cinatraParityReady?: unknown }).__cinatraParityReady = {
          nonce: d.nonce,
          port: ev.ports[0],
        };
      }
    });
  });
}

/**
 * Build the parent-bootstrap {@link EmbedBootstrapDriver} for target 2. After the
 * harness navigates the embed URL, this waits for the init-script listener to
 * capture the embed's READY, then posts a real BOOTSTRAP over the retained
 * MessagePort — echoing the nonce, carrying the provisioned `cit_`/`cwu_` pair +
 * the seeded threadId, exactly the envelope the CMS plugin emits — so the embed
 * negotiates broker-auth and reaches `active` through the REAL mount path. Throws
 * loud if the READY is never captured (the parity instance origin did not resolve
 * to this origin) or the phase does not reach `active` (a real bridge/negotiation
 * regression), surfacing the neutral gated/error reason.
 */
export function createEmbedBootstrapDriver(tokens: ParityBrokerTokens): EmbedBootstrapDriver {
  return async (page, ctx) => {
    const outcome = await page.evaluate(
      async ({ threadId, assistant, instanceId, citToken, cwuToken }) => {
        type Captured = { nonce: string; port: MessagePort } | null;
        const read = (): Captured =>
          (window as unknown as { __cinatraParityReady?: Captured }).__cinatraParityReady ?? null;
        const started = Date.now();
        let captured = read();
        while (!captured && Date.now() - started < 15_000) {
          await new Promise((r) => setTimeout(r, 50));
          captured = read();
        }
        if (!captured) return { ok: false as const, reason: "ready_not_captured" };

        // correlationId: CSPRNG base64url, 22..128 chars (bridge ID_PATTERN).
        const bytes = new Uint8Array(18);
        crypto.getRandomValues(bytes);
        let bin = "";
        for (const b of bytes) bin += String.fromCharCode(b);
        const correlationId = btoa(bin)
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");

        captured.port.start();
        captured.port.postMessage({
          type: "cinatra.embed.bootstrap",
          protocolVersion: 1,
          correlationId,
          nonceEcho: captured.nonce,
          seq: 0,
          auth: { citToken, cwuToken },
          session: { threadId, assistant },
          cms: { instanceId },
        });
        // Clear so the next navigation captures a fresh READY.
        (window as unknown as { __cinatraParityReady?: Captured }).__cinatraParityReady = null;

        // Await the phase transition (error/gated → active); surface the neutral
        // reason if it does not mount, so a negotiation failure is diagnosable.
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const el = document.querySelector("[data-embed-assistant]");
          const phase = el?.getAttribute("data-phase") ?? "";
          if (phase === "active") return { ok: true as const };
          await new Promise((r) => setTimeout(r, 100));
        }
        const el = document.querySelector("[data-embed-assistant]");
        return {
          ok: false as const,
          reason: `phase=${el?.getAttribute("data-phase") ?? "<none>"}`,
        };
      },
      {
        threadId: ctx.threadId,
        assistant: ctx.assistant,
        instanceId: ctx.instanceId,
        citToken: tokens.citToken,
        cwuToken: tokens.cwuToken,
      },
    );

    if (!outcome.ok) {
      throw new Error(
        `parent-bootstrap driver could not reach the embed's active phase (${outcome.reason}). ` +
          (outcome.reason === "ready_not_captured"
            ? `The embed never posted READY to this window — its server-resolved expectedParentOrigin ` +
              `did not resolve to this origin, so the render-parity widget instance ` +
              `("${ctx.instanceId}") is not registered with siteUrl == the embed origin.`
            : `The broker negotiation did not reach ok (the provisioned cit_/cwu_ pair may be ` +
              `expired/misbound, or Lane-A capabilities rejected it). This is a REAL regression — thrown loud.`),
      );
    }
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
