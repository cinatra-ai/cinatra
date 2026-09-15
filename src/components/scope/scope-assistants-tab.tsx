"use client";

// ---------------------------------------------------------------------------
// ScopeAssistantsTab — the Assistants tab of a scope page (cinatra#2808,
// per-scope surfaces S2).
//
// "Assistants tab: reuse the directory resolver parameterized by the viewed
//  scope (inject the predicate — never a value import of `scope-filter`) and
//  EXTEND the rows around the preserved Chat button(s) with Settings
//  (Skills-only page) and the installed-card fields."
//
// So this adds NO new card and NO new modal: it is the published §VI
// Installed-extensions card (<InstalledExtensionCard>) carrying the directory
// resolver's own Chat affordances unchanged — a single "Chat" for a local
// assistant, "Chat locally" + "Remote chat" per authorized instance for a
// remote-capable one — with the Settings control and the card's version/status
// fields around them, and the ratified extension-detail modal behind "More
// details".
//
// The hrefs are NOT composed here: every one arrives already minted by #2809's
// contract (`src/lib/scope-surfaces.ts`), so this component and that contract
// cannot disagree about an address.
// ---------------------------------------------------------------------------

import { MessageSquare, Settings, ExternalLink } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  InstalledExtensionCard,
  InstalledStatusIndicator,
} from "@/components/extensions/installed-extension-card";
import { AgentDetailModal } from "@/components/extensions/agent-detail-modal";
import { extensionKindEmblem } from "@/components/extension-kind-emblem";
import { deriveExtensionAccent } from "@/lib/extension-accent";
import { resolveVendorPresentation } from "@/lib/vendor-presentation";
import type { MarketplaceDetailLoadResult } from "@/lib/marketplace-detail-view";

/** One authorized connected site of a remote-capable assistant. */
export type ScopeAssistantRemoteInstance = {
  instanceId: string;
  name: string;
  /** Site-scoped chat INSIDE cinatra, at THIS scope. */
  localChatHref: string;
  /** The jump-out to the connected site itself. */
  remoteHref: string;
};

/** One assistant row of a scope's Assistants tab. */
export type ScopeAssistantRow = {
  packageName: string;
  vendor: string;
  slug: string;
  displayName: string;
  description?: string | null;
  /** Installed-card fields (cinatra#2808); absent while unknown. */
  version?: string | null;
  status?: "active" | "locked";
  /** The single local "Chat" action, at this scope. */
  localChatHref: string;
  /** The Skills-only settings page for this assistant at this scope. */
  settingsHref: string;
  /** Authorized connected sites; `[]` for a local-only assistant. */
  remoteInstances: ScopeAssistantRemoteInstance[];
};

export function ScopeAssistantsTab({
  rows,
  loadDetail,
}: {
  rows: readonly ScopeAssistantRow[];
  /** Fixture-only detail loader override, threaded to the ratified modal. */
  loadDetail?: (packageName: string) => Promise<MarketplaceDetailLoadResult>;
}) {
  return (
    <section className="grid grid-cols-1 gap-4" data-testid="scope-assistants-list">
      {rows.map((row) => (
        <ScopeAssistantCard key={row.packageName} row={row} loadDetail={loadDetail} />
      ))}
    </section>
  );
}

function ScopeAssistantCard({
  row,
  loadDetail,
}: {
  row: ScopeAssistantRow;
  loadDetail?: (packageName: string) => Promise<MarketplaceDetailLoadResult>;
}) {
  const vendor = resolveVendorPresentation(
    { name: row.vendor, storeUrl: null },
    { surface: "scope-assistants-tab", ref: row.packageName },
  );
  return (
    <InstalledExtensionCard
      name={row.displayName}
      accentColor={deriveExtensionAccent(row.packageName)}
      emblem={extensionKindEmblem("agent")}
      kindIcon={extensionKindEmblem("agent", "size-3.5")}
      kindLabel="Assistant"
      vendor={vendor}
      description={row.description || undefined}
      // Version and lifecycle indicator arrive together or not at all — the §VI
      // spec line is both (cinatra#948 reopen, gap 3).
      {...(row.version && row.status
        ? {
            version: row.version,
            status: <InstalledStatusIndicator status={row.status} />,
          }
        : {})}
      actions={
        <>
          {/* THE CHAT BUTTON(S), PRESERVED. A local assistant keeps its single
              "Chat"; a remote-capable one keeps the resolver's per-instance
              pair. Only their addresses are the scope's — the affordances are
              the /assistants directory's own, unchanged. */}
          {row.remoteInstances.length === 0 ? (
            <Button asChild size="sm">
              <Link href={row.localChatHref} data-slot="scope-assistant-chat">
                <MessageSquare data-icon="inline-start" aria-hidden="true" />
                Chat
              </Link>
            </Button>
          ) : (
            row.remoteInstances.map((instance) => (
              <span key={instance.instanceId} className="inline-flex items-center gap-2">
                <Button asChild size="sm">
                  <Link
                    href={instance.localChatHref}
                    data-slot="scope-assistant-chat-local"
                    aria-label={`Chat locally with ${row.displayName} on ${instance.name}`}
                  >
                    <MessageSquare data-icon="inline-start" aria-hidden="true" />
                    Chat locally
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link
                    href={instance.remoteHref}
                    data-slot="scope-assistant-chat-remote"
                    aria-label={`Remote chat with ${row.displayName} on ${instance.name}`}
                  >
                    <ExternalLink data-icon="inline-start" aria-hidden="true" />
                    Remote chat
                  </Link>
                </Button>
              </span>
            ))
          )}
          {/* Settings — the Skills-only page for this assistant at this scope,
              on #2809's address. The assignment epic owns its contents. */}
          <Button asChild size="sm" variant="outline">
            <Link href={row.settingsHref} data-slot="scope-assistant-settings">
              <Settings data-icon="inline-start" aria-hidden="true" />
              Settings
            </Link>
          </Button>
          {/* "More details" opens THE ratified extension-detail modal — the same
              member-gated wrapper over <MarketplaceDetailModal> the agent card
              opens. No second modal and no detail page: this surface is
              member-facing, so it carries no `/configuration` link and the
              modal's own button is the opener. */}
          <AgentDetailModal
            name={row.displayName}
            description={row.description}
            packageName={row.packageName}
            loadDetail={loadDetail}
          />
        </>
      }
    />
  );
}
