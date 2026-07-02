import "server-only";
import type { Metadata } from "next";
import Link from "next/link";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import type { ComponentType } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BlogConnectorSelect } from "./blog-connector-select";
import { listWordPressInstances, getWordPressAPIStatus } from "@/lib/wordpress-api";
import { getNangoFrontendConfig, getNangoStatus } from "@/lib/nango-system";
import { setWordPressBlogConnectorAction } from "@/app/campaigns/actions";
// The connection UI exposes the per-instance blog-connector selector.
// The registered set comes from the blog-connector facade registry
// (boot-populated via src/lib/register-blog-providers.ts, imported here as a
// side-effect).
import "@/lib/register-blog-providers";
// Connector server modules resolve through the generated extension manifest —
// this mount names no connector package. Instance hard-delete uses the
// connector's manage-gated action (a single org-admin `requireExtensionAction`
// gate shared with the dispatch-route settings page); the blog-connector
// selector action stays host-side.
import { requireConnectorModule } from "@/lib/connector-modules.server";

type WordPressConnectorModule = {
  WordPressNangoConnectCard: ComponentType<{
    nangoFrontendConfig: ReturnType<typeof getNangoFrontendConfig>;
    connectionServiceReady: boolean;
  }>;
  deleteWordPressInstanceAction: (formData: FormData) => Promise<void>;
};

type BlogConnectorModule = {
  listInstalledBlogConnectors: () => Array<{
    definition: { connectorId: string; name: string };
  }>;
};

export const metadata: Metadata = { title: "WordPress | Cinatra" };

export default async function WordPressPage() {
  const [{ WordPressNangoConnectCard, deleteWordPressInstanceAction }, blogModule] =
    await Promise.all([
      requireConnectorModule<WordPressConnectorModule>("wordpress-mcp-connector"),
      requireConnectorModule<BlogConnectorModule>("blog-connector"),
    ]);
  const [instances, status] = await Promise.all([
    listWordPressInstances(),
    Promise.resolve(getWordPressAPIStatus()),
  ]);
  const nangoFrontendConfig = getNangoFrontendConfig();
  const nangoStatus = getNangoStatus();
  const blogConnectors = blogModule.listInstalledBlogConnectors().map((c) => ({
    connectorId: c.definition.connectorId,
    name: c.definition.name,
  }));

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="WordPress"
        description="Connect one or more self-hosted WordPress instances so Cinatra can create formatted blog post drafts directly in each site's admin area."
        actions={
          <span className="badge rounded-full px-3 py-1 text-xs uppercase">
            {status.status === "connected" ? `${instances.length} connected` : "Setup required"}
          </span>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <WordPressNangoConnectCard
          nangoFrontendConfig={nangoFrontendConfig}
          connectionServiceReady={nangoStatus.status === "connected"}
        />
        <div className="grid gap-4">
          {instances.length === 0 ? (
            <div className="rounded-panel border border-dashed border-line bg-surface-muted px-5 py-5 text-sm text-muted-foreground">
              No WordPress instances configured yet.
            </div>
          ) : (
            instances.map((instance) => (
              <article key={instance.id} className="rounded-panel border border-line bg-surface px-5 py-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-semibold text-foreground">{instance.name}</h3>
                    <p className="mt-2 text-sm text-muted-foreground">{instance.siteUrl}</p>
                    <p className="mt-1 text-xs uppercase tracking-[0.2em] text-muted-foreground">
                      Username: {instance.username}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <Link
                      href={`${instance.siteUrl}/wp-admin/`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center rounded-control border border-line bg-surface-strong px-4 py-3 text-sm font-semibold text-foreground transition hover:bg-surface-muted"
                    >
                      Open admin
                    </Link>
                    <form action={deleteWordPressInstanceAction}>
                      <Input type="hidden" name="instanceId" value={instance.id} />
                      <Button
                        type="submit"
                        variant="outline"
                        formNoValidate
                        className="inline-flex items-center justify-center rounded-control border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive transition hover:bg-destructive/15"
                      >
                        Remove
                      </Button>
                    </form>
                  </div>
                </div>
                {/* Blog-connector selector. */}
                <form
                  action={setWordPressBlogConnectorAction}
                  className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4"
                >
                  <Input type="hidden" name="instanceId" value={instance.id} />
                  <label
                    htmlFor={`blogConnectorId-${instance.id}`}
                    className="text-xs uppercase tracking-[0.2em] text-muted-foreground"
                  >
                    Blog connector
                  </label>
                  <BlogConnectorSelect
                    id={`blogConnectorId-${instance.id}`}
                    name="blogConnectorId"
                    defaultValue={instance.blogConnectorId ?? "default"}
                    options={blogConnectors.map((c) => ({
                      value: c.connectorId,
                      label: c.name,
                    }))}
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    className="inline-flex items-center justify-center rounded-control border border-line bg-surface-strong px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-surface-muted"
                  >
                    Save connector
                  </Button>
                </form>
              </article>
            ))
          )}
        </div>
      </PageContent>
    </Main>
  );
}
