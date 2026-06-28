import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * LayoutButton — a semantically-correct `<button>` with NO control styling.
 *
 * The styled `<Button>` (./button) is the default actionable control, but its
 * `buttonVariants` base (fixed height, centered single-line layout,
 * `font-medium`, `select-none`, focus ring, active press-shift, transitions)
 * is wrong for the cases where a `<button>` exists purely as the clickable
 * wrapper around a free-form, multi-line block whose own children carry all
 * the typography — e.g. a notification row that is itself the click target.
 *
 * Forcing those through `<Button>` would change body/timestamp font weight,
 * text selectability and hover/focus affordances. LayoutButton renders the
 * raw `<button>` (allowed here — this dir is the design-system carve-out for
 * the raw-JSX lint) with only `type="button"` defaulted, and forwards every
 * prop including the call site's full `className`, so the conversion stays
 * behavior- and appearance-identical to the original element.
 */
function LayoutButton({
  className,
  type = "button",
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      data-slot="layout-button"
      type={type}
      className={cn(className)}
      {...props}
    />
  );
}

export { LayoutButton };
