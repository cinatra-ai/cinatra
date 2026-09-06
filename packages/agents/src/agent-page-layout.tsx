"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/lib/cinatra-toast";
import { AgentInstanceNav } from "@/components/agent-instance-nav";
import type { AgentInstanceNavProps } from "@/components/agent-instance-nav";
import { InlinePageTitle, type InlinePageTitleHandle } from "@cinatra-ai/sdk-ui";
import { publishCrumbContributions } from "@/lib/breadcrumb-contributions";
import { useCrumbEpoch } from "@/components/crumb-epoch-context";
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
 * The two widths of the single-agent detail view — Application Design — Agents
 * §II "The two widths" (design spec `specs/app-agents.html`). That page
 * supersedes the per-tab width table this shell used to carry (cinatra#1161 →
 * cinatra#2487): tab identity never assigns a width, so there is no per-tab
 * lookup to maintain here.
 *
 *   Frame      Wide   max-w-3xl (48rem / 768px) — the container: title row, tab
 *                     strip, etched rule, and the body's outer bound. Centred on
 *                     the stage and CONSTANT on every tab (§I). The only thing
 *                     that ever changes it is the conditional widen in §IV.
 *   Body inset Narrow max-w-xl  (36rem / 576px) — a panel authored as a single
 *                     column of form fields or controls, flush-left inside the
 *                     frame (never re-centred, never applied to the frame).
 *
 * §II: "Wide and Narrow are the whole base vocabulary of this surface" — the
 * intermediate steps (max-w-2xl, max-w-md) and the full-width step (max-w-7xl)
 * are NOT agent-frame widths, and neither is a bespoke arbitrary value.
 */
export const AGENT_FRAME_MAX_WIDTH = "max-w-3xl";
export const AGENT_BODY_INSET_MAX_WIDTH = "max-w-xl";

/**
 * The body role a panel DECLARES — Application Design — Agents §III: "The body
 * role is declared, not inferred. A panel states which of the two roles it is;
 * nothing measures the rendered result and picks a width from it."
 *
 *   "narrow" — authored as a single column of form fields or controls.
 *   "frame"  — everything else, including any panel that mixes a form with a
 *              listing, a table, or monitoring output.
 *
 * The declaration belongs to the PANEL, not to the tab hosting it: the Setup
 * tab shows a configuration form before a run and live run progress after it,
 * and takes each panel's declared role in turn while the frame stays constant.
 */
export type AgentPanelBodyRole = "frame" | "narrow";

/**
 * Wraps one panel of an agent tab's body at its declared role (§II / §III).
 *
 * A Narrow body is flush-left — it starts at the frame's left edge and caps at
 * 576px, with the leftover space on the right. §II: "Centring the inset inside
 * the frame would make the body's left edge disagree with the title row and the
 * first tab above it, which is the same visual break the constant frame exists
 * to prevent." Hence `w-full` + a max-width and deliberately NO `mx-auto`.
 */
export function AgentPanelBody({
  role,
  className,
  children,
}: {
  role: AgentPanelBodyRole;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-panel-body={role}
      className={[
        "w-full",
        role === "narrow" ? AGENT_BODY_INSET_MAX_WIDTH : null,
        className ?? null,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}

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
  const pathname = usePathname();
  const crumbEpoch = useCrumbEpoch();

  // The ONE crumb channel (cinatra#1737): this layout owns the page header's
  // identity (the editable run title → template name → short-id placeholder,
  // ensureRunTitle populating the title on every SSR path), so it publishes
  // that same identity for the collapsed "Agents > <name>" crumb — replacing
  // the former divergent pair (the name-changed event + the AppShell
  // instance-name fetch). Rename + name-set flows update `runName`, which
  // re-publishes.
  const crumbLabel = runName || templateName || `${instanceId.slice(0, 8)}…`;
  // Epoch-capture guard (mirrors CrumbContributions): the identity this
  // layout publishes was authorized by the server render that mounted it. A
  // later epoch-context change with the SAME instance still mounted (router
  // cache re-use across a session/org change) must not republish it into the
  // new scope. A new agent/instance re-arms; renames under the armed epoch
  // keep publishing.
  const armedRef = useRef<{ identity: string; epoch: string } | null>(null);
  useEffect(() => {
    const identity = `${agentId}:${instanceId}`;
    if (armedRef.current?.identity !== identity) {
      armedRef.current = { identity, epoch: crumbEpoch };
    }
    if (armedRef.current.epoch !== crumbEpoch) return;
    const instancePath = `/agents/${agentId}/${instanceId}`;
    publishCrumbContributions(pathname, crumbEpoch, [
      { prefix: instancePath, label: crumbLabel },
      // AND NO STEP AFTER IT (cinatra#3223). The layout used to append a third
      // crumb here naming the step the run detail was showing. The ratified
      // drawing's Breadcrumb section: "A breadcrumb always reflects the
      // navigation hierarchy — the route the page sits on, not the thing the
      // page happens to be about", and "'Agents › Agent run › Review' is not a
      // possible breadcrumb — the review is read on its run's own route, under
      // that run's trail." A step is a reading inside this one route, not a
      // route of its own, so it is not a crumb at all; the rail beside the
      // detail is the you-are-here anchor.
    ]);
  }, [pathname, crumbEpoch, agentId, instanceId, crumbLabel]);
  const autoRunNumber = getAutoRunNumber(runName, templateName);

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
    // `setRunName` re-publishes the crumb contribution via the effect above
    // (the former cinatra:agent:name-changed event had exactly one listener —
    // the AppShell breadcrumb — replaced by the contribution channel, #1737).
    setRunName(newName);
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
        The frame — Application Design — Agents §I "one container, every tab".
        Title row, tab strip, etched rule and the selected tab's body all live in
        this one width-controlled container, and its base width is CONSTANT at
        Wide (768px) on every tab: "selecting a different tab changes the body
        and nothing else — the frame keeps its width, the title row keeps its
        position, the tab strip keeps its left edge, and the etched rule keeps
        its right edge."

        The one sanctioned exception is the §IV conditional widen, and it is
        caused by CONTENT, not by tab identity: when any descendant carries
        `data-hitl-output="true"` (set by HitlApprovalCard for `:output` /
        `-output` renderers) the frame takes its expanded state — `w-fit` makes
        it fit its output, `mx-auto` keeps it centred, the `min(100%,1400px)`
        monitor ceiling bounds it above and the `min(48rem,100%)` floor holds it
        out at the Frame width so a narrow burst of marked output can never drag
        the title row and tab strip inward (§IV, "the floor is part of the widen").
        Remove the marked output and the frame returns to Wide.
      */}
      <div
        data-active-tab={activeTab}
        className={[
          `mx-auto w-full ${AGENT_FRAME_MAX_WIDTH} px-5 sm:px-8 lg:px-0`,
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
