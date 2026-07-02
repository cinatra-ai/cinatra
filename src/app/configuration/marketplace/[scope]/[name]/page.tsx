import { notFound } from "next/navigation";
import { RegistryEntryDetailSections } from "@cinatra-ai/agents/screens";

import { fetchPublicMarketplaceExtensionDetail } from "@cinatra-ai/marketplace-mcp-client/http-client";
import { MarketplaceMcpError } from "@cinatra-ai/marketplace-mcp-client";
import type { MarketplaceExtensionGetOutput } from "@cinatra-ai/marketplace-mcp-client";
import { requireAdminSession } from "@/lib/auth-session";
import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import {
  MarketplaceDetailHeader,
  resolveDetailFreshnessAt,
} from "@/components/marketplace-detail-header";
import {
  MarketplaceReadmeMarkdownSection,
  MarketplaceReadmeSection,
  hasRenderableReadmeMarkdown,
} from "@/components/marketplace-readme-section";

// npm package-name parts: lowercase alphanumeric + `_`, `.`, `-`, must not
// start with `.` or `_`. We accept the case-insensitive form so the route
// also accepts legacy mixed-case names. Anything outside this character
// class (slashes, angle brackets, query strings, empty segments from
// consecutive `//`, etc.) hits notFound() before reaching the marketplace.
const NAME_PART = /^[a-z0-9][a-z0-9._-]*$/i;

/** Defensive E404 detection — same shape as packages/agents/src/screens.tsx,
 * duplicated here to avoid coupling the route to the agents package for one tiny
 * helper. This is a belt-and-suspenders fallback only: the PRIMARY not-found
 * signal is `extension_get`'s `current_visibility` field (the ability returns
 * 200 with `current_visibility:"unknown"` for a missing/unlisted package — it
 * does NOT throw 404). A genuine error envelope carrying an `httpStatus`/`E404`/
 * `status:404` marker is still treated as not-found here. */
function isMarketplacePackageNotFound(error: unknown): boolean {
  if (error instanceof MarketplaceMcpError && error.httpStatus === 404) {
    return true;
  }
  const code = (error as { code?: string }).code;
  const status = (error as { status?: number; statusCode?: number }).status
    ?? (error as { status?: number; statusCode?: number }).statusCode;
  return code === "E404" || status === 404;
}

export default async function ExtensionMarketplaceEntryPage({
  params,
}: {
  params: Promise<{ scope: string; name: string }>;
}) {
  // Route-level admin gate BEFORE any marketplace read — every branch below
  // surfaces package metadata, and the agent branch carries install controls,
  // so nothing may bypass the admin check.
  await requireAdminSession();

  const { scope, name } = await params;
  if (!NAME_PART.test(scope) || !NAME_PART.test(name)) {
    notFound();
  }
  // npm scopes always start with `@`; the URL drops the leading `@` so we add it back.
  const packageName = `@${scope}/${name}`;

  // Source of truth is the storefront public REST detail endpoint: the
  // marketplace — not a direct Verdaccio read — decides what is publicly listed
  // and visible. Published-detail reads are anonymous and never create an MCP
  // session or attach a bearer. Unknown/private/unlisted packages return a real
  // 404 from the public endpoint; malformed and genuine 5xx failures still
  // propagate loudly.
  let detail: MarketplaceExtensionGetOutput;
  try {
    detail = await fetchPublicMarketplaceExtensionDetail({ packageName });
  } catch (err) {
    if (isMarketplacePackageNotFound(err)) {
      notFound();
    }
    throw err;
  }

  // Defense in depth: the public endpoint should only ever return public,
  // listed extensions. If a malformed/older endpoint returns a non-public shape,
  // fail closed instead of rendering any detail content.
  if (detail.currentVisibility !== "public") {
    notFound();
  }

  // Treat legacy "no kind" packages as agents (the historical default). The
  // agent branch routes through the Verdaccio-backed sections (the package
  // carries an agent.json payload); every other kind renders purely from the
  // marketplace `ExtensionDetail` — non-agent packages must never hit
  // `getAgentPackage` (it throws on packages without an agent payload).
  const kind: "agent" | "skill" | "connector" | "artifact" | "workflow" =
    detail.kind === "skill" ||
    detail.kind === "connector" ||
    detail.kind === "artifact" ||
    detail.kind === "workflow"
      ? detail.kind
      : "agent";

  // The detail shell mirrors the public marketplace single-extension layout
  // for ALL kinds: kind hero (emblem + name H1 + license/open-source badge),
  // freshness + version meta, README block as the primary body, license
  // surfaced — all sourced from the `ExtensionDetail` fetched above.
  return (
    <Main className="min-h-screen">
      <MarketplaceDetailHeader
        packageName={packageName}
        name={detail.name?.trim() || packageName}
        kind={kind}
        license={detail.license ?? null}
        version={detail.latestVersion}
        freshnessAt={resolveDetailFreshnessAt(detail)}
        sdkAbiRange={detail.sdkAbiRange ?? null}
        bannerUrl={detail.bannerUrl ?? null}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {kind === "agent" ? (
          // Thread the storefront-listed version (resolved here via the
          // marketplace `extension_get` ability) so that when gatekept install
          // is ON, the agent-detail manifest read authorizes the EXACT listed
          // version through the broker instead of reading registry.cinatra.ai
          // directly. `latestVersion` is the storefront-listed version; null
          // (unlisted) leaves the sections to default to "latest" under the
          // flag, and is ignored entirely when the flag is OFF.
          //
          // readmeMarkdown threads the marketplace-sourced README (the same
          // field the public Description tab renders) into the primary-body
          // README slot — the agent sections never fall back to Verdaccio's
          // entry.readme.
          <RegistryEntryDetailSections
            packageName={packageName}
            listedVersion={detail.latestVersion ?? undefined}
            readmeMarkdown={detail.readmeMarkdown ?? null}
          />
        ) : (
          <NonAgentDetailBody detail={detail} />
        )}
      </PageContent>
    </Main>
  );
}

/**
 * Body sections for non-agent kinds (skill / connector / artifact / workflow),
 * rendered purely from the marketplace `ExtensionDetail` — no Verdaccio read.
 *
 * The README slot is the primary body (mirroring the public Description tab).
 * When the listing carries `readmeMarkdown`, it renders with full markdown
 * parity (sanitizing renderer, heading demotion, editorial typography) — the
 * same treatment as the public page. A listing without a README falls back to
 * its plain-text long description; a listing with no descriptive text at all
 * omits the slot cleanly — no empty pane.
 */
function NonAgentDetailBody({ detail }: { detail: MarketplaceExtensionGetOutput }) {
  // Decide on the SANITIZED render, not the raw string: a README that
  // sanitizes down to nothing (e.g. raw HTML only) must still fall back to
  // the plain-text description instead of rendering no primary body.
  const hasReadme = hasRenderableReadmeMarkdown(detail.readmeMarkdown);
  if (hasReadme) {
    return <MarketplaceReadmeMarkdownSection markdown={detail.readmeMarkdown} />;
  }
  const fallbackText =
    detail.longDescription?.trim() || detail.description?.trim() || "";
  if (!fallbackText) {
    return null;
  }
  return (
    <MarketplaceReadmeSection>
      <p className="text-sm leading-relaxed whitespace-pre-line text-foreground">
        {fallbackText}
      </p>
    </MarketplaceReadmeSection>
  );
}
