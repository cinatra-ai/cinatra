"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  ContextMenu as SvarContextMenu,
  Gantt,
  HeaderMenu as SvarHeaderMenu,
  Tooltip as SvarTooltip,
  Willow,
  WillowDark,
  type IApi,
  type IColumnConfig,
  type ITask,
} from "@svar-ui/react-gantt";
import "@svar-ui/react-gantt/style.css";
import { toast } from "@/lib/cinatra-toast";
import { RenderErrorBoundary } from "@/components/render-error-boundary";
import { Badge } from "@/components/ui/badge";
import { StatusPill } from "@/components/ui/status-pill";
import {
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
  ToolbarSeparator,
} from "@/components/ui/toolbar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { workflowTaskStatusToPill, type WorkflowTaskStatus } from "@/lib/status-adapter";
import { computeActualBarMetrics } from "@/components/workflows/workflow-gantt-metrics";

// ---------------------------------------------------------------------------
// Workflow Gantt.
//
// Embeds vanilla `@svar-ui/react-gantt`. UI primitives:
//   - view switcher (Toolbar `<ToolbarButton active>` cluster) swaps SVAR `scales` + `cellWidth` per view
//   - taskTemplate renders status-dot + title + type-letter INSIDE the SVAR bar
//   - api.on("select-task") forwards the selected key to the parent (Sheet)
//   - drag/resize commits via api.on("update-task") -> applyWindow CAS
//   - add-link / delete-link / delete-task gated through intercepts
//
// SVAR specifics:
//   - scale format strings are SVAR `dateToString` tokens (%M, %F, %j, %W, %Q),
//     NOT date-fns. https://docs.svar.dev/react/gantt/guides/configuration/configure_scales
//   - drag-init threshold ~20px and dx rounds to lengthUnitWidth; cellWidth=100
//     means a <50px drag rounds to zero days (apparent snap-back). Per-view
//     cellWidth shrinks the threshold; we also surface a toast when a drag
//     yielded no commit so the user gets explicit feedback.
//   - taskTemplate is content-level (renders INSIDE .wx-bar); drag handles
//     and link chrome stay intact.
// ---------------------------------------------------------------------------

export type GanttTaskInput = {
  key: string;
  title: string;
  // Mirrors the workflow_task.type domain
  // (agent_task/approval/manual/notification/wait/checkpoint).
  type: "checkpoint" | "agent_task" | "approval" | "manual" | "notification" | "wait";
  startUtc: string | null;
  endUtc: string | null;
  dueUtc: string | null;
  status: WorkflowTaskStatus;
  /** Surfaced inside the hover Tooltip (only for agent_task rows). */
  agentPackage?: string | null;
  /** Upstream task keys this task depends on (Tooltip context). */
  dependsOn?: string[];
  /** Hierarchy parent — the KEY of another task in the same workflow.
   *  A task referenced as `parent` by any other task
   *  renders as a SVAR summary/rollup bar with its window derived from its
   *  children server-side; collapse/expand state persists per user. */
  parent?: string | null;
  /** Critical-path membership  — server-computed via
   *  CPM forward/backward pass; client highlights the bar via the
   *  `gantt-critical-path` class on our wrapper span. */
  isCriticalPath?: boolean;
  /** Actual-start instant  — populated for tasks that have
   *  started (status `running`/`succeeded`/`failed`/`skipped`/`cancelled`).
   *  Drives the inner `.gantt-actual-bar` planned-vs-actual overlay. */
  actualStartUtc?: string | null;
  /** Actual-end instant  — populated for completed tasks. A
   *  running task has `actualStart` set + `actualEnd` null; the overlay
   *  clamps the visible width to `now`. */
  actualEndUtc?: string | null;
};

export type GanttLinkInput = { source: string; target: string };

type EditResult = { ok: boolean; reason?: string; lockVersion?: number; dependents?: string[] };

export type WorkflowGanttProps = {
  /** Owning workflow id — used to build the "Open in chat" deep link. */
  workflowId: string;
  tasks: GanttTaskInput[];
  links: GanttLinkInput[];
  editable?: boolean;
  /** Short reason ("Workflow is active.") shown next to the read-only chip when `editable=false`. */
  readonlyReason?: string;
  lockVersion?: number;
  applyWindow?: (taskKey: string, startUtc: string, endUtc: string, expectedLockVersion: number) => Promise<EditResult>;
  addDependency?: (taskKey: string, dependsOnKey: string, expectedLockVersion: number) => Promise<EditResult>;
  removeDependency?: (taskKey: string, dependsOnKey: string, expectedLockVersion: number) => Promise<EditResult>;
  deleteTask?: (taskKey: string, expectedLockVersion: number) => Promise<EditResult>;
  /** Fired when the user clicks/selects a bar — parent renders the detail Sheet. */
  onSelectTask?: (taskKey: string) => void;
  /** Currently-selected task key — pushed into SVAR's `selected`/`activeTask`
   *  so the bar shows the native selection ring + the user can use SVAR's
   *  keyboard navigation. */
  selectedKey?: string | null;
  /** Workflow release/anchor timezone (IANA). Displayed dates localize to it;
   *  bars stay on the server-truth UTC scale. Falls back to browser tz. */
  displayTz?: string;
  /** Per-user scope for collapse/expand `localStorage`  —
   *  typically `session.user.id`. Without it, collapse state is shared across
   *  any users sharing the browser. The full key is
   *  `cinatra:workflow-gantt:open:{workflowId}:{storageScope}`. */
  storageScope?: string;
  /** Workflow status  — gates the planned-vs-actual overlay.
   *  The overlay is rendered only when `"active"` or `"paused"`; draft,
   *  completed, and cancelled workflows skip it (the comparison isn't
   *  actionable). */
  workflowStatus?: string;
  /**
   * Gantt is controlled for `view` (Section owns the state).
   * The Gantt no longer owns a `useState` here; the Section's toolbar feeds
   * the value in.
   */
  view: ViewKey;
  /**
   * Section receives the SVAR API reference when ready.
   * Used for Today (scroll-chart) and any future Section-level Gantt actions.
   * The Gantt still keeps an internal apiRef for its own callbacks.
   */
  onApiReady?: (api: IApi) => void;
  /**
   * Section owns the fullscreen toggle button and therefore the
   * fullscreenRef. The Gantt forwards this ref onto its shell
   * `<div data-gantt-shell>` so Section's `document.fullscreenElement` checks
   * resolve to the right element.
   */
  fullscreenRef?: React.RefObject<HTMLDivElement | null>;
};

