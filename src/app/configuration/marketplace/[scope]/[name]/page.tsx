import Link from "next/link";
import { notFound } from "next/navigation";
import { RegistryEntryDetailScreen } from "@cinatra-ai/agents/screens";

import { fetchPublicMarketplaceExtensionDetail } from "@cinatra-ai/marketplace-mcp-client/http-client";
import { MarketplaceMcpError } from "@cinatra-ai/marketplace-mcp-client";
import type { MarketplaceExtensionGetOutput } from "@cinatra-ai/marketplace-mcp-client";
import { requireAdminSession } from "@/lib/auth-session";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

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
  // Route-level admin gate BEFORE any marketplace read — both the agent-
  // detail and non-agent-placeholder branches surface package metadata,
  // so neither may bypass the admin check that `RegistryEntryDetailScreen`
  // would normally enforce.
  await requireAdminSession();

  const { scope, name } = await params;
  if (!NAME_PART.test(scope) || !NAME_PART.test(name)) {
    notFound();
  }
  // npm scopes always start with `@`; the URL drops the leading `@` so we add it back.
  const packageName = `@${scope}/${name}`;

  // Kind-check BEFORE rendering RegistryEntryDetailScreen — that screen
  // calls agent-only `getAgentPackage` which throws on packages without
  // an `agent.json` payload (i.e. every non-agent kind). For non-agent
  // kinds we render a minimal placeholder.
  //
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
  // fail closed instead of falling through to RegistryEntryDetailScreen.
  if (detail.currentVisibility !== "public") {
    notFound();
  }

  // Treat legacy "no kind" packages as agents (the historical default).
  const nonAgentKind: "skill" | "connector" | "artifact" | "workflow" | null =
    detail.kind === "skill" ||
    detail.kind === "connector" ||
    detail.kind === "artifact" ||
    detail.kind === "workflow"
      ? detail.kind
      : null;
  if (nonAgentKind !== null) {
    return <NonAgentDetailPlaceholder packageName={packageName} kind={nonAgentKind} />;
  }
  // Thread the storefront-listed version (resolved here via the marketplace
  // `extension_get` ability) so that when gatekept install is ON, the agent-
  // detail manifest read authorizes the EXACT listed version through the broker
  // instead of reading registry.cinatra.ai directly. `latestVersion` is the
  // storefront-listed version; null (unlisted) leaves the screen to default to
  // "latest" under the flag, and is ignored entirely when the flag is OFF.
  return (
    <RegistryEntryDetailScreen
      packageName={packageName}
      listedVersion={detail.latestVersion ?? undefined}
    />
  );
}

function NonAgentDetailPlaceholder({
  packageName,
  kind,
}: {
  packageName: string;
  kind: "skill" | "connector" | "artifact" | "workflow";
}) {
  const KIND_LABEL: Record<typeof kind, string> = {
    skill: "Skill",
    connector: "Connector",
    artifact: "Artifact",
    workflow: "Workflow",
  };
  return (
    <Main className="min-h-screen">
      <PageHeader
        title={packageName}
        description={`${KIND_LABEL[kind]} extension`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/configuration/marketplace">Back to marketplace</Link>
          </Button>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Alert>
          <AlertTitle>Kind-specific detail view coming soon</AlertTitle>
          <AlertDescription>
            This {KIND_LABEL[kind].toLowerCase()} extension is published and
            installable from the marketplace, but a dedicated detail page for{" "}
            {KIND_LABEL[kind].toLowerCase()} packages hasn&apos;t shipped yet.
            For now you can install it from the marketplace list or via{" "}
            <code className="rounded bg-surface-strong px-1 py-0.5 text-xs">
              cinatra extensions install {packageName}
            </code>
            .
          </AlertDescription>
        </Alert>
      </PageContent>
    </Main>
  );
}
