"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/lib/cinatra-toast";
import { AgentInstanceNav } from "@/components/agent-instance-nav";
import type { AgentInstanceNavProps } from "@/components/agent-instance-nav";
import { InlinePageTitle, type InlinePageTitleHandle } from "@cinatra-ai/sdk-ui";
import { saveRunName } from "./run-name-actions";

type AgentPageLayoutProps = {
  agentId: string;
  instanceId: string;
  activeTab: AgentInstanceNavProps["activeTab"];
  templateName: string;
  description?: string;
  actions?: ReactNode;
  initialRunName: string;
  runId: string | null;
  isPublished?: boolean;
  showTriggerTab?: boolean;
  extensionIdentifier?: string | null;
  extensionHref?: string | null;
  children: ReactNode;
};

/**
 * Detects the auto-generated run-name shape produced by ensureRunTitle
 * (store.ts: `${templateName} (${n})`) and returns `n`, or null for a
 * custom name. Drives the "(N)" suffix explainer tooltip so the hint only
 * appears while the ambiguous auto-number is actually displayed.
 */
export function getAutoRunNumber(runName: string, templateName: string): number | null {
  const prefix = `${templateName} (`;
  if (!runName.startsWith(prefix) || !runName.endsWith(")")) return null;
  const digits = runName.slice(prefix.length, -1);
  return /^\d+$/.test(digits) ? Number(digits) : null;
}

/**
 * Per-tab base content width (cinatra#1161 — owner decision: option 1, per-tab
 * widths). The design system uses a GRADED content-width scale, not one
 * universal width (Application Design system, §VII "Content widths"):
 *
 *   run     → Full   max-w-7xl (1280px) — run-detail is an entity-detail + data-output
 *                    surface; §VII Full covers "dashboards, lists, tables, settings,
 *                    entity detail". Matches PageContent (every other surface).
 *   setup   → Medium max-w-2xl (672px)  — §VII Medium is literally "the /setup ·
 *                    onboarding column".
 *   trigger → Narrow max-w-xl  (576px)  — a single-column schedule/control form;
 *                    §VII Narrow is "single-column forms and control stacks".
 *   permissions / overview → Wide max-w-3xl (768px) — UNCHANGED from the prior
 *                    single-shell default; these tabs are outside the #1161 ruling.
 *
 * The output-HITL widen (`data-hitl-output`) is preserved on EVERY tab below so
 * wide approval output still gets room (symmetric, centred) regardless of the
 * per-tab base width — the run/HITL surface keeps the existing widen behaviour.
 */
export const TAB_CONTENT_MAX_WIDTH: Record<AgentInstanceNavProps["activeTab"], string> = {
  run: "max-w-7xl",
  setup: "max-w-2xl",
  trigger: "max-w-xl",
  permissions: "max-w-3xl",
  overview: "max-w-3xl",
};

