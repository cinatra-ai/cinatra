/**
 * Header-rule conformance predicate (design/specs/app.html — "Page header" +
 * §Dividers).
 *
 * THE SPEC, verbatim from design/specs/app.html:
 *   • "Page header" example (spec line 1051):
 *       height:5px; border-top:1px solid var(--line-strong);
 *       border-bottom:1px solid var(--line-strong)
 *   • Section-rule token brief: "Etched paired-line dividers … Full navy,
 *       1px each, 5px gap."
 *   • §Dividers: "Major section dividers use full navy as paired rules — the
 *       etched-glass treatment. Never use a neutral grey on a divider."
 *   • --line-strong: #15213A === rgb(21, 33, 58)  (== --ink; NOT a grey)
 *
 * So a CONFORMANT page-header / tab-row rule is TWO full-navy (`--line-strong`)
 * 1px lines separated by a 5px gap, in EITHER of the two equivalent renderings
 * the shared chrome emits:
 *
 *   A. border-pair form — the spec's own inline markup and any `<hr>` with
 *      `border-top:1px solid` + `border-bottom:1px solid` (height 5px box → 7px
 *      visual).
 *   B. gradient form — the shipped `.divider-etched` utility
 *      (`@cinatra-ai/design/utilities.css`, mirrored in the host globals.css),
 *      a 7px element painting navy 0→1px, transparent 1→6px, navy 6→7px.
 *
 * The three ways connector setup pages have shipped it WRONG, each of which
 * this predicate REJECTS:
 *   C. UA `<hr>` fallback (class present, stylesheet not in scope) — a single
 *      `inset` GREY (rgb(128,128,128)) beveled line.
 *   D. hand-rolled plain hairline — a single low-alpha grey line
 *      (rgba(21,33,58,0.14) or `bg-border`).
 *   E. two-tone / invisible — a light-grey top + dark bottom bevel, or a rule
 *      that paints nothing.
 */

/** The one true divider paint: `--line-strong` #15213A. */
export const SPEC_NAVY = "rgb(21, 33, 58)";
const UA_GREY = "rgb(128, 128, 128)";

/** A computed-style shape (the subset Playwright/`getComputedStyle` gives us). */
export interface RuleComputed {
  height: string;
  backgroundImage: string;
  backgroundColor: string;
  borderTopWidth: string;
  borderTopStyle: string;
  borderTopColor: string;
  borderBottomWidth: string;
  borderBottomStyle: string;
  borderBottomColor: string;
}

export interface RuleVerdict {
  ok: boolean;
  form: "gradient" | "border-pair" | "none";
  reason: string;
}

function isTransparent(color: string): boolean {
  return (
    color === "transparent" ||
    color === "rgba(0, 0, 0, 0)" ||
    /,\s*0\)\s*$/.test(color)
  );
}

/**
 * Classify a rule element's computed style against the app.html spec.
 * `navy` defaults to the literal spec token but callers SHOULD pass the value
 * resolved from the in-page spec-reference rule, so the gate binds to the
 * canonical `--line-strong`, not just a hardcoded literal.
 */
