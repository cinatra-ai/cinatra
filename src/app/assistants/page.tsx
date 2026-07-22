import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink, MessageSquare } from "lucide-react";
import { requireAuthSession } from "@/lib/auth-session";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { buildAssistantsDirectoryForCurrentActor } from "@/lib/assistants-directory.server";

export const metadata: Metadata = { title: "Assistants" };

// The /assistants directory (cinatra#1878 W3, AC#4). One row per assistant the
// actor may use: local assistants offer a single "Chat"; remote-capable
// assistants expand per authorized connected site with "Chat locally" (inside
// cinatra) and "Remote chat" (a jump-out to the site). Every row + link is built
// server-side by the audience-scoped, instance-authorized directory resolver.
export default async function AssistantsDirectoryPage() {
  await requireAuthSession();
  const rows = await buildAssistantsDirectoryForCurrentActor();

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Assistants"
        description="Every assistant you can use. Chat with each inside Cinatra; connected-site assistants also offer a jump-out to the site."
      />
      <PageContent className="flex flex-col gap-4 pb-8">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No assistants are available to you yet.</p>
        ) : (
          rows.map((row) => (
            <section
              key={row.packageName}
              className="soft-panel flex flex-col gap-4 rounded-card px-6 py-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-semibold text-foreground">{row.displayName}</h2>
                    <span className="text-xs text-muted-foreground">@{row.handle}</span>
                  </div>
                  {row.aliases.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Also: {row.aliases.map((a) => `@${a}`).join(", ")}
                    </p>
                  )}
                </div>
                {!row.remoteCapable && (
                  <Link
                    href={row.localChatHref}
                    className="inline-flex items-center gap-2 rounded-control border border-line bg-surface-strong px-4 py-2 text-sm font-semibold text-foreground transition hover:border-primary"
                  >
                    <MessageSquare className="size-4" />
                    Chat
                  </Link>
                )}
              </div>

              {row.remoteCapable && (
                <div className="flex flex-col gap-2">
                  {row.remoteInstances.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No connected sites you can access yet.
                    </p>
                  ) : (
                    row.remoteInstances.map((instance) => (
                      <div
                        key={instance.instanceId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line px-4 py-2"
                      >
                        <span className="text-sm text-foreground">{instance.name}</span>
                        <div className="flex items-center gap-2">
                          <Link
                            href={instance.localChatHref}
                            className="inline-flex items-center gap-2 rounded-control border border-line bg-surface-strong px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary"
                          >
                            <MessageSquare className="size-4" />
                            Chat locally
                          </Link>
                          <Link
                            href={instance.remoteHref}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-2 rounded-control border border-line px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary"
                          >
                            <ExternalLink className="size-4" />
                            Remote chat
                          </Link>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </section>
          ))
        )}
      </PageContent>
    </Main>
  );
}
