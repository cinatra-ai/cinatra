"use client";

import { useState, useTransition } from "react";
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
import { getRegistryVersionDiff, setRegistryLatestVersion } from "./registry-version-actions";

export type RegistryVersionRow = {
  version: string;   // e.g. "1.2.0"
  deprecated: boolean;
  isCurrent: boolean; // true when version === distTags.latest
};

type RegistryVersionHistoryListProps = {
  packageName: string;
  items: RegistryVersionRow[];
  orderedVersions: string[]; // descending semver order — passed to diff action
};

export function RegistryVersionHistoryList({
  packageName,
  items,
  orderedVersions,
}: RegistryVersionHistoryListProps) {
  const [expandedVersion, setExpandedVersion] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, string | null>>({});
  const [loadingDiff, setLoadingDiff] = useState<string | null>(null);

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No versions published yet.</p>;
  }

  const handleDiffClick = async (version: string) => {
    if (expandedVersion === version) {
      setExpandedVersion(null);
      return;
    }

    setExpandedVersion(version);

    if (version in diffs) {
      // Already loaded
      return;
    }

    setLoadingDiff(version);
    const result = await getRegistryVersionDiff({ packageName, version, orderedVersions });
    setLoadingDiff(null);

    if (result.ok) {
      setDiffs((prev) => ({ ...prev, [version]: result.diff }));
    } else {
      toast.error(`Failed to load diff: ${result.error}`);
      setExpandedVersion(null);
    }
  };

  return (
    <ul className="flex flex-col gap-2">
      {items.map((v) => {
        const isOldest = orderedVersions[orderedVersions.length - 1] === v.version;
        const diff = diffs[v.version];

        return (
          <li key={v.version} className="rounded-control border border-line bg-surface">
            {/* Row header */}
            <div className="flex items-center gap-3 px-4 py-3">
              <div className={`flex items-center gap-3 flex-1 min-w-0${v.isCurrent ? "" : " opacity-50"}`}>
                <Badge
                  className={v.isCurrent ? "bg-primary text-primary-foreground border-primary" : undefined}
                  variant={v.isCurrent ? undefined : "outline"}
                >
                  v{v.version}
                </Badge>
                <div className="flex-1 min-w-0">
                  {v.deprecated && (
                    <span className="text-xs text-muted-foreground">deprecated</span>
                  )}
                  {v.isCurrent && (
                    <Badge variant="success" className="text-xs font-medium">latest</Badge>
                  )}
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-2 shrink-0">
                {!isOldest && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleDiffClick(v.version)}
                    disabled={loadingDiff === v.version}
                  >
                    <GitCompare className="h-4 w-4" />
                    {loadingDiff === v.version ? "Loading…" : "Diff"}
                  </Button>
                )}
                <SetLatestButton
                  packageName={packageName}
                  version={v.version}
                  disabled={v.isCurrent}
                />
              </div>
            </div>

            {/* Inline diff */}
            {expandedVersion === v.version && (
              <div className="border-t border-line px-4 pb-4 pt-4">
                {diff === undefined ? (
                  <p className="text-xs text-muted-foreground">Loading diff…</p>
                ) : diff === null ? (
                  <p className="text-xs text-muted-foreground">No prior version to diff against.</p>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground mb-3">
                      Changes introduced in v{v.version}
                    </p>
                    <pre className="overflow-x-auto rounded-control border border-line bg-surface-muted p-4 text-xs leading-relaxed font-mono">
                      {diff.split("\n").map((line, i) => {
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
                  </>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// SetLatestButton — confirm dialog before updating the dist-tag
// ---------------------------------------------------------------------------

function SetLatestButton({
  packageName,
  version,
  disabled,
}: {
  packageName: string;
  version: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const handleConfirm = () => {
    startTransition(async () => {
      const result = await setRegistryLatestVersion({ packageName, version });
      if (result.ok) {
        toast.success(`Set v${version} as latest`);
        setOpen(false);
        router.refresh();
      } else {
        toast.error(`Failed: ${result.error}`);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <RotateCcw className="h-4 w-4" />
          Set as latest
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set v{version} as latest?</DialogTitle>
          <DialogDescription>
            The <code className="font-mono text-sm">latest</code> dist-tag will point to v{version}.
            This controls which version is installed when no version is specified. All published
            versions remain in the registry.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isPending}>
            {isPending ? "Updating…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
