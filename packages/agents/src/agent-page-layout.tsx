"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
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
        Outer width-controlling shell. Default narrow width matches the
        per-section caps. When ANY descendant carries `data-hitl-output="true"`
        (set by HitlApprovalCard for `:output` / `-output` renderers), the shell
        widens symmetrically — `mx-auto` keeps it centered, `w-fit` keeps the
        box only as wide as its content needs, and the `min-w-[min(48rem,100%)]`
        floor prevents the title row + tab nav from reflowing narrower than the
        existing 768px shell on wide viewports.
      */}
      <div
        className={[
          "mx-auto w-full max-w-3xl px-5 sm:px-8 lg:px-0",
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
              <InlinePageTitle
                ref={titleRef}
                value={runName}
                placeholder={templateName}
                onCommit={handleCommit}
              />
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
