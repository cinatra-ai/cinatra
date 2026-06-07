import "server-only";
import { diffSnapshots } from "./store";
import type { AgentTemplateVersionSnapshot } from "./store";

type VersionDiffViewProps = {
  fromSemver: string;
  toSemver: string;
  fromSnapshot: AgentTemplateVersionSnapshot;
  toSnapshot: AgentTemplateVersionSnapshot;
};

export function VersionDiffView({ fromSemver, toSemver, fromSnapshot, toSnapshot }: VersionDiffViewProps) {
  const diff = diffSnapshots(fromSnapshot, toSnapshot);
  const lines = diff.split("\n");

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-3">
        Changes from v{fromSemver} → v{toSemver}
      </p>
      <pre className="overflow-x-auto rounded-control border border-line bg-surface-muted p-4 text-xs leading-relaxed font-mono">
        {lines.map((line, i) => {
          const cls =
            line.startsWith("+ ")
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
  );
}
