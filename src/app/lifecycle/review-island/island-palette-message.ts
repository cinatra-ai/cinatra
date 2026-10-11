import { parseIslandColorScheme, type IslandColorScheme } from "./island-color-scheme";

/** The host announces only its palette, never content or a credential. */
export const REVIEW_ISLAND_PALETTE_MESSAGE_TYPE = "cinatra.review-island.palette";

export function parseReviewIslandPalette(raw: unknown): IslandColorScheme | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  if (Object.keys(raw).length !== 2 || !Object.hasOwn(raw, "type") || !Object.hasOwn(raw, "scheme")) {
    return null;
  }
  const message = raw as { type: unknown; scheme: unknown };
  if (message.type !== REVIEW_ISLAND_PALETTE_MESSAGE_TYPE) return null;
  return parseIslandColorScheme(message.scheme);
}
