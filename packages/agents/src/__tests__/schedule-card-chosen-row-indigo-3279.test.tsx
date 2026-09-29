// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// THE CHOSEN ROW'S INDIGO, IN BOTH PALETTES (cinatra#3279).
// ---------------------------------------------------------------------------
// The ratified lifecycle-cards drawing, §VI: "the chosen row taking the indigo
// edge and tint and owning its fields", and Components: "Indigo for active
// state." The scheduling step's own drawing writes the same edge literally —
// "chosen row border: 1px solid var(--blue)" over
// "linear-gradient(rgba(54,78,129,0.05), rgba(54,78,129,0.05))".
//
// WHAT WAS MEASURED (third proof round of #3193, both palettes, real runs). In
// the light palette the edge and the radio dot are the drawing's indigo. In the
// dark palette they are near-white: the row asks for the ACTION token
// (`border-primary` / `bg-primary`), and `.dark` re-declares `--accent` to a
// near-white oklch while `--primary` is `var(--accent)` — so the chosen row
// reads as a plain highlighted box rather than the indigo-marked choice, and
// the 5% tint is mixed from the near-white too.
//
// THE COLOUR THE DRAWING FIXES IS NOT THE PALETTE'S ACTION COLOUR. It marks the
// choice, and it is the same indigo in both palettes, so it cannot be carried
// by a token a palette re-declares. `--indigo-ink` carries it — declared in
// `:root` only, like the type scale, so it inherits into `.cinatra` and `.dark`
// unchanged — and is registered as `--color-indigo-ink` in the `@theme inline`
// block, which is what makes `border-indigo-ink` / `bg-indigo-ink/5` real.
//
// WHY THIS READS THE STYLESHEET RATHER THAN A BROWSER. jsdom implements neither
// Tailwind's utility generation nor custom-property substitution, so no
// `getComputedStyle` in this environment can tell a wrong colour from NO
// declaration at all (the reason src/app/__tests__/review-gate-design-tokens.test.ts
// reads the same two halves). This file computes the row's colour the way the
// cascade does: it takes the colour UTILITIES off the rendered row, maps each
// through the `@theme inline` registration, and resolves the token inside the
// palette block — light and dark — to the literal the browser would paint.
//
// THE TIER IS DELIBERATE. The acceptance asks for the assertion in the design
// conformance suite; tests/e2e/design/conformance is a Playwright suite that
// only runs against a live server, so the equivalent computed-colour assertion
// is placed at the component tier here, where it runs on every change to this
// package, and the drawn readings follow in the proof round.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/schedule-card-chosen-row-indigo-3279.test.tsx

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardState } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import type {
  ProposedSchedule,
  TriggerScheduleProposalViewBody,
} from "@cinatra-ai/agent-ui-protocol/renderable-views/trigger-schedule-proposal-view";

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ScheduleProposalCard } from "../schedule-proposal-card";
import { optionDiscClass, optionRowClass } from "../trigger-screen-client";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The stylesheet, parsed as structure rather than searched as text.
// ---------------------------------------------------------------------------

const GLOBALS_CSS = readFileSync(
  path.resolve(__dirname, "../../../../src/app/globals.css"),
  "utf8",
);

type Rule = { selector: string; body: string };

function topLevelRules(css: string): Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = 0;
  for (let i = 0; i < stripped.length; i += 1) {
    const c = stripped[i];
    if (c === "{") {
      if (depth === 0) bodyStart = i + 1;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        rules.push({
          selector: stripped
            .slice(selectorStart, bodyStart - 1)
            .trim()
            .replace(/\s+/g, " "),
          body: stripped.slice(bodyStart, i),
        });
        selectorStart = i + 1;
      }
    } else if (c === ";" && depth === 0) {
      selectorStart = i + 1;
    }
  }
  return rules;
}

const RULES = topLevelRules(GLOBALS_CSS);

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const flat = body.replace(/\{[^{}]*\}/g, "");
  for (const part of flat.split(";")) {
    const m = /^\s*(--[A-Za-z0-9-]+)\s*:\s*([\s\S]+)$/.exec(part);
    if (m) out.set(m[1]!, m[2]!.replace(/\s+/g, " ").trim());
  }
  return out;
}

/** Every declaration of every block with this selector, in stylesheet order. */
function block(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  let seen = 0;
  for (const rule of RULES) {
    // A rule may GROUP its selectors (`.dark, .dark *`). The block counts when
    // any grouped PART is exactly this selector; reading the whole selector
    // text instead would let a grouped re-declaration of a token hide from
    // this reading, while a descendant-only block (`.dark .badge`) still does
    // not count, because its declarations reach only that element.
    const parts = rule.selector.split(",").map((part) => part.trim());
    if (!parts.includes(selector)) continue;
    seen += 1;
    for (const [k, v] of declarations(rule.body)) out.set(k, v);
  }
  if (seen === 0) throw new Error(`no \`${selector}\` block in globals.css`);
  return out;
}