const LINK_ID = (source: string, target: string) => `${source}->${target}`;

function toDate(iso: string | null, fallback: string | null): Date {
  const s = iso ?? fallback ?? new Date().toISOString();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

// ---------------------------------------------------------------------------
// View → scale config.
//
// Tokens come from SVAR's `dateToString` (%F=full month name, %M=short month,
// %Y=year, %j=day-of-month, %W=ISO week number, %Q=quarter number, %d=day).
// `cellWidth` is the smallest cell in the bottom row; the SVAR drag rounds
// dx to this width / lengthUnitWidth. lengthUnit default is "day", so 1
// cell = 1 unit at day scale, and dx < ½·cellWidth rounds to 0 — visible
// snap-back. Keeping these compact (40–60px) makes most user drags commit.
// ---------------------------------------------------------------------------
export type ViewKey = "week" | "month" | "quarter" | "year";

type ScaleSpec = { unit: string; step: number; format: string };

const VIEW_CONFIG: Record<ViewKey, { scales: ScaleSpec[]; cellWidth: number; label: string }> = {
  week: {
    scales: [
      { unit: "month", step: 1, format: "%F %Y" },
      { unit: "day", step: 1, format: "%d %M" },
    ],
    cellWidth: 60,
    label: "Week",
  },
  month: {
    scales: [
      { unit: "month", step: 1, format: "%F %Y" },
      { unit: "day", step: 1, format: "%d" },
    ],
    cellWidth: 36,
    label: "Month",
  },
  quarter: {
    scales: [
      { unit: "quarter", step: 1, format: "Q%Q %Y" },
      { unit: "week", step: 1, format: "%W" },
    ],
    cellWidth: 40,
    label: "Quarter",
  },
  year: {
    scales: [
      { unit: "year", step: 1, format: "%Y" },
      { unit: "month", step: 1, format: "%M" },
    ],
    cellWidth: 56,
    label: "Year",
  },
};

export const VIEW_ORDER: ViewKey[] = ["week", "month", "quarter", "year"];

export const VIEW_LABELS: Record<ViewKey, string> = {
  week: "Week",
  month: "Month",
  quarter: "Quarter",
  year: "Year",
};

// localStorage key — per-user view preference, not per-workflow (matches the
// way most planning tools persist a global default).
export const VIEW_STORAGE_KEY = "cinatra:workflow-gantt:view";

export function readStoredView(): ViewKey {
  if (typeof window === "undefined") return "month";
  try {
    const v = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return v && VIEW_ORDER.includes(v as ViewKey) ? (v as ViewKey) : "month";
  } catch {
    return "month";
  }
}

// ---------------------------------------------------------------------------
// Status → SVAR `progress` (0-100, CSS width fill inside each bar). Constant
// stops (0/50/100) rather than elapsed-% — gives a clean "halfway / done"
// visual cue without implying scheduling precision we don't have.
// ---------------------------------------------------------------------------
const STATUS_PROGRESS: Record<WorkflowTaskStatus, number> = {
  idle: 0,
  scheduled: 0,
  pending_approval: 50,
  running: 50,
  succeeded: 100,
  failed: 100,
  skipped: 100,
  cancelled: 100,
};

// ---------------------------------------------------------------------------
// Weekend detector for `highlightTime`. SVAR calls this once per cell at the
// configured `unit`; the class is appended to the cell's className. CSS lives
// in globals.css (.wx-cell.gantt-weekend). The "today" indicator is owned by
// the GanttOverlays component  — an exact vertical line
// computed via the SVAR reactive store, not a coarse day-cell border.
// ---------------------------------------------------------------------------
function highlightTimeFn(date: Date, unit: "day" | "hour"): string {
  if (unit !== "day") return "";
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return "gantt-weekend";
  return "";
}

// ---------------------------------------------------------------------------
// Status dot palette — mirrors workflowTaskStatusToPill semantics but emitted
// inline so the SVAR bar can paint without round-tripping through StatusPill
// (which wants a chip-sized container).
// ---------------------------------------------------------------------------
const STATUS_DOT: Record<WorkflowTaskStatus, string> = {
  idle: "bg-muted-foreground/50",
  scheduled: "bg-primary",
  pending_approval: "bg-warning",
  running: "bg-primary animate-pulse",
  succeeded: "bg-success",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground/40",
  cancelled: "bg-muted-foreground/40",
};

const TYPE_LETTER: Record<GanttTaskInput["type"], { letter: string; title: string }> = {
  checkpoint: { letter: "C", title: "Checkpoint" },
  agent_task: { letter: "A", title: "Agent task" },
  approval: { letter: "R", title: "Approval (review)" },
  manual: { letter: "M", title: "Manual" },
  notification: { letter: "N", title: "Notification" },
  wait: { letter: "W", title: "Wait" },
};

function makeTaskTemplate(taskByKey: Map<string, GanttTaskInput>, workflowStatus?: string) {
  // SVAR renders this content INSIDE the native .wx-bar shell, so drag handles
  // and link anchors stay live. Keep semantic-token colors only.
  // `data` is SVAR's ITask — `id` is TID (string|number) so we coerce.
  // The planned-vs-actual overlay  renders an absolute
  // `<span.gantt-actual-bar>` INSIDE this wrapper when (a) the workflow is
  // active/paused (the comparison is actionable) AND (b) the task has actuals
  // AND (c) `computeActualBarMetrics` returns non-zero width.
  const showPvA = workflowStatus === "active" || workflowStatus === "paused";
  return function TaskBarContent({ data }: { data: ITask }) {
    const key = String(data.id);
    const t = taskByKey.get(key);
    if (!t) return <span className="px-1 text-xs">{data.text}</span>;
    const dot = STATUS_DOT[t.status] ?? STATUS_DOT.idle;
    const type = TYPE_LETTER[t.type] ?? { letter: "?", title: t.type };
    let actual: { leftPct: number; widthPct: number; slipDays: number } | null = null;
    if (showPvA && t.actualStartUtc && t.startUtc && t.endUtc) {
      actual = computeActualBarMetrics({
        plannedStartMs: Date.parse(t.startUtc),
        plannedEndMs: Date.parse(t.endUtc),
        actualStartMs: Date.parse(t.actualStartUtc),
        actualEndMs: t.actualEndUtc ? Date.parse(t.actualEndUtc) : null,
      });
    }
    return (
      <span
        data-task-bar={key}
        className={`relative flex h-full items-center gap-1.5 px-1.5 text-xs leading-none text-foreground${t.isCriticalPath ? " gantt-critical-path" : ""}`}
      >
        {/* Planned-vs-actual ghost overlay . Absolute inside
            the wrapper so it inherits SVAR's overflow:hidden clip; status-
            driven color via data-status. Width 0 collapses naturally. */}
        {actual && actual.widthPct > 0 ? (
          <span
            aria-hidden
            className="gantt-actual-bar pointer-events-none absolute inset-y-0"
            data-status={t.status}
            style={{ left: `${actual.leftPct}%`, width: `${actual.widthPct}%` }}
          />
        ) : null}
        <span className={`relative inline-block size-2 rounded-full ${dot}`} aria-hidden />
        <span className="relative truncate font-medium">
          {t.title}
          {actual && actual.slipDays > 0 ? (
            <span className="ml-1 text-muted-foreground"> · +{actual.slipDays}d late</span>
          ) : null}
        </span>
        <span
          className="relative ml-auto inline-flex size-4 items-center justify-center rounded-sm bg-surface-muted text-[10px] font-semibold text-muted-foreground"
          title={type.title}
          aria-label={type.title}
        >
          {type.letter}
        </span>
      </span>
    );
  };
}

// ---------------------------------------------------------------------------
// Hover Tooltip body — workflow-aware. Rendered by SVAR's `<Tooltip>` once per
// hover. SVAR passes the raw ITask; we look the workflow row up by key for
// the rich fields (agent package, depends-on chain, status pill).
// ---------------------------------------------------------------------------
// `displayTz` is the workflow's release/anchor timezone (IANA, e.g. "UTC",
// "America/New_York"). Displayed dates are localized to it via Intl's `timeZone`
// option  — bars stay positioned on the server-truth UTC scale,
// only the human-readable strings are zoned. Falls back to browser tz when
// unset/invalid.
function formatTooltipDate(iso: string | null | undefined, tz?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(tz ? { timeZone: tz } : {}),
  });
}

