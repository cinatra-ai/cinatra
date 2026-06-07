"use client";

import { useState } from "react";
import { GitCompare, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "@/lib/cinatra-toast";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import { rollbackAgentTemplate } from "./rollback-actions";

export type VersionRow = {
  id: string;
  semver: string;
  bumpType: "major" | "minor" | "patch";
  changelogLine: string | null;
  createdAt: string; // ISO string
  createdBy: string | null;
  diff: string | null; // pre-computed diff lines; null = initial version
  isCurrent: boolean;
};

type VersionHistoryListProps = {
  items: VersionRow[];
  templateId: string;
};

export function VersionHistoryList({ items, templateId }: VersionHistoryListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No versions yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {items.map((v) => (
        <li key={v.id} className="rounded-control border border-line bg-surface">
          {/* Row header — always visible */}
          <div className="flex items-center gap-3 px-4 py-3">
            <div className={`flex items-center gap-3 flex-1 min-w-0${v.isCurrent ? "" : " opacity-50"}`}>
              <Badge
                variant={v.isCurrent ? undefined : bumpVariant(v.bumpType)}
                className={v.isCurrent ? "bg-primary text-primary-foreground border-primary" : undefined}
              >
                v{v.semver}
              </Badge>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-foreground truncate">
                  {v.changelogLine ?? "(no changelog)"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatDistanceToNow(new Date(v.createdAt), { addSuffix: true })}
                  {v.createdBy ? ` · by ${v.createdBy}` : ""}
                </div>
              </div>
            </div>
            {/* Action buttons — top right of every row, always full opacity */}
            <div className="flex items-center gap-2 shrink-0">
              {v.diff !== null && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setExpandedId(expandedId === v.id ? null : v.id)}
                >
                  <GitCompare className="h-4 w-4" />
                  Diff
                </Button>
              )}
              <RestoreButton
                templateId={templateId}
                targetVersionId={v.id}
                targetSemver={v.semver}
                disabled={v.isCurrent}
              />
            </div>
          </div>

          {/* Inline diff — shown when Diff is clicked */}
          {expandedId === v.id && v.diff !== null && (
            <div className="border-t border-line px-4 pb-4 pt-4">
              <p className="text-xs text-muted-foreground mb-3">
                Changes introduced in v{v.semver}
              </p>
              <pre className="overflow-x-auto rounded-control border border-line bg-surface-muted p-4 text-xs leading-relaxed font-mono">
                {v.diff.split("\n").map((line, i) => {
                  const cls = line.startsWith("+ ")
                    ? "text-success"
                    : line.startsWith("- ")
                    ? "text-destructive"
                    : "text-muted-foreground";
                  return (
                    <div key={i} className={cls}>
                      {line || "\u00A0"}
                    </div>
                  );
                })}
              </pre>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// RestoreButton — inline dialog (no separate file needed since this is already client)
// ---------------------------------------------------------------------------

function RestoreButton({
  templateId,
  targetVersionId,
  targetSemver,
  disabled,
}: {
  templateId: string;
  targetVersionId: string;
  targetSemver: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const handleConfirm = () => {
    startTransition(async () => {
      const result = await rollbackAgentTemplate(templateId, targetVersionId);
      if (result.ok) {
        toast.success(`Restored to v${targetSemver}`);
        setOpen(false);
        router.refresh();
      } else {
        toast.error(`Restore failed: ${result.error}`);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <RotateCcw className="h-4 w-4" />
          Restore
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore to v{targetSemver}?</DialogTitle>
          <DialogDescription>
            The live template will use the contents of v{targetSemver}. All version history stays
            intact — the &quot;current&quot; indicator simply moves to this version. You can
            restore to any version at any time.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isPending}>
            {isPending ? "Restoring…" : "Confirm restore"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function bumpVariant(bumpType: "major" | "minor" | "patch"): "default" | "secondary" | "outline" {
  if (bumpType === "major") return "default";
  if (bumpType === "minor") return "secondary";
  return "outline";
}