export function classifyEtchedRule(
  cs: RuleComputed,
  navy: string = SPEC_NAVY,
): RuleVerdict {
  const bi = (cs.backgroundImage || "none").trim();

  // ---- Form B: the .divider-etched gradient ----
  if (bi !== "none" && /gradient/i.test(bi)) {
    if (bi.includes(UA_GREY)) {
      return { ok: false, form: "gradient", reason: `gradient paints UA grey ${UA_GREY}` };
    }
    // Any non-navy, non-transparent colour stop = an off-spec tone (two-tone bevel).
    const colorStops = bi.match(/rgba?\([^)]*\)|transparent/g) || [];
    const offSpec = colorStops.filter((c) => c !== navy && !isTransparent(c));
    if (offSpec.length > 0) {
      return { ok: false, form: "gradient", reason: `gradient paints off-spec tone(s): ${offSpec.join(", ")}` };
    }
    // GEOMETRY (codex convergence): colour class alone is not enough — a
    // navy/transparent/navy gradient with the wrong line thickness or gap
    // would paint the wrong rule. Require the EXACT spec stop sequence: navy
    // 0→1px (top line), transparent 1→6px (5px gap), navy 6→7px (bottom line),
    // on a 7px-tall element (== the spec's 1px+5px+1px etched rule).
    const stops = parseGradientStops(bi);
    const expected: Array<[string, string]> = [
      [navy, "0px"], [navy, "1px"],
      ["transparent", "1px"], ["transparent", "6px"],
      [navy, "6px"], [navy, "7px"],
    ];
    const geomOk =
      stops.length === expected.length &&
      expected.every(([col, pos], i) => {
        const s = stops[i];
        const colorOk = col === "transparent" ? isTransparent(s.color) : s.color === col;
        return colorOk && s.pos === pos;
      });
    if (!geomOk) {
      return {
        ok: false,
        form: "gradient",
        reason:
          `gradient geometry is not the spec 1px/5px-gap/1px etched rule — ` +
          `got stops [${stops.map((s) => `${s.color} ${s.pos}`).join(", ")}]`,
      };
    }
    if (cs.height !== "7px") {
      return { ok: false, form: "gradient", reason: `etched-rule element is ${cs.height} tall, spec is 7px (1px+5px+1px)` };
    }
    return { ok: true, form: "gradient", reason: "two full-navy 1px bands + 5px transparent gap, 7px (.divider-etched)" };
  }

  // ---- Form A: the border-pair (spec inline markup / <hr>) ----
  const topPaints = cs.borderTopStyle === "solid" && cs.borderTopWidth === "1px";
  const botPaints = cs.borderBottomStyle === "solid" && cs.borderBottomWidth === "1px";
  if (topPaints && botPaints) {
    if (cs.borderTopColor !== navy || cs.borderBottomColor !== navy) {
      return {
        ok: false,
        form: "border-pair",
        reason: `border lines are ${cs.borderTopColor}/${cs.borderBottomColor}, not full navy ${navy}` +
          (cs.borderTopColor === UA_GREY ? " (UA <hr> grey fallback)" : ""),
      };
    }
    if (cs.borderTopColor !== cs.borderBottomColor) {
      return { ok: false, form: "border-pair", reason: "two-tone rule — top and bottom lines differ (spec: identical navy)" };
    }
    return { ok: true, form: "border-pair", reason: "two full-navy 1px solid lines (spec inline form)" };
  }

  // ---- Everything else: single line / grey fill / grey bevel / invisible ----
  if (!isTransparent(cs.backgroundColor)) {
    return {
      ok: false,
      form: "none",
      reason: `single solid-fill hairline (${cs.backgroundColor})` +
        (/0\.\d+\)/.test(cs.backgroundColor) ? " — low-alpha grey, banned on dividers" : ""),
    };
  }
  const topBorders = cs.borderTopStyle !== "none" && cs.borderTopWidth !== "0px";
  const botBorders = cs.borderBottomStyle !== "none" && cs.borderBottomWidth !== "0px";
  if (topBorders && botBorders) {
    // Two borders that failed the solid-navy-1px test above — e.g. the UA
    // `<hr>` `inset` grey bevel (the "class present, stylesheet not in scope"
    // failure) or an off-spec tone/width.
    const grey = cs.borderTopColor === UA_GREY || cs.borderBottomColor === UA_GREY;
    return {
      ok: false,
      form: "none",
      reason:
        `off-spec border rule (${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor})` +
        (grey ? " — UA <hr> grey bevel fallback (utilities.css not in scope)" : ""),
    };
  }
  if (topBorders || botBorders) {
    return { ok: false, form: "none", reason: "single-line rule (spec requires a PAIRED etched rule)" };
  }
  return { ok: false, form: "none", reason: "rule paints nothing (invisible — no etched paired-line)" };
}

/** Split a gradient body on top-level commas only (not those inside rgb()/rgba()). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Parse a computed `linear-gradient(...)` into ordered colour stops
 * `{ color, pos }`. A leading direction/angle segment (no length) is skipped,
 * so `linear-gradient(to bottom, navy 0px, …)` and the Chromium default form
 * `linear-gradient(navy 0px, …)` both parse to the same stops.
 */
function parseGradientStops(bi: string): Array<{ color: string; pos: string }> {
  const inner = bi.slice(bi.indexOf("(") + 1, bi.lastIndexOf(")"));
  const stops: Array<{ color: string; pos: string }> = [];
  for (const seg of splitTopLevel(inner)) {
    const s = seg.trim();
    const m = s.match(/^(.*?)\s+(-?\d+(?:\.\d+)?(?:px|%))$/);
    if (!m) continue; // direction/angle (no position) — skip
    stops.push({ color: m[1].trim(), pos: m[2].trim() });
  }
  return stops;
}
