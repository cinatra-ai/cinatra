"use client";

/**
 * The ASSISTANTS tab body of every scope base (cinatra#2808, per-scope surfaces
 * S2).
 *
 * The rows are the /assistants directory resolver's own rows, re-addressed at
 * the viewed scope, drawn on the SAME `InstalledExtensionCard` the §III
 * Installed-extensions surface uses. The issue's change item 3 is followed
 * exactly: the Chat control(s) are PRESERVED — one "Chat" for a local
 * assistant, and the "Chat locally" / "Remote chat" pair per authorized
 * connected site for a remote-capable one — and the row is EXTENDED around them
 * with the Settings text link and the installed-card fields (emblem, name,
 * vendor, description). The row draws the §IV card, so it carries NO version
 * and NO Active / Archived indicator (design#156, owner decision 2026-09-15).
 *
 * "More details" opens the ratified extension-detail modal in place, exactly as
 * it does on an agent card, so a member reading a scope reaches the package's
 * detail without a link into the admin-only marketplace route.
 */
import { useState } from "react";
import Link from "next/link";
import { ExternalLink, MessagesSquare } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { AgentDetailModal } from "@/components/extensions/agent-detail-modal";
import { InstalledExtensionCard } from "@/components/extensions/installed-extension-card";
import { extensionKindEmblem } from "@/components/extension-kind-emblem";
import { resolveAgentCardVendor } from "@/components/extensions/agent-card-vendor";
import { deriveExtensionAccent } from "@/lib/extension-accent";
import { cn } from "@/lib/utils";
import type { ScopeAssistantCardRow } from "@/lib/scope-surface-rows";

export function ScopeAssistantsTab({ rows }: { rows: readonly ScopeAssistantCardRow[] }) {
  return (
    <section className="grid grid-cols-1 gap-4" data-testid="scope-assistants-list">
      {rows.map((row) => (
        <ScopeAssistantCard key={row.key} row={row} />
      ))}
    </section>
  );
}

function ScopeAssistantCard({ row }: { row: ScopeAssistantCardRow }) {
  const [open, setOpen] = useState(false);
  // The SAME resolver the agent card uses — an assistant shipped by Cinatra
  // resolves to the genuine display name, never a package scope read as a brand.
  const vendor = resolveAgentCardVendor({ host: "local", ref: row.packageName });

  return (
    <InstalledExtensionCard
      name={row.displayName}
      accentColor={deriveExtensionAccent(row.key)}
      emblem={extensionKindEmblem("agent")}
      kindIcon={extensionKindEmblem("agent", "size-3.5")}
      kindLabel="Assistant"
      vendor={vendor}
      description={row.description || undefined}
      onAccentActivate={() => setOpen(true)}
      accentLabel={`View details for ${row.displayName}`}
      actions={
        <>
          {/* The Chat control(s), PRESERVED. A local assistant keeps its single
              Chat; a remote-capable one keeps one pair per authorized connected
              site — only the in-app half carries the scope, because the
              jump-out addresses the site itself. */}
          {!row.remoteCapable ? (
            <Button asChild size="sm">
              <Link href={row.chatHref} data-slot="scope-assistant-chat">
                <MessagesSquare data-icon="inline-start" aria-hidden="true" />
                Chat
              </Link>
            </Button>
          ) : row.remoteInstances.length === 0 ? (
            /* PRESERVED from the directory: a remote-capable assistant with no
               connected site the reader may use states that truth — it never
               offers an in-app Chat the remote assistant has no site to run on. */
            <span className="text-xs text-muted-foreground" data-slot="scope-assistant-no-sites">
              No connected sites you can access yet.
            </span>
          ) : (
            row.remoteInstances.map((instance) => (
              <span key={instance.instanceId} className="inline-flex items-center gap-2">
                {/* The site's own name, as the directory names it — a pair
                    without it cannot be told from the next site's pair. */}
                <span className="text-sm text-foreground">{instance.name}</span>
                <Button asChild size="sm">
                  <Link href={instance.localChatHref} data-slot="scope-assistant-chat">
                    <MessagesSquare data-icon="inline-start" aria-hidden="true" />
                    Chat locally
                  </Link>
                </Button>
                {/* The jump-out to the connected site, in the shadcn link
                    pattern the design-system boundary names (Button asChild over
                    Link) rather than a raw anchor — the destination is external,
                    so it keeps target/rel exactly as it had them. */}
                <Button asChild size="sm" variant="outline">
                  <Link
                    href={instance.remoteHref}
                    target="_blank"
                    rel="noreferrer noopener"
                    data-slot="scope-assistant-remote-chat"
                    aria-label={`Remote chat on ${instance.name}`}
                  >
                    <ExternalLink data-icon="inline-start" aria-hidden="true" />
                    Remote chat
                  </Link>
                </Button>
              </span>
            ))
          )}
          {/* §IV (design#156): the same right panel as the agent card — "the
              same two text links", Settings to the left of More details, side by
              side in one row. The Settings link opens the assistant's §VII
              assignment page, the Skills pane alone. */}
          <div className="flex items-center gap-2.5">
            <Link
              href={row.settingsHref}
              data-slot="scope-assistant-settings"
              className={cn(buttonVariants({ variant: "link", size: "sm" }), "underline")}
            >
              Settings
            </Link>
            <AgentDetailModal
              name={row.displayName}
              description={row.description}
              packageName={row.packageName}
              detailHref={null}
              open={open}
              onOpenChange={setOpen}
            />
          </div>
        </>
      }
    />
  );
}
