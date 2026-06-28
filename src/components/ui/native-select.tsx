import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * NativeSelect — the platform `<select>` element, wrapped as a design-system
 * primitive.
 *
 * The Radix-based `<Select>` (./select) is the default picker, but it is a
 * client-only popover that needs hydration before it can open or submit a
 * form value. NativeSelect exists for the cases the Radix one cannot serve
 * without a behavior/appearance regression:
 *
 *   - Server-rendered `<form method="get|post">` controls that must submit
 *     WITHOUT client JavaScript (progressive enhancement). The OS dropdown
 *     and native form-value collection are the contract there.
 *   - Pre-hydration form controls where the OS-native dropdown look is the
 *     intended, accessible affordance.
 *
 * It renders the raw `<select>` (allowed here — this dir is the design-system
 * carve-out for the raw-JSX lint) and forwards every prop, including the call
 * site's full `className`. It deliberately adds NO opinionated default styling:
 * its whole job is to be the lint-sanctioned seam for native `<select>` while
 * keeping each call site's existing markup pixel-identical (these are
 * behavior- and appearance-preserving conversions, not restyles).
 */
function NativeSelect({
  className,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(className)}
      {...props}
    />
  );
}

export { NativeSelect };