function makeTooltipContent(taskByKey: Map<string, GanttTaskInput>, displayTz?: string) {
  // SVAR can pass `data: null` if the bar's id doesn't resolve in the store —
  // bail rather than crash, which matches the no-tooltip outcome you'd want.
  return function GanttTooltipBody({ data }: { data: ITask | null }) {
    if (!data) return null;
    const t = taskByKey.get(String(data.id));
    if (!t) return <div className="px-[10px] py-[6px]">{data.text}</div>;
    const type = TYPE_LETTER[t.type] ?? { letter: "?", title: t.type };
    const statusLabel = t.status.replace(/_/g, " ");
    // Tooltip rows inherit cream from --wx-tooltip-font-color
    // (set on the .wx-willow-theme rebind). Padding 6px 10px, radius 6px, font
    // 12px everywhere — no per-element text-foreground / text-muted-foreground /
    // text-[10px] / text-xs overrides; the SVAR cascade owns the palette.
    return (
      <div className="flex max-w-xs flex-col gap-1 px-[10px] py-[6px] text-[12px] leading-snug">
        <div className="flex items-center gap-1.5">
          <span className={`inline-block size-2 rounded-full ${STATUS_DOT[t.status] ?? STATUS_DOT.idle}`} aria-hidden />
          <span className="font-semibold">{t.title}</span>
        </div>
        <div className="flex items-center gap-2">
          <span>{type.title}</span>
          <span aria-hidden>·</span>
          <span className="capitalize">{statusLabel}</span>
        </div>
        <div>
          {formatTooltipDate(t.startUtc ?? t.dueUtc, displayTz)} → {formatTooltipDate(t.endUtc ?? t.dueUtc, displayTz)}
        </div>
        {t.type === "agent_task" && t.agentPackage ? (
          <div className="font-mono">{t.agentPackage}</div>
        ) : null}
        {t.dependsOn && t.dependsOn.length > 0 ? (
          <div>
            ↑ depends on: <span className="font-mono">{t.dependsOn.join(", ")}</span>
          </div>
        ) : null}
      </div>
    );
  };
}

