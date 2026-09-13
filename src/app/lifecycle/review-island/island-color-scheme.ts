// The ISLAND'S COLOUR SCHEME — the server half of one mechanism (cinatra#2931,
// epic #2926 W4).
//
// THE RULE. One card, drawn by its renderer, on every host — and the island the
// card frames follows its HOST's colour scheme on every host. Until this slice
// the island had no input from its host at all: it re-derived a palette of its
// own from the theme state of its OWN document, which on a first-party page
// happens to be the same store the app's theme control writes, and inside a
// third-party application is a store nothing ever wrote. So the same island that
// followed the app into dark painted its light palette inside a dark widget.
//
// The card now NAMES the host's palette on the island URL, on every host, and
// this module is what the island reads it back with. Both halves branch on the
// scheme and never on the host, which is what makes the parity structural
// instead of a widget-only repair.
//
// A CLOSED ENUM, AND NOTHING ELSE CROSSES. The parameter is not content, not a
// selector and not a credential: it is one of two words, and anything else is
// read as "the host named no palette" — the state every caller was in before
// this parameter existed, where the island keeps its own resolution.

/** The two palettes the app paints in. */
export type IslandColorScheme = "light" | "dark";

/** The query parameter the card names the host's palette with. The client half
 *  of this literal lives beside the card that writes it, and the two are pinned
 *  to each other by the card's own suite. */
export const REVIEW_ISLAND_COLOR_SCHEME_PARAM = "scheme";

/** The class each palette is painted with (`src/app/globals.css`: the
 *  `.cinatra` / `.dark` token blocks and `@custom-variant dark (&:is(.dark *))`).
 *  Light is `cinatra` — the app's own default palette name, not a third word. */
const PALETTE_CLASS: Record<IslandColorScheme, string> = {
  light: "cinatra",
  dark: "dark",
};

/**
 * The scheme a request names, or `null` for "this host named no palette".
 *
 * Deliberately total and deliberately silent: an unknown word, a repeated
 * parameter, an empty value and an absent one are ONE answer, so a caller can
 * neither widen the enum nor tell the two apart from the outside.
 */
export function parseIslandColorScheme(raw: unknown): IslandColorScheme | null {
  if (raw === "light" || raw === "dark") return raw;
  return null;
}

/** The palette class for a scheme; the empty string when none was named. */
export function islandPaletteClass(scheme: IslandColorScheme | null): string {
  return scheme ? PALETTE_CLASS[scheme] : "";
}

/**
 * The island BODY's class list.
 *
 * With no scheme named this is byte-for-byte the class list the island has
 * always carried, so a host that names nothing is left exactly where it was.
 * With one named it gains three things, and each is load-bearing:
 *
 *   • the PALETTE CLASS — the design tokens are declared on it, so they cascade
 *     to every descendant and `dark:` variants resolve against it;
 *   • `text-foreground` — RE-ANCHORING the inherited ink. `body` computes its
 *     `color` from the token as the DOCUMENT root sees it, and a descendant
 *     inherits that COMPUTED colour; redefining the token further down does not
 *     recompute it. Without this the renderer's own unstyled prose keeps the
 *     document's ink and reads as dark text on a dark panel;
 * AND IT NO LONGER FORCES THE FRAME'S FULL HEIGHT (cinatra#3080, fix leg 6).
 * `min-h-dvh` was here so "the document's own (unthemed) ground never paints
 * around the panel" — and the frame it filled was a fixed box, so on a target
 * shorter than that box it painted 261 to 272 css px of empty panel under the
 * reading, on every frame of the sixth reading and in both palettes. No drawing
 * sentence puts it there: the drawing draws the pane and then what comes after
 * it. The frame is now the height of THIS document (`reviewIslandFrameHeight`),
 * which is a height this class had to stop deciding for it — a document that is
 * always at least the frame's height can only ever measure the frame. Nothing
 * paints around the panel any more because there is no "around" left; the
 * canvas an overscroll exposes is still the named palette's, from
 * `islandDocumentGroundCss` below, which is where the document's own ground has
 * belonged all along.
 */
export function islandBodyClassName(scheme: IslandColorScheme | null): string {
  const base = "flex flex-col gap-3 bg-surface p-3";
  return scheme ? `${islandPaletteClass(scheme)} text-foreground ${base}` : base;
}

/**
 * The one declaration pair the wrapper cannot make for itself, or `null` when no
 * palette was named.
 *
 * A wrapper redefines tokens for what is INSIDE it; the document's own ground
 * sits outside. `color-scheme` on the root is what makes the frame's scrollbar
 * (and any UA-painted chrome) belong to the named palette, and dropping the
 * body's own paint hands the canvas — the strip an overscroll exposes — to that
 * same scheme instead of the palette the island resolved for itself. Both values
 * come from the closed enum above, so nothing a caller writes reaches this text.
 */
export function islandDocumentGroundCss(scheme: IslandColorScheme | null): string | null {
  return scheme ? `:root{color-scheme:${scheme}}body{background:transparent}` : null;
}

/**
 * The EMPTY island's class list — `undefined` (no class attribute at all) when
 * no scheme was named, which is the shape every denial has always drawn.
 *
 * A denial inside a dark card is still a painted rectangle, so it takes the
 * palette for the same reason the body does. Every denial takes the SAME one.
 */
export function islandEmptyClassName(
  scheme: IslandColorScheme | null,
): string | undefined {
  return scheme
    ? `${islandPaletteClass(scheme)} min-h-dvh bg-background text-foreground`
    : undefined;
}
