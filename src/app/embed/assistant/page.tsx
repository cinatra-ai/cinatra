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
  FRAME_ANCESTORS_NONE,
} from "@/lib/embed/frame-ancestors.server";
import { EmbedAssistantClient } from "./embed-assistant-client";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ instanceId?: string; assistant?: string }>;

export default async function EmbedAssistantPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const assistant = params.assistant ?? "";
  const instanceId = params.instanceId ?? "";

  // READ-ONLY (§7). Reuse the SAME resolver the CSP uses so the bridge's expected
  // parent origin is byte-consistent with the frame-ancestors wall. `'none'`
  // (unknown assistant / missing / duplicate / non-normalizable instance) →
  // empty expected origin → the client renders the neutral error card and posts
  // nothing. NOT an authorization boundary — it only narrows framing.
  const directive = frameAncestorsDirectiveFor({ assistant, instanceId });
  const expectedParentOrigin = directive === FRAME_ANCESTORS_NONE ? "" : directive;

  return (
    <main data-embed-assistant-shell>
      <EmbedAssistantClient
        expectedParentOrigin={expectedParentOrigin}
        assistant={assistant}
        instanceId={instanceId}
      />
    </main>
  );
}
