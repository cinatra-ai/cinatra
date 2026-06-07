// Lifecycle badges component.
//
// Renders the badge descriptors from lifecycle-ui.ts using the shadcn
// <Badge> primitive + semantic variants (no raw colors - design-system
// compliant). Layout-only className per the shadcn rules (flex + gap, no
// space-x).
"use client";

import { Badge } from "@/components/ui/badge";

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
      {badges.map((b) => (
        <Badge key={b.key} variant={b.variant} title={b.title}>
          {b.label}
        </Badge>
      ))}
    </div>
  );
}
