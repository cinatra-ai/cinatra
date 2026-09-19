/**
 * READING THE ALPHA OF A COMPUTED COLOUR (cinatra#3142).
 *
 * A browser serializes a computed `background-color` in whatever colour syntax
 * the author wrote — `rgb()`/`rgba()`, but equally `oklch(…)`, `oklab(…)`,
 * `color(srgb …)` or `color-mix(…)`, each of which carries its alpha after a
 * SLASH rather than as a fourth comma-separated component. This token layer
 * writes its grounds in `oklch()`, so a reader that treats "not rgba()" as
 * "opaque" would pass a translucent band written the way this repo writes every
 * one of them.
 *
 * So both spellings are read, and a serialization this reader does not
 * understand comes back as `null` — unreadable, which the gate that calls it
 * fails on. An alpha nobody could read is not a passing one.
 *
 * Unit-tested by src/app/__tests__/computed-color-alpha.test.ts.
 */
export function alphaOf(color: string): number | null {
  const c = color.trim().toLowerCase();
  if (c === "transparent") return 0;
  const fn = c.match(/^[a-z-]+\((.*)\)$/);
  if (!fn) return null;
  const args = fn[1];
  const slash = args.lastIndexOf("/");
  let raw: string;
  if (slash >= 0) {
    // Modern syntax: every component, then `/ <alpha>`.
    raw = args.slice(slash + 1).trim();
  } else {
    // Legacy syntax: `rgba(r, g, b, a)` / `hsla(h, s, l, a)`.
    const parts = args.split(",").map((part) => part.trim());
    if (parts.length === 4) {
      raw = parts[3];
    } else if (parts.length === 3 || args.trim().split(/\s+/).length >= 3) {
      // Three components and no alpha at all: fully opaque, by definition.
      raw = "1";
    } else {
      return null;
    }
  }
  if (raw === "" || raw === "none") return 1;
  const value = raw.endsWith("%")
    ? Number.parseFloat(raw.slice(0, -1)) / 100
    : Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}
