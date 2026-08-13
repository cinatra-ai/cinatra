// ---------------------------------------------------------------------------
// S5 (cinatra#1221) Lane B §2 — GET /embed/assistant : the Cinatra-served embed
// page a CMS widget frames as the SOLE AG-UI session owner.
//
// A THIN server-component shell (identical dataless posture to /widget-auth
// before a session): it reads the NON-SECRET disambiguators from the query
// (`instanceId`, `assistant`), resolves the expected parent origin READ-ONLY
// (§7) for the bridge, and renders NO user data. Tokens are NEVER in the URL —
// they arrive only via the postMessage bootstrap (§4). `force-dynamic` so the
// per-instance render is never statically cached.
//
// The per-request `frame-ancestors` CSP (§7) is set in the proxy/route-guard
// (an RSC cannot set a per-request header); this shell only PASSES the resolved
// expected parent origin to the client for the bridge's outbound target + the
// inbound origin gate. `'none'` (unresolvable) → an empty expected origin → the
// client posts nothing and shows a neutral card.
// ---------------------------------------------------------------------------

import {
  frameAncestorsDirectiveFor,
  resolveRegisteredInstanceSiteUrl,
  FRAME_ANCESTORS_NONE,
} from "@/lib/embed/frame-ancestors.server";
// cinatra#2683 (epic #2564 S8f) — the widget conversation column renders the
// SAME extension-provided chat widgets and renderable views `/chat` does, so it
// needs the SAME server-resolved catalogs. Resolved through the identical
// manifest + extension-lifecycle resolvers the `/chat` mount uses; the host
// names no extension anywhere, on either surface.
//
// NOT AUTHORIZATION, AND NOT USER DATA. Both resolvers read the generated
// extension manifest and the lifecycle status of the packages in it — the same
// answer for every caller, resolved before any bootstrap exists. This shell
// stays dataless: it renders no user data and reads no session.
import { resolveChatWidgetCatalog } from "@/lib/chat-widget-catalog.server";
import { resolveChatViewCatalog } from "@/lib/chat-views-catalog.server";
// cinatra#2683 (epic #2564 S8f) — the "Remote chat" jump-out of the composer's
// prompt-options flyout. The SAME first-party builder `/chat` uses, keyed on the
// SAME closed provider table; it can only ever append a ratified path to a site
// origin this server already resolved, so there is no new URL logic here and no
// open-redirect surface.
import {
  buildRemoteChatHref,
  remoteConnectorKindForProvider,
} from "@/lib/assistant-remote-target";
import { EmbedAssistantClient } from "./embed-assistant-client";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  instanceId?: string;
  assistant?: string;
  // cinatra#1998 (b) TEST-ONLY render-parity seam params — READ ONLY when the
  // server-side `EMBED_PARITY_SEAM` gate is on (see below). Ignored in prod.
  parityThread?: string;
  parityTheme?: string;
}>;

// cinatra#1998 (b) — the deterministic corpus-render seam gate. A NON-PUBLIC
// server env (never `NEXT_PUBLIC_*`, never a URL/client value): unset in prod →
// the seam is inert (the `parityThread` param is ignored, the client renders no
// injected content and behaves exactly as before). Set to "1" ONLY on the
// render-parity verify stack. This is what makes the seam test-only,
// non-user-controllable, and unable to bypass auth.
function paritySeamEnabled(): boolean {
  return process.env.EMBED_PARITY_SEAM === "1";
}

export default async function EmbedAssistantPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // Both catalogs are best-effort ADJUNCTS to the frame: a degraded extension
  // load must never stop the assistant loading. An empty catalog is a state
  // `/chat` has too (no view-bearing extension live) and the shared column draws
  // its own never-blank fallback for it.
  const [params, widgetCatalog, viewCatalog] = await Promise.all([
    searchParams,
    resolveChatWidgetCatalog().catch(() => ({ widgets: [], manifests: [] })),
    resolveChatViewCatalog().catch(() => ({})),
  ]);
  const assistant = params.assistant ?? "";
  const instanceId = params.instanceId ?? "";

  // Content-render theme (renderMarkdown / shiki). Prod default is github-light;
  // the render-parity seam pins each theme via `?parityTheme=` so the compare
  // exercises both goldens. Only honored when the seam gate is on.
  const seamOn = paritySeamEnabled();
  const theme = seamOn && params.parityTheme === "github-dark" ? "github-dark" : "github-light";
  const paritySeam =
    seamOn && params.parityThread ? { threadId: params.parityThread } : null;

  // READ-ONLY (§7). Reuse the SAME resolver the CSP uses so the bridge's expected
  // parent origin is byte-consistent with the frame-ancestors wall. `'none'`
  // (unknown assistant / missing / duplicate / non-normalizable instance) →
  // empty expected origin → the client renders the neutral error card and posts
  // nothing. NOT an authorization boundary — it only narrows framing.
  const directive = frameAncestorsDirectiveFor({ assistant, instanceId });
  const expectedParentOrigin = directive === FRAME_ANCESTORS_NONE ? "" : directive;

  // The remote-chat destination for THIS widget's own registered site.
  //
  // It stays a dataless resolution, which is what lets the shell keep its
  // posture: the kind comes from the closed provider table (an unknown handle
  // yields none), and the site comes from the registered instance row through
  // the same closed binding — never a query value, never a session, never user
  // data. An unresolvable row yields no destination, so the flyout simply does
  // not carry the jump-out.
  //
  // The REGISTERED SITE URL, not the CSP's origin (codex round 1, finding 4):
  // the builder appends a ratified path to what it is given, so an origin-only
  // value silently drops a subdirectory install — `https://example.com/blog/`
  // would link to `/wp-admin/` instead of `/blog/wp-admin/`, which is a
  // destination `/chat` never produces.
  const remoteKind = remoteConnectorKindForProvider(assistant);
  const registeredSiteUrl = resolveRegisteredInstanceSiteUrl({ assistant, instanceId });
  const remoteHref =
    remoteKind && registeredSiteUrl
      ? buildRemoteChatHref(remoteKind, { id: instanceId, siteUrl: registeredSiteUrl })
      : null;
  const remoteChat = remoteHref ? { label: "Remote chat", href: remoteHref } : undefined;

  return (
    // The column scrolls internally (as it does on `/chat`), so the shell gives
    // it the frame's height instead of growing with the transcript.
    <main data-embed-assistant-shell className="h-dvh">
      <EmbedAssistantClient
        expectedParentOrigin={expectedParentOrigin}
        assistant={assistant}
        instanceId={instanceId}
        theme={theme}
        widgets={widgetCatalog.widgets}
        widgetManifests={widgetCatalog.manifests}
        chatViews={viewCatalog}
        paritySeam={paritySeam}
        {...(remoteChat ? { remoteChat } : {})}
      />
    </main>
  );
}