const THEME = block("@theme inline");
const ROOT_TOKENS = block(":root");
const PALETTE = {
  light: block(".cinatra"),
  dark: block(".dark"),
} as const;
type Palette = keyof typeof PALETTE;

/** Resolve a token to a literal by walking `var(...)` inside one palette block,
 *  falling back to `:root` the way the cascade does for a value the block does
 *  not re-declare. */
function resolve(
  tokens: Map<string, string>,
  name: string,
  seen = new Set<string>(),
): string {
  if (seen.has(name)) throw new Error(`token cycle at ${name}`);
  seen.add(name);
  const raw = tokens.get(name) ?? ROOT_TOKENS.get(name);
  if (raw === undefined) throw new Error(`no token ${name}`);
  const m = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/.exec(raw);
  return m ? resolve(tokens, m[1]!, seen) : raw;
}

/** `#364e81` → `rgb(54, 78, 129)`; anything the browser would paint as it
 *  stands (an `oklch(...)`, a keyword) is handed back untouched, so a wrong
 *  colour is REPORTED rather than silently coerced. */
function asRgb(literal: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(literal.trim());
  if (!m) return literal.trim();
  const n = parseInt(m[1]!, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** The drawing's indigo, as a browser reports it. */
const INDIGO = "rgb(54, 78, 129)";

type Utility = { token: string; alpha: number | null };

/** The colour utility a class list carries under one Tailwind prefix, split
 *  into the colour name and its opacity modifier (`bg-primary/5` → 5). */
function utility(className: string, prefix: string): Utility {
  const classes = className.split(/\s+/).filter(Boolean);
  // A VARIANT-QUALIFIED utility of the same property (`dark:border-primary`)
  // outranks the plain one by specificity, so the plain reading below would be
  // a lie about what the dark palette paints. Refuse it rather than ignore it.
  const variants = classes.filter((c) => {
    const colon = c.lastIndexOf(":");
    return colon !== -1 && c.slice(colon + 1).startsWith(`${prefix}-`);
  });
  expect(
    variants,
    `a variant-qualified \`${prefix}-*\` utility outranks the plain one in: ${className}`,
  ).toEqual([]);
  const found = classes
    .filter((c) => c.startsWith(`${prefix}-`))
    .filter((c) => !/^(?:.*-)?\[/.test(c))
    // `border-2` is a WIDTH and `bg-linear-to-b` is a gradient kind; neither
    // is a colour utility, and both share the prefix.
    .filter((c) => {
      const rest = c.slice(prefix.length + 1);
      return !/^\d/.test(rest) && !/^linear-/.test(rest);
    });
  expect(
    found.length,
    `expected exactly one \`${prefix}-*\` utility in: ${className}`,
  ).toBe(1);
  const [name, mod] = found[0]!.slice(prefix.length + 1).split("/");
  return { token: name!, alpha: mod === undefined ? null : Number(mod) };
}

/** An edge, a ring or a filled dot is painted FLAT: the drawing gives an
 *  opacity only to the 5 percent tint, and an opacity modifier anywhere else
 *  would mix the indigo into the ground behind it — `border-indigo-ink/0`
 *  names the right token and paints nothing at all. */
function opaque(u: Utility): Utility {
  expect(
    u.alpha,
    `\`${u.token}\` carries an opacity modifier where the drawing paints flat`,
  ).toBeNull();
  return u;
}

/** The literal a colour utility paints in one palette — the registration in
 *  `@theme inline` followed by the token chain inside that palette's block. */
function paints(u: Utility, palette: Palette): string {
  const registered = THEME.get(`--color-${u.token}`);
  expect(
    registered,
    `\`--color-${u.token}\` is not registered in @theme inline, so the utility emits no rule at all`,
  ).toBeDefined();
  const varName = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/.exec(registered!);
  if (!varName) return asRgb(registered!);
  return asRgb(resolve(PALETTE[palette], varName[1]!));
}

// ---------------------------------------------------------------------------
// The card, mounted the way the drawn surface mounts it.
// ---------------------------------------------------------------------------

const VIEW = {
  viewType: "trigger_schedule_proposal" as const,
  schemaVersion: 1,
  ref: "indigo-3279-ref",
};

const ONE_OFF: ProposedSchedule = {
  kind: "scheduled",
  runAt: "2026-07-14T09:00",
  timezone: "Europe/Berlin",
};

function settled(
  over: Partial<Extract<TriggerScheduleProposalViewBody, { phase: "settled" }>> = {},
): TriggerScheduleProposalViewBody {
  return {
    phase: "settled",
    version: 1,
    agentName: "Q3 cohort sweep",
    runId: "run-3279",
    schedule: ONE_OFF,
    triggerType: "scheduled",
    scheduleCopy: "Once, at 2026-07-14 09:00",
    timezone: "Europe/Berlin",
    gatedSteps: [],
    released: false,
    arming: false,
    canSave: true,
    canCancel: false,
    ...over,
  };
}

function mount(body: TriggerScheduleProposalViewBody, firedOnce = false) {
  const state: LifecycleCardState =
    body.phase === "settled"
      ? { state: "settled" }
      : { state: "pending", canDecide: true, canComment: false };
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          kind: "trigger_schedule_proposal",
          state,
          body,
          ...(firedOnce ? { firedOnce: true } : {}),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
  return render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <ScheduleProposalCard view={VIEW} />
    </LifecycleCardSurfaceProvider>,
  );
}

async function chosenRow(firedOnce = false): Promise<HTMLElement> {
  const view = mount(settled(firedOnce ? { released: true, canSave: false } : {}), firedOnce);
  let row: HTMLElement | null = null;
  await waitFor(() => {
    row = view.container.querySelector<HTMLElement>(
      '[data-schedule-option][data-chosen="true"]',
    );
    expect(row).not.toBeNull();
  });
  return row as unknown as HTMLElement;
}

/** The radio marker's ring and, inside it, the filled dot. */
function marker(row: HTMLElement): { disc: HTMLElement; dot: HTMLElement } {
  const disc = row.querySelector<HTMLElement>('[class*="rounded-full"][class*="border-2"]');
  expect(disc, "the chosen row draws its radio marker").not.toBeNull();
  const dot = disc!.querySelector<HTMLElement>("span");
  expect(dot, "the chosen marker is filled").not.toBeNull();
  return { disc: disc!, dot: dot! };
}

// ---------------------------------------------------------------------------
// 1. THE DARK PALETTE — the reading the proof round graded false.
// ---------------------------------------------------------------------------
describe("the schedule card's chosen row in the DARK palette", () => {
  it("draws its edge in the drawing's indigo, not the near-white dark action colour", async () => {
    const row = await chosenRow();
    expect(paints(opaque(utility(row.className, "border")), "dark")).toBe(INDIGO);
  });

  it("fills its radio dot with the same indigo, and rings it in the same indigo", async () => {
    const { disc, dot } = marker(await chosenRow());
    expect(paints(opaque(utility(dot.className, "bg")), "dark")).toBe(INDIGO);
    expect(paints(opaque(utility(disc.className, "border")), "dark")).toBe(INDIGO);
  });

  it("mixes its tint from the edge's own colour, at the drawing's 5 percent", async () => {
    const row = await chosenRow();
    const edge = opaque(utility(row.className, "border"));
    const tint = utility(row.className, "bg");
    // "the tint is derived from the same colour" — one token, not two.
    expect(tint.token).toBe(edge.token);
    expect(tint.alpha).toBe(5);
    expect(paints(tint, "dark")).toBe(INDIGO);
  });

  it("draws the fired one-off's READING row in the same indigo", async () => {
    const row = await chosenRow(true);
    const { disc, dot } = marker(row);
    expect(paints(utility(row.className, "border"), "dark")).toBe(INDIGO);
    expect(paints(opaque(utility(disc.className, "border")), "dark")).toBe(INDIGO);
    expect(paints(opaque(utility(dot.className, "bg")), "dark")).toBe(INDIGO);
  });
});

// ---------------------------------------------------------------------------
// 2. THE SHARED ROW — the trigger screen draws the same chosen row.
// ---------------------------------------------------------------------------
describe("the chosen row the trigger screen shares with the card", () => {
  it("takes the indigo edge and the indigo 5 percent tint in the dark palette", () => {
    const className = optionRowClass(true, true);
    const edge = opaque(utility(className, "border"));
    expect(paints(edge, "dark")).toBe(INDIGO);
    for (const prefix of ["from", "to"]) {
      const stop = utility(className, prefix);
      expect(stop.token).toBe(edge.token);
      expect(stop.alpha).toBe(5);
      expect(paints(stop, "dark")).toBe(INDIGO);
    }
  });

  it("rings its radio disc in the same indigo in the dark palette", () => {
    expect(paints(opaque(utility(optionDiscClass(true), "border")), "dark")).toBe(INDIGO);
  });

  it("leaves the UNCHOSEN row on the control boundary, untouched", () => {
    expect(utility(optionRowClass(false, true), "border").token).toBe("input");
    expect(utility(optionDiscClass(false), "border").token).toBe("input");
  });
});

// ---------------------------------------------------------------------------
// 3. THE LIGHT PALETTE IS UNCHANGED. Read generically — the utility the row
//    actually carries, whatever it is named — so this reading holds across the
//    change rather than being rewritten by it.
// ---------------------------------------------------------------------------
describe("the light palette keeps the reading the proof round graded true", () => {
  it("keeps the card's indigo edge, indigo dot and 5 percent tint", async () => {
    const row = await chosenRow();
    const { disc, dot } = marker(row);
    expect(paints(opaque(utility(row.className, "border")), "light")).toBe(INDIGO);
    expect(paints(opaque(utility(disc.className, "border")), "light")).toBe(INDIGO);
    expect(paints(opaque(utility(dot.className, "bg")), "light")).toBe(INDIGO);
    const tint = utility(row.className, "bg");
    expect(tint.alpha).toBe(5);
    expect(paints(tint, "light")).toBe(INDIGO);
  });

  it("keeps the shared row's indigo edge and 5 percent tint", () => {
    const className = optionRowClass(true, true);
    expect(paints(opaque(utility(className, "border")), "light")).toBe(INDIGO);
    expect(paints(utility(className, "from"), "light")).toBe(INDIGO);
    expect(paints(opaque(utility(optionDiscClass(true), "border")), "light")).toBe(INDIGO);
  });
});

// ---------------------------------------------------------------------------
// 4. THE TOKEN ITSELF — why the row can ask for one colour in two palettes.
// ---------------------------------------------------------------------------
describe("the token the chosen row now asks for", () => {
  it("is the drawing's indigo, declared once", () => {
    expect(ROOT_TOKENS.get("--indigo-ink")?.toLowerCase()).toBe("#364e81");
  });

  it("is never re-declared per palette, so both palettes paint the same colour", () => {
    // The defect exactly: `--accent` IS re-declared in `.dark`, and `--primary`
    // aliases it, so a row keyed to the action token loses the drawn colour.
    expect(PALETTE.dark.has("--indigo-ink")).toBe(false);
    expect(PALETTE.light.has("--indigo-ink")).toBe(false);
    expect(asRgb(resolve(PALETTE.dark, "--indigo-ink"))).toBe(INDIGO);
    expect(asRgb(resolve(PALETTE.light, "--indigo-ink"))).toBe(INDIGO);
  });

  it("is registered as a colour utility, so the classes emit real rules", () => {
    expect(THEME.get("--color-indigo-ink")).toBe("var(--indigo-ink)");
  });
});

// ---------------------------------------------------------------------------
// 5. THE READING REFUSES THE THREE WAYS IT COULD LIE. A substitute for a
//    browser is only worth the cases it cannot be fooled by, so each is
//    exercised here against the same helpers the readings above use.
// ---------------------------------------------------------------------------
describe("the reading itself", () => {
  it("refuses a dark-palette override of the plain utility instead of ignoring it", () => {
    expect(() => utility("border border-indigo-ink dark:border-primary", "border")).toThrow();
  });

  it("refuses an opacity modifier where the drawing paints flat", () => {
    expect(() => opaque(utility("border border-indigo-ink/0", "border"))).toThrow();
    expect(utility("border border-indigo-ink/0", "border").alpha).toBe(0);
  });

  it("sees a token re-declared by a GROUPED palette selector", () => {
    const grouped = topLevelRules(".dark, .dark * { --indigo-ink: #ffffff; }");
    const parts = grouped[0]!.selector.split(",").map((part) => part.trim());
    expect(parts).toContain(".dark");
    expect(declarations(grouped[0]!.body).get("--indigo-ink")).toBe("#ffffff");
  });

  it("reads a token the dark ramp re-declares, not the root value behind it", () => {
    // This case read the ACTION token until the shared-primitives grading
    // landed: the dark ramp aliased it to the stock near-white slate, so a row
    // keyed to it lost the drawn colour — the defect every reading in this
    // file was written against. That ramp now carries the drawing's ONE
    // indigo, so the action token paints the same colour in both palettes and
    // can no longer show that this reading follows a per-palette
    // re-declaration at all. The indigo's TEXT/STROKE role can: it is declared
    // once at the light end and re-declared on the dark ramp, where the fill
    // colour measures about 2.2:1 on the near-black ground and is unreadable.
    expect(paints({ token: "accent-ink", alpha: null }, "dark")).not.toBe(INDIGO);
    expect(paints({ token: "accent-ink", alpha: null }, "light")).toBe(INDIGO);
  });
});