export function AgentPageLayout({
  agentId,
  instanceId,
  activeTab,
  templateName,
  description,
  actions,
  initialRunName,
  runId,
  isPublished,
  showTriggerTab = false,
  extensionIdentifier,
  extensionHref,
  children,
}: AgentPageLayoutProps) {
  const [runName, setRunName] = useState(initialRunName);
  const titleRef = useRef<InlinePageTitleHandle>(null);
  const autoRunNumber = getAutoRunNumber(runName, templateName);
  const contentMaxWidth = TAB_CONTENT_MAX_WIDTH[activeTab];

  // Listen for cross-component name updates from HitlApprovalCard:
  //   "cinatra:agent:name-set"  — auto-generated or confirmed name; update displayed value
  //   "cinatra:agent:edit-name" — duplicate detected; open InlinePageTitle in edit mode
  useEffect(() => {
    const handleNameSet = (e: Event) => {
      const name = (e as CustomEvent<{ name: string }>).detail?.name;
      if (typeof name === "string") setRunName(name);
    };
    const handleEditName = () => titleRef.current?.enterEdit();
    window.addEventListener("cinatra:agent:name-set", handleNameSet);
    window.addEventListener("cinatra:agent:edit-name", handleEditName);
    return () => {
      window.removeEventListener("cinatra:agent:name-set", handleNameSet);
      window.removeEventListener("cinatra:agent:edit-name", handleEditName);
    };
  }, []);

  function handleCommit(newName: string) {
    setRunName(newName);
    window.dispatchEvent(new CustomEvent("cinatra:agent:name-changed", { detail: { name: newName } }));
    if (runId) {
      saveRunName(runId, newName).then((result) => {
        if (!result.ok) {
          toast.error("Could not save run name");
        }
      }).catch(() => {
        toast.error("Could not save run name");
      });
    }
  }

  return (
    <>
      {/*
        Outer width-controlling shell. The base max-width is chosen PER TAB from
        the design system's graded content-width scale (TAB_CONTENT_MAX_WIDTH,
        §VII — cinatra#1161): run → Full (7xl), setup → Medium (2xl), trigger →
        Narrow (xl), permissions/overview → Wide (3xl). When ANY descendant
        carries `data-hitl-output="true"` (set by HitlApprovalCard for `:output`
        / `-output` renderers), the shell widens symmetrically regardless of tab
        — `mx-auto` keeps it centered, `w-fit` keeps the box only as wide as its
        content needs, and the `min-w-[min(48rem,100%)]` floor prevents the title
        row + tab nav from reflowing narrower than the 768px reading shell on
        wide viewports.
      */}
      <div
        data-active-tab={activeTab}
        className={[
          `mx-auto w-full ${contentMaxWidth} px-5 sm:px-8 lg:px-0`,
          "transition-[max-width] duration-200 ease-out",
          "[&:has([data-hitl-output='true'])]:max-w-[min(100%,1400px)]",
          "[&:has([data-hitl-output='true'])]:w-fit",
          "[&:has([data-hitl-output='true'])]:min-w-[min(48rem,100%)]",
        ].join(" ")}
      >
        {/* Title row — same alignment as PageHeader */}
        <section className="mb-2 pt-5 lg:pt-2">
          <div className="flex items-start justify-between gap-4">
            {/* flex-1 min-w-0: gives InlinePageTitle a defined width so max-w-full caps the edit card correctly */}
            <div className="flex flex-1 min-w-0 flex-col gap-1">
              {extensionIdentifier && extensionHref && (
                <Link
                  href={extensionHref}
                  className="w-fit max-w-full truncate font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  {extensionIdentifier}
                </Link>
              )}
              <div className="flex min-w-0 items-center gap-2">
                <InlinePageTitle
                  ref={titleRef}
                  value={runName}
                  placeholder={templateName}
                  onCommit={handleCommit}
                />
                {/* "(N)" suffix explainer — same Info-icon tooltip pattern as
                    the run surface's stepper hints (orchestrator-stepper-panel). */}
                {autoRunNumber !== null && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        tabIndex={0}
                        aria-label={`Run number ${autoRunNumber} — runs of this agent are numbered automatically to keep their names unique`}
                        className="shrink-0 text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-default"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[220px] whitespace-normal text-left">
                      Runs of this agent are numbered automatically — ({autoRunNumber}) keeps
                      this run&apos;s name unique. Rename it anytime with the pencil.
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
            {isPublished === false && (
              <Badge variant="secondary" className="shrink-0 self-center">Unpublished</Badge>
            )}
            {actions && (
              <div className="flex shrink-0 items-center gap-3 pt-1">{actions}</div>
            )}
          </div>
        </section>

        {/* Tab navigation — directly below title */}
        <div className="mb-4">
          <AgentInstanceNav
            agentId={agentId}
            instanceId={instanceId}
            activeTab={activeTab}
            includeSetupTab
            showTriggerTab={showTriggerTab}
          />
        </div>

        {/* Content area */}
        <div className="flex flex-col gap-6 pb-8">
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
          {children}
        </div>
      </div>
    </>
  );
}