// ---------------------------------------------------------------------------
// Right-click ContextMenu body. SVAR's `<ContextMenu>` accepts an `options`
// array of items with `id`/`text`; we wire the click via `onClick` (SVAR
// fires `id` as the action name). 3 items:
//   - open-chat   → route to the chat re-author lane
//   - inspect     → open our existing detail Sheet
//   - copy-key    → clipboard
// ---------------------------------------------------------------------------
type ContextMenuAction = "open-chat" | "inspect" | "copy-key";

// ---------------------------------------------------------------------------
// Left-grid column set. SVAR splits the panel between this grid and the chart;
// each cell template gets `{ row, col }` where `row` is our augmented ITask
// (the custom `taskKey`/`taskType`/`taskStatus`/`durationDays` keys come from
// the svarTasks builder above). All columns are read-only — no `editor` field;
// the actual edit gate is `<Gantt readonly={!editable}>` plus our intercepts.
// `getter` is used for the computed duration column so SVAR sorts numerically
// rather than by template string.
// ---------------------------------------------------------------------------
function formatGridDate(d: Date | null | undefined, tz?: string): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    ...(tz ? { timeZone: tz } : {}),
  });
}

type GridRow = {
  text?: string;
  start?: Date;
  end?: Date;
  taskKey?: string;
  taskType?: GanttTaskInput["type"];
  taskStatus?: WorkflowTaskStatus;
  durationDays?: number;
};

// SVAR's cell FC receives ICellProps ({ api, row, column, onaction }); `row` is
// typed as the opaque IRow. We only read our augmented fields, so narrow via a
// single cast at the boundary.
type CellArgs = { row: unknown };

function TypeCell({ row }: CellArgs) {
  const t = (row as GridRow).taskType;
  if (!t) return null;
  const tl = TYPE_LETTER[t] ?? { letter: "?", title: t };
  return (
    <Badge variant="outline" className="font-mono text-[10px]" title={tl.title}>
      {tl.letter}
    </Badge>
  );
}

function StatusCell({ row }: CellArgs) {
  const s = (row as GridRow).taskStatus;
  if (!s) return null;
  return <StatusPill status={workflowTaskStatusToPill(s)} />;
}

// Column widths must fit SVAR's hard-coded 440px grid pane (no `tableWidth`
// prop exists in 2.6.1). The `text` column is the SOLE flexgrow column with NO
// explicit width — pairing flexgrow with a width collapses it when the fixed
// columns sum approaches the pane width. Fixed columns total ~294px, leaving
// the title ~146px (truncates; full title in the hover Tooltip + Sheet).
// Factory so the Start column's date template can localize to `displayTz`.
function makeGridColumns(displayTz?: string): IColumnConfig[] {
  return [
    {
      id: "text",
      header: [{ text: "Task", filter: "text" }],
      flexgrow: 1,
      sort: true,
    },
    {
      id: "taskType",
      header: [{ text: "Type", filter: "text" }],
      width: 48,
      align: "center",
      sort: true,
      cell: TypeCell,
    },
    {
      id: "taskStatus",
      header: [{ text: "Status", filter: "text" }],
      width: 110,
      sort: true,
      cell: StatusCell,
    },
    {
      id: "start",
      header: "Start",
      width: 80,
      align: "center",
      sort: true,
      template: (value: unknown) => formatGridDate(value as Date, displayTz),
    },
    {
      id: "durationDays",
      header: "Span",
      width: 56,
      align: "right",
      sort: true,
      getter: (row: GridRow) => row.durationDays ?? 0,
      template: (value: unknown) => {
        const n = typeof value === "number" ? value : Number(value);
        return n > 0 ? `${n}d` : "—";
      },
    },
  ];
}

const CONTEXT_MENU_OPTIONS: { id: ContextMenuAction; text: string }[] = [
  { id: "open-chat", text: "Open in chat" },
  { id: "inspect", text: "Inspect" },
  { id: "copy-key", text: "Copy task key" },
];

