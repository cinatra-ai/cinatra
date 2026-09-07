import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RUN_MADE_STEP_LABEL, type RunMadeArtifactRow } from "./run-made-reading";

// ---------------------------------------------------------------------------
// THE RUN'S LAST STEP, DRAWN (cinatra#3029, acceptance item 5).
//
// The ratified drawing's artifact review, section I.2: the run's last step is
// "What this run made", it lists the run's artifacts, "Each opens on its own
// page", and a run that made nothing gets the drawing's own EMPTY READING rather
// than an empty panel.
//
// NO "use client": the setup run page's screen is a server component and mounts
// this surface directly. Every row is a plain link to the artifact's own page,
// so the step needs no client state at all.
// ---------------------------------------------------------------------------

export function RunMadeStepSurface({
  rows,
  reading,
}: {
  rows: readonly RunMadeArtifactRow[];
  reading: string;
}) {
  return (
    <Card data-run-made={rows.length === 0 ? "empty" : "listed"}>
      <CardHeader>
        <CardTitle className="text-sm font-semibold text-foreground">
          {RUN_MADE_STEP_LABEL}
        </CardTitle>
        <CardDescription
          className="text-sm leading-6 text-muted-foreground"
          data-run-made-reading=""
        >
          {reading}
        </CardDescription>
      </CardHeader>
      {rows.length > 0 ? (
        <CardContent className="p-6 pt-0">
          <ul className="flex flex-col gap-2" data-run-made-rows="">
            {rows.map((row) => (
              <li key={row.artifactId}>
                <Link
                  href={row.href}
                  className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                  data-run-made-row={row.artifactId}
                  data-run-made-rung={row.rung ?? ""}
                  data-run-made-used={row.used ? "used" : "written"}
                >
                  {row.title}
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}
    </Card>
  );
}
