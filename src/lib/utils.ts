import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge with the design type-scale utilities registered (mirrors
 * `@cinatra-ai/sdk-ui`'s cn). Unknown `text-*` classes are classified as
 * text-COLOR utilities by tailwind-merge's default config, so a later
 * `text-foreground` would silently strip `text-page-title-lg`. Keep in sync
 * with the @theme mapping in src/app/globals.css.
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
        "text-micro",
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

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function formatCurrencyMillions(value?: number | null) {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return "Undisclosed";
  }

  return `$${value.toFixed(2)}M`;
}

export function firstName(fullName?: string) {
  if (!fullName) {
    return undefined;
  }

  return fullName.split(/\s+/)[0];
}

export function quarterLabel(quarterId: string) {
  return quarterId.replace("-", " ");
}

export function asArray(value: string | string[] | undefined) {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

export function compareValues(a: string | number | null | undefined, b: string | number | null | undefined) {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }

  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { sensitivity: "base" });
}

export function getPageNumbers(
  currentPage: number,
  totalPages: number
): (number | '...')[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, '...', totalPages];
  }
  if (currentPage >= totalPages - 3) {
    return [1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages];
}
