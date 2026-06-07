import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * `cn` — class-name composition helper used across the Cinatra design system.
 * Merges Tailwind v4 utility classes via `tailwind-merge` so later utilities
 * override earlier ones predictably, and accepts `clsx`-style conditional
 * inputs for `className` props.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
