import type { HTMLAttributes, Ref } from "react";
import { cn } from "./lib/utils";

type MainProps = HTMLAttributes<HTMLElement> & {
  fixed?: boolean;
  fluid?: boolean;
  ref?: Ref<HTMLElement>;
};

/**
 * Main — canonical `<main>` element for Cinatra-design-strict pages. Wraps
 * route content in `px-4 py-6` and centers within a `max-w-7xl` container at
 * the `@7xl/content:` breakpoint. Pair with `PageHeader` + `PageContent` for
 * the standard three-component page shell.
 *
 * Modes:
 *   - default — auto-height, centered up to max-w-7xl
 *   - `fixed` — overflow-hidden flex container for full-viewport surfaces
 *   - `fluid` — no max-width clamp; spans the full container width
 */
export function Main({ fixed, className, fluid, ...props }: MainProps) {
  return (
    <main
      data-layout={fixed ? "fixed" : "auto"}
      className={cn(
        "px-4 py-6",
        fixed && "flex grow flex-col overflow-hidden",
        !fluid &&
          "@7xl/content:mx-auto @7xl/content:w-full @7xl/content:max-w-7xl",
        className,
      )}
      {...props}
    />
  );
}
