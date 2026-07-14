/**
 * §IV inline not-authorized refusal panel (cinatra#1431, spec design@4c6799db
 * §I/§IV). A non-administrator deep link into an admin mode renders THIS panel
 * inside the `/artifacts` surface — never a 404 (which would hide that the
 * admin surface exists) and never a redirect. The server has already refused
 * to run the admin query; this is the visible refusal. Copy for Raw objects is
 * verbatim from the spec's `artifacts-raw-denied` example.
 */
import Link from "next/link";
import { Lock } from "lucide-react";

import type { AdminArtifactsMode } from "./artifacts-modes";

const REFUSAL_COPY: Record<
  AdminArtifactsMode,
  { heading: string; body: string }
> = {
  raw: {
    heading: "Raw objects is administrator-only",
    body: "You don't have access to the raw-objects browser.",
  },
  types: {
    heading: "Types & approvals is administrator-only",
    body: "You don't have access to the type registry.",
  },
  undo: {
    heading: "Undo is administrator-only",
    body: "You don't have access to the data-safety undo surface.",
  },
  merge: {
    heading: "Merge proposals is administrator-only",
    body: "You don't have access to the merge-proposals review.",
  },
};

export function ArtifactsNotAuthorizedPanel({
  mode,
}: {
  mode: AdminArtifactsMode;
}) {
  const copy = REFUSAL_COPY[mode];
  return (
    <div
      className="flex flex-col items-center gap-3 px-5 py-10 text-center"
      data-testid="artifacts-raw-denied"
      data-conformance-id="artifacts-raw-denied"
      data-state="error"
    >
      <div className="grid size-10 place-items-center rounded-lg bg-surface-muted text-muted-foreground">
        <Lock aria-hidden className="size-5" />
      </div>
      <p className="text-sm font-semibold text-foreground">
        {copy.heading}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {copy.body}{" "}
        <Link href="/artifacts" className="text-primary underline-offset-4 hover:underline">
          Back to Library
        </Link>
      </p>
    </div>
  );
}
