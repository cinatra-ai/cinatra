// Lifecycle badges component.
//
// Renders the descriptors from lifecycle-ui.ts. The lifecycle STATE (Locked,
// Archived) is drawn as the Extensions marked text, the same chip the installed
// card draws (Extensions drawing, "Example — lifecycle status"; cinatra#4296):
// mono uppercase text with a green lock or a grey cross, never a Badge. The
// chips that are not lifecycle states (Required, source, version) stay on the
// shadcn <Badge> primitive + semantic variants. Layout-only className per the
// shadcn rules (flex + gap, no space-x).
"use client";

import { Badge } from "@/components/ui/badge";
import { InstalledStatusIndicator } from "@/components/extensions/installed-status-indicator";

import type { InstalledExtension } from "../canonical-types";
import { lifecycleBadgesFor } from "../lifecycle-ui";

export type LifecycleBadgesProps = {
  extension: InstalledExtension;
  className?: string;
};

export function LifecycleBadges({ extension, className }: LifecycleBadgesProps) {
  const badges = lifecycleBadgesFor(extension);
  return (
    <div className={className ?? "flex flex-wrap items-center gap-1.5"}>
      {badges.map((b) =>
        b.key === "locked" || b.key === "archived" ? (
          <InstalledStatusIndicator key={b.key} status={b.key} />
        ) : (
          <Badge key={b.key} variant={b.variant} title={b.title}>
            {b.label}
          </Badge>
        ),
      )}
    </div>
  );
}
