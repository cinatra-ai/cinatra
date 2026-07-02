"use client";

// Target-date edit control. The workflow's anchor date (stored internally as
// `target_at_utc`) is the fixed point every relative task schedules against; it
// is generic - a product release, a launch, a hearing, an event. It is edited
// here in the page chrome via the existing rescheduleAction -> rescheduleWorkflow
// (draft/paused-only CAS) and surfaces a per-task cascade preview before commit.
// This is the EXECUTION-timing editor that survives the Gantt removal (#321) —
// it drives when the workflow runs, not a chart. Shown only when editable.

import { useEffect, useState, useTransition } from "react";
import { CalendarIcon } from "lucide-react";
import { format } from "date-fns";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/cinatra-toast";

type RescheduleResult = { ok: boolean; reason?: string; lockVersion?: number };

type CascadePreviewEntry = { taskKey: string; oldDueAtUtc: string; newDueAtUtc: string };
type CascadePreviewResult = { cascade: CascadePreviewEntry[]; lockVersion: number };

type Props = {
  targetAtUtc: string | null;
  lockVersion: number;
  /** Pre-bound to workflowId: (newTargetAt, expectedLockVersion) => result. */
  action: (newTargetAt: string, expectedLockVersion: number) => Promise<RescheduleResult>;
  /** Pre-bound to workflowId: previews the per-task due-date cascade for a
   *  proposed anchor move BEFORE commit, surfaced inline in this control. */
  previewCascade?: (newTargetAtUtc: string) => Promise<CascadePreviewResult | null>;
  /** Workflow release/anchor timezone (IANA) for localized diff dates. */
  displayTz?: string;
  /**
   * Trigger visual variant. Default `"page-header"` (Button variant=outline,
   * label `Target d MMM yyyy`). `"toolbar"` uses the
   * toolbar-matched chrome (smaller height, transparent border) and a more
   * compact label `Target d MMM` (no year) that fits ~120px in the workflow
   * detail page's section toolbar.
   */
  variant?: "page-header" | "toolbar";
};

function fmtDiffDate(iso: string, tz?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    ...(tz ? { timeZone: tz } : {}),
  });
}

/** Render a UTC instant as the `datetime-local` input's local wall-clock value. */
function toLocalInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function WorkflowTargetDateControl({
  targetAtUtc,
  lockVersion,
  action,
  previewCascade,
  displayTz,
  variant = "page-header",
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(() => toLocalInputValue(targetAtUtc));
  const [pending, startTransition] = useTransition();
  // Cascade preview of the proposed anchor move — debounced as the user edits
  // the date, computed server-side via `previewCascade`. Only entries whose due
  // date actually shifts are surfaced.
  const [preview, setPreview] = useState<CascadePreviewEntry[] | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (!open || !previewCascade) {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    const iso = d.toISOString();
    // Skip when unchanged from the committed target (no move = no cascade).
    if (targetAtUtc && new Date(targetAtUtc).getTime() === d.getTime()) {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    let cancelled = false;
    setPreviewing(true);
    const id = setTimeout(async () => {
      try {
        const r = await previewCascade(iso);
        if (cancelled) return;
        const changed = (r?.cascade ?? []).filter((e) => e.oldDueAtUtc !== e.newDueAtUtc);
        setPreview(changed);
      } catch {
        if (!cancelled) setPreview(null);
      } finally {
        if (!cancelled) setPreviewing(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [value, open, previewCascade, targetAtUtc]);

  function save() {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      toast.error("Pick a valid target date");
      return;
    }
    startTransition(async () => {
      try {
        const r = await action(d.toISOString(), lockVersion);
        if (r.ok) {
          toast.success("Target date updated");
          setOpen(false);
          router.refresh();
        } else {
          toast.error(`Target date rejected${r.reason ? `: ${r.reason}` : ""}`);
        }
      } catch {
        toast.error("Could not update the target date.");
      }
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {variant === "toolbar" ? (
          // Toolbar variant — same Button primitive (so the
          // existing Popover anchor + a11y are preserved) but `variant="ghost"`
          // + compact `Target d MMM` label so it fits ~120px inside the
          // workflow detail page's section toolbar.
          <Button
            variant="ghost"
            size="sm"
            className="h-7 max-w-[140px] truncate px-2"
            data-testid="workflow-target-edit"
            disabled={pending}
          >
            <CalendarIcon data-icon="inline-start" />
            {targetAtUtc ? `Target ${format(new Date(targetAtUtc), "d MMM")}` : "Set target"}
          </Button>
        ) : (
          <Button variant="outline" size="sm" data-testid="workflow-target-edit" disabled={pending}>
            <CalendarIcon data-icon="inline-start" />
            {targetAtUtc ? `Target ${format(new Date(targetAtUtc), "d MMM yyyy")}` : "Set target date"}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="flex w-72 flex-col gap-3">
        <Field>
          <FieldLabel htmlFor="workflow-target-at">Target date</FieldLabel>
          <Input
            id="workflow-target-at"
            type="datetime-local"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        {previewCascade && (
          <div
            className="flex flex-col gap-1 text-xs"
            data-testid="workflow-cascade-preview"
            role="status"
            aria-live="polite"
          >
            {previewing ? (
              <span className="text-muted-foreground">Computing cascade…</span>
            ) : preview === null ? null : preview.length === 0 ? (
              <span className="text-muted-foreground">No dependent tasks shift.</span>
            ) : (
              <>
                <span className="font-medium text-foreground">
                  {preview.length} task{preview.length === 1 ? "" : "s"} will shift:
                </span>
                <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                  {preview.map((e) => (
                    <li key={e.taskKey} className="flex items-center justify-between gap-2 tabular-nums">
                      <span className="truncate font-mono text-[11px] text-muted-foreground">{e.taskKey}</span>
                      <span className="shrink-0">
                        {fmtDiffDate(e.oldDueAtUtc, displayTz)} → {fmtDiffDate(e.newDueAtUtc, displayTz)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        <Button size="sm" data-testid="workflow-target-save" disabled={pending} onClick={save}>
          {preview && preview.length > 0 ? `Apply (shifts ${preview.length})` : "Save"}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
