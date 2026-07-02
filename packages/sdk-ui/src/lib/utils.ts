import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge with the `@cinatra-ai/design` type-scale utilities
 * registered. The custom `text-*` font-size tokens are unknown to
 * tailwind-merge's default config, which classifies unknown `text-*` classes
 * as text-COLOR utilities — a later `text-foreground` would silently strip
 * `text-page-title-lg` from the class list. Keep in sync with the @theme
 * mapping in `@cinatra-ai/design/theme.css`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        "text-page-title-sm",
        "text-page-title-md",
        "text-page-title-lg",
        "text-listing-title",
        "text-badge-xs",
        "text-badge-2xs",
      ],
      tracking: [
        "tracking-title-tight",
        "tracking-kicker",
        "tracking-kicker-wide",
        "tracking-page-label",
      ],
    },
  },
});

/**
 * `cn` — class-name composition helper used across the Cinatra design system.
 * Merges Tailwind v4 utility classes via `tailwind-merge` so later utilities
 * override earlier ones predictably, and accepts `clsx`-style conditional
 * inputs for `className` props.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
