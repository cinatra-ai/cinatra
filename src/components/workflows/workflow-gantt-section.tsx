"use client";

import * as React from "react";
import { Maximize2 } from "lucide-react";

import {
  WorkflowGantt,
  VIEW_LABELS,
  VIEW_ORDER,
  VIEW_STORAGE_KEY,
  readStoredView,
  type ViewKey,
  type WorkflowGanttProps,
} from "@/components/workflows/workflow-gantt";
// SVAR override stylesheet imported AFTER WorkflowGantt — the child module
// pulls in `@svar-ui/react-gantt/style.css` first under Next.js / Turbopack
// depth-first module evaluation, so our overrides land later in source order
// and win the cascade without `!important`.
import "@/components/workflows/gantt-overrides.css";
import {
  WorkflowTaskDetail,
  type WorkflowTaskDetailRow,
} from "@/components/workflows/workflow-task-detail";
import { Badge } from "@/components/ui/badge";
import {
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
  ToolbarSeparator,
} from "@/components/ui/toolbar";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { IApi } from "@svar-ui/react-gantt";

// ---------------------------------------------------------------------------
// — Workflow Gantt section.
//
// This is the client island that owns:
//   • view state (Week/Month/Quarter/Year — persisted in localStorage)
//   • SVAR API ref (for Today / scroll-chart and future toolbar actions)
//   • fullscreen ref + the `F` keyboard toggle
//   • selected-key + Sheet open state
//   • the toolbar above the soft-panel (view Select · readonly Badge · spacer
//     · `extraToolbarItems` · separator · Today · Fullscreen)
//
//  (the prior shape that owned only the
// click-to-inspect Sheet). The toolbar moved out of `WorkflowGantt` and into
// this section per REQ WPP-01 + WPP-02 — the soft-panel is the chart's hugger
// now, with no toolbar inside.
// ---------------------------------------------------------------------------

export type WorkflowGanttSectionProps = Omit<
  WorkflowGanttProps,
  "onSelectTask" | "view" | "onApiReady" | "fullscreenRef"
> & {
  taskRows: WorkflowTaskDetailRow[];
  /**
   * Optional content rendered between the read-only badge and the Today /
   * Fullscreen view-utilities cluster. Used for the lifecycle controls
   * (Start / Pause / Resume / Cancel) + target-date control (WPP-04 / WPP-06).
   * The section renders a `flex-1` spacer immediately before this slot so the
   * view utilities anchor right and the mutations sit in the middle.
   */
  extraToolbarItems?: React.ReactNode;
};

