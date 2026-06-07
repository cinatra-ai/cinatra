import "server-only";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { readAgentTemplateVersions } from "./store";
import { formatDistanceToNow } from "date-fns";

type VersionHistoryPanelProps = {
  templateId: string;
  currentVersionId: string | null;
};

export async function VersionHistoryPanel({ templateId, currentVersionId }: VersionHistoryPanelProps) {
  const page = await readAgentTemplateVersions(templateId, { limit: 5 });
  // Pointer wins; fall back to latest (first item) for templates without a pointer set yet
  const activeVersionId = currentVersionId ?? page.items[0]?.id ?? null;

  return (
    <section className="soft-panel rounded-card px-6 py-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Version History</h2>
          <p className="text-sm text-muted-foreground">
            {page.total === 0
              ? "No saved versions yet."
              : `${page.total} version${page.total === 1 ? "" : "s"} saved.`}
          </p>
        </div>
        {page.total > 0 ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`/agents/builder/${templateId}/history`}>Manage versions</Link>
          </Button>
        ) : null}
      </div>

      {page.items.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {page.items.map((v) => (
            <li
              key={v.id}
              className={`flex items-center justify-between gap-4 rounded-control border border-line bg-surface px-4 py-3${v.id === activeVersionId ? "" : " opacity-50"}`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <Badge
                  variant={v.id === activeVersionId ? undefined : bumpVariant(v.bumpType)}
                  className={v.id === activeVersionId ? "bg-primary text-primary-foreground border-primary" : undefined}
                >
                  v{v.semver}
                </Badge>
                <span className="text-sm text-foreground truncate">
                  {v.changelogLine ?? "(no changelog)"}
                </span>
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {formatDistanceToNow(v.createdAt, { addSuffix: true })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function bumpVariant(
  bumpType: "major" | "minor" | "patch",
): "default" | "secondary" | "outline" {
  if (bumpType === "major") return "default";
  if (bumpType === "minor") return "secondary";
  return "outline";
}
