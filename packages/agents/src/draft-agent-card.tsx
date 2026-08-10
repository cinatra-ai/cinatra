"use client";

// ---------------------------------------------------------------------------
// DraftAgentCard — one DRAFT row on the /agents "All Agents" picker
// (cinatra#2653).
//
// An imported agent template lands with status='draft' and was invisible on
// /agents, with no UI to find or publish it. Draft rows now render through
// this card instead of <AgentAllCard>:
//
//   • the SAME <InstalledExtensionCard> shell as every other agent row, so a
//     draft reads as an agent card — but WITH the §VI spec line (version +
//     status), carrying a visually distinct DRAFT indicator in the warning
//     accent (the run cards deliberately omit that line, so the presence of
//     the amber DRAFT kicker alone separates the two populations at a
//     glance);
//   • the primary action is Publish (a server-action call), NOT Run — a
//     draft is surfaced to be found and published; offering a run for an
//     unpublished template would promise what other members cannot resolve;
//   • no More-details modal / accent link — a draft has no marketplace
//     listing, so the accent stays inert (same rule as A2A/unscoped rows).
//
// On a successful publish the card toasts and refreshes the route; the row
// re-renders as a normal runnable agent card.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PencilLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InstalledExtensionCard } from "@/components/extensions/installed-extension-card";
import { extensionKindEmblem } from "@/components/extension-kind-emblem";
import { deriveExtensionAccent } from "@/lib/extension-accent";
import { resolveAgentCardVendor } from "@/components/extensions/agent-card-vendor";
import { toast } from "@/lib/cinatra-toast";
import { publishAgentTemplateAction } from "./publish-template-action";

/** The subset of the /agents row model a draft card renders. */
export type DraftAgentCardRow = {
  key: string;
  name: string;
  description: string;
  version: string;
  /** "local" — drafts are always Cinatra-hosted (external rows never draft). */
  host: "local" | string;
  draft: { templateId: string; staysListedAfterPublish: boolean };
};

/**
 * DRAFT status indicator — the §VI status-indicator kicker treatment
 * (mono, text-badge-2xs, bold, uppercase — same named tokens as
 * `InstalledStatusIndicator`) in the `--warning` accent with a pencil
 * glyph, so a draft reads distinctly from Active (green check), Locked
 * (green lock) and Archived (muted cross).
 */
export function DraftStatusIndicator() {
  return (
    <span
      data-slot="installed-status-indicator"
      data-status="draft"
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-badge-2xs font-bold uppercase",
        "text-warning",
      )}
      title="Imported agents land as drafts. Publish this agent to make it visible and runnable."
    >
      <PencilLine aria-hidden className="size-3 shrink-0" strokeWidth={3} />
      Draft
    </span>
  );
}

export function DraftAgentCard({ row }: { row: DraftAgentCardRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [published, setPublished] = useState(false);

  const vendor = resolveAgentCardVendor({ host: row.host, ref: row.key });

  const onPublish = () => {
    startTransition(async () => {
      try {
        const result = await publishAgentTemplateAction(row.draft.templateId);
        if (result.ok) {
          setPublished(true);
          // Honest copy (#1007 picker semantics): a HITL-less agent leaves
          // this run picker once published — never promise a card that will
          // not be there.
          toast.success(
            row.draft.staysListedAfterPublish
              ? `Published ${row.name}. It now appears as a runnable agent.`
              : `Published ${row.name}. It leaves this picker (no human-in-the-loop step) and now serves as a sub-agent and A2A/MCP agent.`,
          );
          router.refresh();
        } else {
          toast.error(result.error);
        }
      } catch {
        toast.error(`Publishing ${row.name} failed. Try again.`);
      }
    });
  };

  return (
    <InstalledExtensionCard
      name={row.name}
      accentColor={deriveExtensionAccent(row.key)}
      emblem={extensionKindEmblem("agent")}
      kindIcon={extensionKindEmblem("agent", "size-3.5")}
      kindLabel="Agent"
      vendor={vendor}
      description={row.description || undefined}
      descriptionLineClamp={2}
      // Unlike the run card, a draft DOES carry the §VI spec line: the mono
      // version plus the amber DRAFT indicator is what makes the state
      // visually distinct (cinatra#2653).
      version={row.version || undefined}
      status={<DraftStatusIndicator />}
      // No marketplace listing for a draft → inert accent, no details link.
      accentInert
      actions={
        <Button
          size="sm"
          onClick={onPublish}
          disabled={pending || published}
          aria-label={`Publish ${row.name}`}
          data-slot="draft-agent-publish"
        >
          {pending ? "Publishing…" : published ? "Published" : "Publish"}
        </Button>
      }
    />
  );
}
