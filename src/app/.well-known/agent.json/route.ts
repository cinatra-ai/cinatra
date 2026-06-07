import { NextResponse } from "next/server";
import {
  readPublishedAgentTemplates,
  isAgentPubliclyDiscoverable,
  readAgentTemplateVersions,
  type AgentTemplateRecord,
  type AgentTemplateVersionRecord,
} from "@cinatra-ai/agents";
import { buildAgentCard } from "@cinatra-ai/a2a";
import { filterTemplatesToLiveManifest, readLiveAgentPackageNames } from "@/lib/a2a-manifest-gate";

// ---------------------------------------------------------------------------
// GET /.well-known/agent.json — public A2A discovery endpoint.
//
// Returns a valid A2A AgentCard describing Cinatra's published virtual agents.
// No auth — AgentCard is public discovery metadata, equivalent to `robots.txt`
// or `/.well-known/openid-configuration`. External A2A callers (LangGraph,
// ADK, AWS Bedrock) and Cinatra's own A2A client fetch this endpoint before
// sending any task.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function resolveBaseUrl(request: Request): string {
  // Priority: request origin (absolute) → NEXT_PUBLIC_APP_URL → BETTER_AUTH_URL → localhost:3000
  try {
    const u = new URL(request.url);
    if (u.origin && u.origin !== "null") return u.origin;
  } catch {
    /* fall through */
  }
  const env =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3000";
  return env.replace(/\/+$/, "");
}

export async function GET(request: Request): Promise<Response> {
  const baseUrl = resolveBaseUrl(request);

  // Fetch all published virtual agents (status='published' AND packageName IS NOT NULL).
  // Legacy code-based modules (agent-scrape, agent-research, agent-enrichment, agent-ross-index,
  // campaign-email-outreach code-based module) are NOT included — they are pending retirement
  // and are not DB-backed published templates.
  // Canonical install/lifecycle gate, shared with the /api/a2a
  // mount via @/lib/a2a-manifest-gate. This card is PUBLIC + unauthenticated, so
  // an archived/uninstalled-but-still-published agent must not be advertised in
  // skills[]. Lifecycle gate only (visibility narrowing of the public card is a
  // separate owner-policy decision); fail-open on a gate read error.
  // Visibility policy: this card is PUBLIC + unauthenticated — PRIVATE
  // agents are excluded from discovery (public + grandfathered-null only), then
  // gated by the canonical lifecycle manifest.
  const publishedTemplates: AgentTemplateRecord[] = (await readPublishedAgentTemplates()).filter(
    isAgentPubliclyDiscoverable,
  );
  const templates: AgentTemplateRecord[] = filterTemplatesToLiveManifest(
    publishedTemplates,
    await readLiveAgentPackageNames(),
  );

  // Load version history per template.
  //
  // TODO: This issues N DB queries (one per published template) via Promise.all.
  // Acceptable for the initial implementation because the expected number of
  // published agents is O(10s). When the published count exceeds ~20, replace
  // this loop with a single batch query (e.g. `SELECT * FROM agent_template_versions
  // WHERE template_id IN (...)`) and group by templateId in memory. The agent-builder
  // store does not currently expose a batch helper; add
  // `readAgentTemplateVersionsByTemplateIds(ids: string[])` there before migrating.
  //
  // We fetch up to 100 versions each; if any template accumulates more than that we
  // truncate silently — supportedVersions is advisory metadata for version pinning,
  // not a hard contract.
  const versionsByTemplateId: Record<string, AgentTemplateVersionRecord[]> = {};
  await Promise.all(
    templates.map(async (t) => {
      try {
        const page = await readAgentTemplateVersions(t.id, { limit: 100 });
        versionsByTemplateId[t.id] = page.items;
      } catch (err) {
        console.error(
          `[agent.json] Failed to load versions for template ${t.id}:`,
          err,
        );
        versionsByTemplateId[t.id] = [];
      }
    }),
  );

  // Resolved at runtime from the root package.json via Node's auto-injected
  // `npm_package_version` env var (set by npm/pnpm when running any script,
  // including `next start` and `next dev`). Falls back to "0.0.0" when the
  // process was not launched via a package-manager script, such as unit tests
  // that construct a Request directly.
  const CINATRA_HOST_VERSION = process.env.npm_package_version ?? "0.0.0";

  const card = buildAgentCard({
    baseUrl,
    hostVersion: CINATRA_HOST_VERSION,
    // A2A consumers read authentication.tokenEndpoint to initiate the OAuth2
    // flow without needing prior knowledge of Cinatra's auth structure. Mirrors
    // what `.well-known/oauth-authorization-server` already advertises.
    tokenEndpoint: `${baseUrl}/api/auth/oauth2/token`,
    templates: templates.filter((t) => Boolean(t.packageName)),
    versionsByTemplateId,
  });

  return NextResponse.json(card, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=60",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