export function WorkflowGantt({
  workflowId,
  tasks,
  links,
  editable = false,
  readonlyReason: _readonlyReason,
  lockVersion: initialLockVersion = 0,
  applyWindow,
  addDependency,
  removeDependency,
  deleteTask,
  onSelectTask,
  selectedKey,
  displayTz,
  storageScope,
  workflowStatus,
  view,
  onApiReady,
  fullscreenRef: externalFullscreenRef,
}: WorkflowGanttProps) {
  const router = useRouter();
  // Dark-mode integration — flip <Willow> ↔ <WillowDark> based on the
  // resolved theme; resolvedTheme is undefined during SSR, so default to
  // "light" until mount.
  const { resolvedTheme } = useTheme();
  // Client-only render — SVAR draws Dates in the BROWSER timezone, which won't
  // match the server-rendered HTML (hydration mismatch). Gate on a mounted flag
  // so SVAR mounts purely client-side after hydration.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  // View is controlled by the Section toolbar. The useState +
  // localStorage persistence lives in WorkflowGanttSection.

  // Live CAS token — advanced on each accepted edit so a rapid follow-up edit
  // (before the server re-render lands) targets the right version.
  const lockRef = React.useRef(initialLockVersion);
  React.useEffect(() => {
    lockRef.current = initialLockVersion;
  }, [initialLockVersion]);

  const taskByKey = React.useMemo(() => {
    const m = new Map<string, GanttTaskInput>();
    for (const t of tasks) m.set(t.key, t);
    return m;
  }, [tasks]);

  // Hierarchy  — a task referenced as `parent` by any other
  // task renders as a SVAR "summary" with its window auto-derived from children;
  // its own children get `parent: <key>` so SVAR nests them.
  const isParentKey = React.useMemo(() => {
    const s = new Set<string>();
    for (const t of tasks) if (t.parent) s.add(t.parent);
    return s;
  }, [tasks]);

  // Per-user, per-workflow collapse/expand persistence. Default open=true. The
  // storageScope (the user id) keeps two users on one browser from clobbering
  // each other. `openByKey` is a plain object for cheap JSON round-trip.
  const openStorageKey = React.useMemo(
    () => `cinatra:workflow-gantt:open:${workflowId}:${storageScope ?? "anon"}`,
    [workflowId, storageScope],
  );
  const [openByKey, setOpenByKey] = React.useState<Record<string, boolean>>({});
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(openStorageKey);
      if (raw) setOpenByKey(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      // ignore (private window / corrupt value) — fail open with all expanded
    }
  }, [openStorageKey]);

  const svarTasks = React.useMemo(
    () =>
      tasks.map((t) => {
        const start = toDate(t.startUtc, t.dueUtc);
        const end = toDate(t.endUtc, t.dueUtc);
        const isMilestone = end.getTime() - start.getTime() < 60_000;
        const isSummary = isParentKey.has(t.key);
        const durationDays = isMilestone
          ? 0
          : Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));
        const base: Record<string, unknown> = {
          id: t.key,
          text: t.title,
          start,
          end: isMilestone ? start : end,
          // Summary parents take precedence over milestone/task; SVAR auto-derives
          // the rollup geometry from children. Otherwise keep the existing model.
          type: isSummary ? "summary" : isMilestone ? "milestone" : "task",
          progress: STATUS_PROGRESS[t.status] ?? 0,
          // Custom fields surfaced by the left-grid columns. SVAR's ITask is
          // `[key: string]: any`, so these flow through to column `getter`s.
          taskKey: t.key,
          taskType: t.type,
          taskStatus: t.status,
          durationDays,
        };
        if (t.parent) base.parent = t.parent;
        if (isSummary) base.open = openByKey[t.key] ?? true;
        return base;
      }),
    [tasks, isParentKey, openByKey],
  );

  const svarLinks = React.useMemo(
    () =>
      links.map((l) => ({
        id: LINK_ID(l.source, l.target),
        source: l.source,
        target: l.target,
        type: "e2s" as const,
      })),
    [links],
  );

  // Forced re-seed nonce — bumping it remounts the inner <Gantt> so it re-reads
  // the (server-truth) props. Used to REVERT a rejected optimistic edit when the
  // outer lockVersion key didn't change.
  const [reseed, setReseed] = React.useState(0);
  // Serialize writes — SVAR awaits async intercepts, but user input isn't
  // globally blocked; a second edit must not race the first against a stale CAS
  // token.
  const editPendingRef = React.useRef(false);

  const accept = React.useCallback(
    (lockVersion: number | undefined) => {
      if (lockVersion !== undefined) lockRef.current = lockVersion;
      router.refresh();
    },
    [router],
  );
  const revert = React.useCallback(() => setReseed((n) => n + 1), []);

  const taskTemplate = React.useMemo(
    () => makeTaskTemplate(taskByKey, workflowStatus),
    [taskByKey, workflowStatus],
  );
  const tooltipContent = React.useMemo(() => makeTooltipContent(taskByKey, displayTz), [taskByKey, displayTz]);
  const gridColumns = React.useMemo(() => makeGridColumns(displayTz), [displayTz]);

  // SVAR api captured at init for the ContextMenu/Tooltip wrappers + the
  // parent-sync selected-task effect below. We hold both a ref (stable across
  // renders for the effect) AND state (triggers re-render of the SVAR
  // wrappers once they have a live api reference).
  const apiRef = React.useRef<IApi | null>(null);
  const [ganttApi, setGanttApi] = React.useState<IApi | null>(null);

  const init = React.useCallback(
    (api: IApi) => {
      apiRef.current = api;
      setGanttApi(api);
      // Expose the SVAR API to Section so its toolbar can drive Today
      // (scroll-chart) and any future Section-level actions.
      onApiReady?.(api);
      // select-task → forward to parent. ALWAYS wired (works for readonly too)
      // so the user can inspect a bar regardless of edit policy.
      api.on("select-task", (ev) => {
        const id = ev?.id ? String(ev.id) : undefined;
        if (id && onSelectTask) onSelectTask(id);
      });

      // open-task → persist collapse/expand to localStorage per
      // (workflow, user). SVAR's payload mode is { id, mode: true|false }
      // where true=open. Wired even when readonly so view state persists for
      // any reader. 
      api.on("open-task", (ev) => {
        const id = ev?.id ? String(ev.id) : undefined;
        if (!id) return;
        const open = ev?.mode !== false;
        setOpenByKey((prev) => {
          if ((prev[id] ?? true) === open) return prev;
          const next = { ...prev, [id]: open };
          try {
            window.localStorage.setItem(openStorageKey, JSON.stringify(next));
          } catch {
            // ignore (private window / quota) — in-memory state still applies
          }
          return next;
        });
      });

      if (!editable) return;

      const notifyNoChange = () => {
        toast.message("No change — drag at least half a cell to reschedule.");
      };

      // SVAR fires `drag-task` with `inProgress:false` at the end of a drag
      // even when the rounded diff is zero (cellWidth/2 floor). `update-task`
      // is NOT fired in that case, so this is the only signal we have to
      // surface "your drag didn't commit" feedback.
      api.on("drag-task", (ev) => {
        if (
          ev?.inProgress === false &&
          (typeof ev.width === "number" || typeof ev.left === "number")
        ) {
          notifyNoChange();
        }
      });

      // Move / resize → applyWindow. POST-apply via `api.on`: the real SVAR
      // pointer path emits update-task with a `diff` + pre-diff dates, so reading
      // the proposed window in an `intercept` (pre-apply) sends the OLD dates.
      // After the default handler runs, getTask returns the FINAL start/end. On
      // reject we re-seed to revert.
      api.on("update-task", async (ev) => {
        if (!applyWindow) return;
        if (editPendingRef.current) { revert(); return; }
        const id = ev?.id ? String(ev.id) : undefined;
        if (!id) return;
        const original = taskByKey.get(id);
        editPendingRef.current = true;
        try {
          const t = api.getTask(id);
          if (!t?.start) { revert(); return; }
          // SVAR normalizes milestones to `type:"milestone"` + `duration:0`
          // and drops `end` from the store. For drag-to-reschedule we treat
          // a milestone as a point-in-time: start === end. applyWorkflowTaskWindow
          // already omits `durationIso8601` when end - start < 60s, so passing
          // identical start/end is the canonical "point task" payload.
          const isMilestone = t.type === "milestone" || t.duration === 0;
          const endSource = t.end ?? (isMilestone ? t.start : undefined);
          if (!endSource) { revert(); return; }
          const startDate = new Date(t.start);
          const endDate = new Date(endSource);
          if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
            revert();
            return;
          }
          const newStartIso = startDate.toISOString();
          const newEndIso = endDate.toISOString();
          // Defensive no-op check: if SVAR somehow emits update-task with
          // unchanged dates (e.g. resize handle clicked but not dragged), skip
          // the round-trip and inform the user.
          if (original) {
            const prevStart = (original.startUtc ?? original.dueUtc) ?? null;
            const prevEnd = (original.endUtc ?? original.dueUtc) ?? null;
            if (
              prevStart && prevEnd &&
              new Date(prevStart).getTime() === startDate.getTime() &&
              new Date(prevEnd).getTime() === endDate.getTime()
            ) {
              notifyNoChange();
              return;
            }
          }
          const r = await applyWindow(id, newStartIso, newEndIso, lockRef.current);
          if (r.ok) accept(r.lockVersion);
          else { toast.error(`Reschedule rejected${r.reason ? `: ${r.reason}` : ""}`); revert(); }
        } finally {
          editPendingRef.current = false;
        }
      });

      // Delete task → deleteTask (preflight reject via intercept).
      api.intercept("delete-task", async (ev) => {
        if (!deleteTask) return false;
        if (editPendingRef.current) return false;
        editPendingRef.current = true;
        try {
          const id = String(ev.id);
          const r = await deleteTask(id, lockRef.current);
          if (r.ok) { accept(r.lockVersion); return true; }
          if (r.reason === "has_dependents" || r.reason === "has_anchors") {
            toast.error(`Cannot delete ${id}: blocked by ${r.dependents?.join(", ") ?? "other tasks"}`);
          } else {
            toast.error(`Delete rejected${r.reason ? `: ${r.reason}` : ""}`);
          }
          return false;
        } finally {
          editPendingRef.current = false;
        }
      });

      // Add link → addDependency. SVAR e2s link = target depends on source.
      api.intercept("add-link", async (ev) => {
        if (!addDependency) return false;
        if (editPendingRef.current) return false;
        const link = (ev.link ?? {}) as { source?: string; target?: string; id?: string };
        if (!link.source || !link.target) return false;
        editPendingRef.current = true;
        try {
          const r = await addDependency(String(link.target), String(link.source), lockRef.current);
          if (r.ok) {
            // Stable link id so an immediate delete-before-refresh still parses
            // because SVAR otherwise assigns a temp:// id.
            link.id = LINK_ID(String(link.source), String(link.target));
            accept(r.lockVersion);
            return true;
          }
          toast.error(`Dependency rejected${r.reason ? `: ${r.reason}` : ""}`);
          return false;
        } finally {
          editPendingRef.current = false;
        }
      });

      // Delete link → removeDependency. The link id encodes source->target.
      api.intercept("delete-link", async (ev) => {
        if (!removeDependency) return false;
        if (editPendingRef.current) return false;
        const [source, target] = String(ev.id).split("->");
        if (!source || !target) {
          toast.error("This link can't be removed yet — refresh and retry.");
          return false;
        }
        editPendingRef.current = true;
        try {
          const r = await removeDependency(target, source, lockRef.current);
          if (r.ok) { accept(r.lockVersion); return true; }
          toast.error(`Remove dependency rejected${r.reason ? `: ${r.reason}` : ""}`);
          return false;
        } finally {
          editPendingRef.current = false;
        }
      });

      // Native actions we don't persist yet — reject so they can't create
      // unsaved phantom state. Creation/structure stays in chat authoring.
      for (const action of ["add-task", "copy-task", "move-task", "indent-task", "update-link"]) {
        api.intercept(action, () => {
          toast.message("This edit isn't supported on the Gantt yet — use chat to author the workflow.");
          return false;
        });
      }
    },
    [editable, applyWindow, deleteTask, addDependency, removeDependency, accept, revert, taskByKey, onSelectTask],
  );

  // Push the parent-owned `selectedKey` into SVAR's store so the bar gets the
  // native `.wx-selected` ring (and SVAR's keyboard navigation can target it).
  // The select-task event already round-trips when the user clicks IN the
  // Gantt; this covers programmatic-select (e.g. URL hash, future deep link).
  React.useEffect(() => {
    if (!apiRef.current || !selectedKey) return;
    apiRef.current.exec("select-task", { id: selectedKey });
  }, [selectedKey]);

  // Right-click ContextMenu callback. SVAR resolves `context` to the bar's
  // task data (via `api` + the wrapper's auto-resolver); option.id is what
  // we set in CONTEXT_MENU_OPTIONS. The 3 items route to navigation, parent
  // Sheet, and clipboard.
  const handleContextMenu = React.useCallback(
    (ev: { option: { id?: string | number }; context?: { id?: string | number } }) => {
      const action = ev?.option?.id as ContextMenuAction | undefined;
      const taskId = ev?.context?.id !== undefined && ev.context.id !== null ? String(ev.context.id) : null;
      if (!action || !taskId) return;
      switch (action) {
        case "open-chat":
          router.push(`/chat?wf=${encodeURIComponent(workflowId)}&task=${encodeURIComponent(taskId)}`);
          return;
        case "inspect":
          if (onSelectTask) onSelectTask(taskId);
          return;
        case "copy-key":
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            void navigator.clipboard.writeText(taskId);
            toast.message(`Copied task key: ${taskId}`);
          }
          return;
      }
    },
    [router, workflowId, onSelectTask],
  );

  const viewConfig = VIEW_CONFIG[view];
  const ThemeWrapper = resolvedTheme === "dark" ? WillowDark : Willow;
  // SVAR's HeaderMenu type intersects gantt-store IApi & grid-store IApi, but
  // the runtime wrapper only needs the gantt api (it resolves the grid api via
  // getTable internally). Cast to satisfy the over-strict declared prop type.
  const headerMenuApi = (ganttApi ?? undefined) as React.ComponentProps<typeof SvarHeaderMenu>["api"];

  // Native fullscreen via the browser API — SVAR ships a `<Fullscreen>` type
  // declaration but the JS bundle doesn't export it in 2.6.1 free, so we
  // promote our own shell.
  // Fullscreen ref is Section-owned (the toggle button lives in
  // Section's toolbar). We accept it as a prop and fall back to a
  // local ref so the Gantt can still render in isolation.
  const localFullscreenRef = React.useRef<HTMLDivElement | null>(null);
  const fullscreenRef = externalFullscreenRef ?? localFullscreenRef;

  // WorkflowGantt no longer renders its own toolbar or
  // the surrounding `soft-panel`. The Section above owns:
  //  - the soft-panel (which now hugs the chart — no excess
  //    height beyond the Gantt's intrinsic height),
  //  - the view Select / Today / Fullscreen toolbar block,
  //  - the readonly Badge (rendered into the toolbar by Section),
  //  - the fullscreenRef + the keyboard `F` shortcut.
  // What stays here: the SVAR shell + its data-testid + the data-gantt-shell
  // anchor that anchors gantt-overrides.css.
  return (
    <>
      {/* Keyboard a11y : the Section toolbar controls
          (view switcher, Today, Fullscreen, lifecycle, target date) and
          SVAR's grid header/filter are Tab-operable; the `.wx-bar` task
          bars are pointer / right-click operable only — SVAR 2.6.1 renders
          them without `tabindex`, a documented SVAR-owned limit. We do not
          inject synthetic tabindex into the embed. */}
      <div
        ref={fullscreenRef}
        data-testid="workflow-gantt"
        className="relative overflow-hidden rounded-control bg-surface"
        data-gantt-shell
        role="region"
        aria-label="Workflow timeline"
      >
        {!mounted ? (
          <div className="flex h-[480px] items-center justify-center text-sm text-muted-foreground">
            Loading Gantt…
          </div>
        ) : tasks.length === 0 ? (
          // Empty state — a workflow with no tasks (edge: freshly-created draft
          // before chat authoring adds steps).
          <div className="flex h-[480px] flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
            <span className="font-medium text-foreground">No tasks yet</span>
            <span>Describe this workflow in chat to add tasks, then manage them here.</span>
          </div>
        ) : (
          // Error boundary — if SVAR throws on render (bad date, store edge), show
          // a recoverable fallback instead of crashing the whole page.
          <RenderErrorBoundary
            fallback={
              <div className="flex h-[480px] flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Couldn’t render the timeline</span>
                <span>Reload the page to try again.</span>
              </div>
            }
          >
            <ThemeWrapper>
              {/* Wrap order: HeaderMenu (column sort/filter) > ContextMenu
                  (right-click on bars) > Tooltip (hover on bars) > Gantt.
                  Each component needs to enclose the Gantt's DOM to attach its
                  listeners; HeaderMenu also needs the live `api` (resolves
                  `api.getTable(true)` under the hood). */}
              <SvarHeaderMenu api={headerMenuApi}>
                <SvarContextMenu
                  api={ganttApi ?? undefined}
                  options={CONTEXT_MENU_OPTIONS}
                  onClick={handleContextMenu}
                >
                  <SvarTooltip api={ganttApi ?? undefined} content={tooltipContent}>
                    {/* `reseed` key forces a remount to revert a rejected optimistic
                        edit. Scale/cellWidth prop changes are re-applied by SVAR
                        without a remount, so no need to compose `view` in here. */}
                    <Gantt
                      key={reseed}
                      tasks={svarTasks}
                      links={svarLinks}
                      columns={gridColumns}
                      scales={viewConfig.scales}
                      cellWidth={viewConfig.cellWidth}
                      cellHeight={32}
                      scaleHeight={30}
                      cellBorders="full"
                      highlightTime={highlightTimeFn}
                      readonly={!editable}
                      zoom
                      selected={selectedKey ? [selectedKey] : []}
                      activeTask={selectedKey ?? undefined}
                      taskTemplate={taskTemplate}
                      init={init}
                    />
                  </SvarTooltip>
                </SvarContextMenu>
              </SvarHeaderMenu>
            </ThemeWrapper>
          </RenderErrorBoundary>
        )}
        {/* Today-line overlay : Cinatra-owned absolute
            line at `now`, positioned via SVAR's reactive `_scales`/`scrollLeft`
            against the `.wx-chart` viewport. Rendered AFTER the Gantt so it
            sits on top; pointer-events:none keeps interactions on the bars. */}
        {mounted ? <GanttTodayLine apiRef={apiRef} /> : null}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Today-line overlay .
//
// SVAR's bars + scale axis live inside the `.wx-chart` viewport, which scrolls
// horizontally. We position an absolute 1px line at today's x-coordinate by
// reading the reactive `_scales` (anchor + length-unit + length-unit-width)
// off `api.getReactiveState()` and the chart's scrollLeft. A `requestAnimation-
// Frame` loop while mounted picks up scale / scroll / resize / view-switch
// transitions in one cheap path (the only work each frame is a few reads + a
// number comparison; setX is skipped when unchanged).
// ---------------------------------------------------------------------------
function GanttTodayLine({ apiRef }: { apiRef: React.RefObject<IApi | null> }) {
  const [pos, setPos] = React.useState<{ left: number; top: number; height: number } | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let lastLeft = -1;
    let lastTop = -1;
    let lastHeight = -1;
    const tick = () => {
      if (cancelled) return;
      const api = apiRef.current;
      const shell = document.querySelector<HTMLElement>("[data-gantt-shell]");
      const chart = shell?.querySelector<HTMLElement>(".wx-chart");
      // Hide on any missing piece — keeps the overlay state in sync with the
      // chart/api lifecycle ( — clear `pos` when state/chart missing).
      const setHidden = () => {
        if (lastLeft !== -1 || lastTop !== -1 || lastHeight !== -1) {
          lastLeft = -1;
          lastTop = -1;
          lastHeight = -1;
          setPos(null);
        }
      };
      if (!api || !shell || !chart) {
        setHidden();
        raf = window.requestAnimationFrame(tick);
        return;
      }
      // SVAR 2.6.1 reactive scale state: `_scales.start` (anchor instant —
      // NOT `.from`, which is the row-area offset), `_scales.lengthUnit`,
      // `_scales.lengthUnitWidth`. Read defensively + handle unit explicitly.
      const state = (api as unknown as { getReactiveState?: () => unknown }).getReactiveState?.() as
        | { _scales?: { start?: Date; lengthUnit?: string; lengthUnitWidth?: number } }
        | undefined;
      const scales = state?._scales;
      const start = scales?.start instanceof Date ? scales.start : null;
      const luw = typeof scales?.lengthUnitWidth === "number" ? scales.lengthUnitWidth : null;
      const unit = scales?.lengthUnit;
      // We currently ship day + hour as the lowest visible scale unit. The
      // four configured views all bottom out at "day"; hour math is included
      // defensively. Anything else (week/month/quarter at the smallest cell)
      // falls through to the hidden branch — quarter/year views in our config
      // still have a smaller unit (week / month), so the resolver gives us a
      // sub-month length; if SVAR ever surfaces a coarser unit at the bottom
      // we hide rather than misposition.
      const unitMs = unit === "day" ? 86_400_000 : unit === "hour" ? 3_600_000 : 0;
      if (!start || !luw || luw <= 0 || unitMs === 0) {
        setHidden();
        raf = window.requestAnimationFrame(tick);
        return;
      }
      const chartRect = chart.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      const chartOffsetLeft = chartRect.left - shellRect.left;
      const chartOffsetTop = chartRect.top - shellRect.top;
      const xInChart = ((Date.now() - start.getTime()) / unitMs) * luw - chart.scrollLeft;
      // Hide when out of the visible chart range.
      const visible = xInChart >= 0 && xInChart <= chart.clientWidth;
      const left = visible ? Math.round(chartOffsetLeft + xInChart) : -1;
      const top = Math.round(chartOffsetTop);
      const height = Math.round(chart.clientHeight);
      if (left !== lastLeft || top !== lastTop || height !== lastHeight) {
        lastLeft = left;
        lastTop = top;
        lastHeight = height;
        setPos(visible ? { left, top, height } : null);
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
    };
  }, [apiRef]);

  if (!pos) return null;
  return (
    <div
      aria-hidden
      data-gantt-today-line
      className="pointer-events-none absolute z-10 w-px"
      style={{
        left: `${pos.left}px`,
        top: `${pos.top}px`,
        height: `${pos.height}px`,
        background: "var(--ring)",
      }}
    />
  );
}