export function WorkflowGanttSection({
  taskRows,
  tasks,
  workflowId,
  editable,
  readonlyReason,
  extraToolbarItems,
  ...ganttProps
}: WorkflowGanttSectionProps) {
  // ----- view state ---------------------------------------------------------
  // Default applied AFTER mount so SSR doesn't read localStorage.
  const [view, setView] = React.useState<ViewKey>("month");
  React.useEffect(() => setView(readStoredView()), []);
  const handleViewChange = React.useCallback((next: string) => {
    if (!next) return;
    if (!VIEW_ORDER.includes(next as ViewKey)) return;
    setView(next as ViewKey);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // localStorage may be blocked (private window); fail open.
    }
  }, []);

  // ----- SVAR API ref (from WorkflowGantt's `onApiReady`) -------------------
  const apiRef = React.useRef<IApi | null>(null);
  const [ganttApi, setGanttApi] = React.useState<IApi | null>(null);
  const handleApiReady = React.useCallback((api: IApi) => {
    apiRef.current = api;
    setGanttApi(api);
  }, []);

  // ----- fullscreen ---------------------------------------------------------
  // The section owns the ref + the toggle button + the keyboard shortcut. The
  // ref is forwarded into WorkflowGantt's shell `<div data-gantt-shell>` so
  // `document.requestFullscreen()` works against the right element.
  const fullscreenRef = React.useRef<HTMLDivElement | null>(null);
  const toggleFullscreen = React.useCallback(() => {
    const node = fullscreenRef.current;
    if (!node || !document.fullscreenEnabled) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void node.requestFullscreen();
    }
  }, []);
  React.useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key.toLowerCase() !== "f") return;
      // Let modified combos through — `⌘F`/`Ctrl+F` is browser find-in-page,
      // not our fullscreen toggle.
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const t = ev.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable='true']")) return;
      ev.preventDefault();
      toggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFullscreen]);

  // ----- selection + sheet --------------------------------------------------
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);

  const taskByKey = React.useMemo(() => {
    const m = new Map<string, WorkflowTaskDetailRow>();
    for (const t of taskRows) m.set(t.key, t);
    return m;
  }, [taskRows]);

  // Enrich the Gantt task shape with the tooltip-relevant fields from taskRows
  // (agentPackage + dependsOn) so the hover Tooltip can render workflow-aware
  // context without round-tripping through Sheet state.
  const enrichedTasks = React.useMemo(
    () =>
      tasks.map((t) => {
        const row = taskByKey.get(t.key);
        return {
          ...t,
          agentPackage: row?.agentPackage ?? null,
          dependsOn: row?.dependsOn ?? [],
        };
      }),
    [tasks, taskByKey],
  );

  const handleSelect = React.useCallback((key: string) => {
    setSelectedKey(key);
    setOpen(true);
  }, []);

  const handleOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setSelectedKey(null);
  }, []);

  React.useEffect(() => {
    if (selectedKey && !taskByKey.has(selectedKey)) {
      setSelectedKey(null);
      setOpen(false);
    }
  }, [selectedKey, taskByKey]);

  // ----- render -------------------------------------------------------------
  return (
    <div className="flex flex-col gap-3" data-testid="workflow-gantt-section">
      {/*
        Toolbar sits ABOVE the soft-panel (which hugs the chart). It replaces
        the section rule between PageHeader and the panel.

        GVP-04 layout, left → right:
          Today · view Select · readonly Badge · [extraToolbarItems
          (Target date + lifecycle Start/Pause/Resume/Cancel)] · spacer ·
          Fullscreen
        Fullscreen anchors far-right; lifecycle Cancel sits in extraToolbarItems.
      */}
      <Toolbar aria-label="Timeline controls">
        <ToolbarGroup>
          <ToolbarButton
            type="button"
            disabled={!ganttApi}
            onClick={() => apiRef.current?.exec("scroll-chart", { date: new Date() })}
          >
            Today
          </ToolbarButton>
        </ToolbarGroup>
        <ToolbarGroup role="group" aria-label="Timeline view">
          {/* View switcher is a compact <Select> with a toolbar-matched
              trigger (no shadcn default bordered chrome). */}
          <Select value={view} onValueChange={handleViewChange}>
            <SelectTrigger
              size="sm"
              className="h-[34px] w-[96px] border-transparent bg-transparent px-3 text-[12.5px] font-medium shadow-none data-[size=sm]:h-[34px] focus-visible:ring-1"
              aria-label="Timeline scale"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {VIEW_ORDER.map((v) => (
                  <SelectItem key={v} value={v}>
                    {VIEW_LABELS[v]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </ToolbarGroup>
        {!editable && (
          <>
            <ToolbarSeparator />
            <TooltipProvider delayDuration={120}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="secondary" className="cursor-help">
                    Read-only{readonlyReason ? ` · ${readonlyReason}` : ""}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  Drag-to-reschedule, dependency editing, and deletion require manage access on a draft or paused workflow.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </>
        )}
        {extraToolbarItems}
        {/* Spacer pushes Fullscreen to the far right. */}
        <div aria-hidden className="flex-1" />
        <ToolbarGroup>
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <ToolbarButton
                  type="button"
                  onClick={toggleFullscreen}
                  aria-label="Toggle fullscreen (F)"
                >
                  {/* <Maximize2> icon precedes the label, ~13px to match the
                      design spec toolbar mockup. */}
                  <Maximize2 className="size-3.5" aria-hidden />
                  <span className="ml-1.5">Fullscreen</span>
                </ToolbarButton>
              </TooltipTrigger>
              <TooltipContent>
                F = fullscreen (Esc to exit). Right-click any bar for the task menu. Ctrl/⌘ + wheel to zoom.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </ToolbarGroup>
      </Toolbar>
      {/*
        WPP-13: soft-panel hugs the chart. The Gantt's intrinsic
        height (set by the shell `style={{ height: 480 }}` inside WorkflowGantt)
        + standard panel padding is the panel's full height; no excess.
      */}
      <div className="soft-panel">
        <WorkflowGantt
          {...ganttProps}
          workflowId={workflowId}
          tasks={enrichedTasks}
          editable={editable}
          readonlyReason={readonlyReason}
          view={view}
          onApiReady={handleApiReady}
          fullscreenRef={fullscreenRef}
          onSelectTask={handleSelect}
          selectedKey={selectedKey}
        />
      </div>
      <WorkflowTaskDetail
        task={selectedKey ? taskByKey.get(selectedKey) ?? null : null}
        open={open}
        onOpenChange={handleOpenChange}
        displayTz={ganttProps.displayTz}
      />
    </div>
  );
}
