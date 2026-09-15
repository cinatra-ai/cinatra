/**
 * Colour maths for the design tokens' contrast floors (cinatra#3107).
 *
 * Pure, dependency-free, and deliberately small: parse the colour notations the
 * token layer actually uses (`#rrggbb`, `rgb()`/`rgba()`, `oklch()`), composite
 * a translucent ink over an opaque ground, and read a WCAG 2.x contrast ratio.
 *
 * The token layer states control boundaries as an ALPHA over a ground in one
 * theme and as a solid ink in the other, so a ratio can only be read after the
 * composite step — which is exactly why the dark control border could sit at
 * ~1.2 to 1 while every hand check looked at the raw token and saw "white".
 */

export interface Rgba {
  /** 0-255 */
  r: number;
  /** 0-255 */
  g: number;
  /** 0-255 */
  b: number;
  /** 0-1 */
  a: number;
}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Read an alpha written either as `0.4` or as `40%`. */
function parseAlpha(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 1;
  const t = raw.trim();
  if (t.endsWith("%")) return clamp01(Number.parseFloat(t) / 100);
  return clamp01(Number.parseFloat(t));
}

/** Read a component written either as `0.62` or as `62%` (of `scale`). */
function parseNumberOrPercent(raw: string, scale: number): number {
  const t = raw.trim();
  if (t.endsWith("%")) return (Number.parseFloat(t) / 100) * scale;
  return Number.parseFloat(t);
}

function gammaEncode(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clamp01(v) * 255;
}

/** oklch -> sRGB (0-255), via oklab and linear sRGB. */
export function oklchToRgb(l: number, c: number, hDeg: number): { r: number; g: number; b: number } {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const bb = c * Math.sin(h);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * bb;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * bb;
  const s_ = l - 0.0894841775 * a - 1.291485548 * bb;

  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;

  return {
    r: gammaEncode(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    g: gammaEncode(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    b: gammaEncode(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S),
  };
}

/**
 * Parse one CSS colour value into RGBA. Returns `null` for a notation this
 * helper does not model, so a caller can fail loudly instead of guessing.
 */
export function parseCssColor(input: string): Rgba | null {
  const value = input.trim();
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const hex = value.match(HEX_RE);
  if (hex) {
    const h = hex[1];
    const expand = (s: string) => Number.parseInt(s.length === 1 ? s + s : s, 16);
    if (h.length === 3 || h.length === 4) {
      return {
        r: expand(h[0]),
        g: expand(h[1]),
        b: expand(h[2]),
        a: h.length === 4 ? expand(h[3]) / 255 : 1,
      };
    }
    return {
      r: expand(h.slice(0, 2)),
      g: expand(h.slice(2, 4)),
      b: expand(h.slice(4, 6)),
      a: h.length === 8 ? expand(h.slice(6, 8)) / 255 : 1,
    };
  }

  const rgb = value.match(/^rgba?\(([^)]*)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(/[,/]/).map((p) => p.trim()).filter((p) => p !== "");
    if (parts.length < 3) return null;
    return {
      r: parseNumberOrPercent(parts[0], 255),
      g: parseNumberOrPercent(parts[1], 255),
      b: parseNumberOrPercent(parts[2], 255),
      a: parseAlpha(parts[3]),
    };
  }

  const oklch = value.match(/^oklch\(([^)]*)\)$/i);
  if (oklch) {
    const [coords, alphaRaw] = oklch[1].split("/");
    const parts = coords.trim().split(/\s+/).filter((p) => p !== "");
    if (parts.length < 3) return null;
    const { r, g, b } = oklchToRgb(
      parseNumberOrPercent(parts[0], 1),
      Number.parseFloat(parts[1]),
      Number.parseFloat(parts[2]),
    );
    return { r, g, b, a: parseAlpha(alphaRaw) };
  }

  return null;
}

/** Composite a (possibly translucent) ink over an opaque ground. */
export function compositeOver(ink: Rgba, ground: Rgba): Rgba {
  const a = clamp01(ink.a);
  return {
    r: ink.r * a + ground.r * (1 - a),
    g: ink.g * a + ground.g * (1 - a),
    b: ink.b * a + ground.b * (1 - a),
    a: 1,
  };
}

/** WCAG 2.x relative luminance of an opaque colour. */
export function relativeLuminance(color: Rgba): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  );
}

/** WCAG 2.x contrast ratio between two opaque colours (1 to 21). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The ratio a boundary ink actually achieves against a ground, alpha included.
 * This is the reading a person sees, not the raw token's nominal contrast.
 */
export function contrastAgainst(inkCss: string, groundCss: string): number {
  const ink = parseCssColor(inkCss);
  const ground = parseCssColor(groundCss);
  if (!ink || !ground) {
    throw new Error(`unsupported colour notation: ${!ink ? inkCss : groundCss}`);
  }
  return contrastRatio(compositeOver(ink, ground), { ...ground, a: 1 });
}
