// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// THE RUN'S GATE CARD DRAWS ON THE DRAWN GROUND, IN BOTH PALETTES
// (cinatra#3242).
// ---------------------------------------------------------------------------
// The ratified drawing, agent run and review surface §I, gives the run
// detail's card frame in its own stylesheet and uses that one class for the
// run detail's card in every example of the section — the placeholder reading
// and the gate reading alike:
//
//   .runcard { border: 1px solid var(--line); border-radius: 12px;
//              background: var(--surface-strong); padding: 18px 20px; }
//
// and it closes the pair with "One run detail, twice, in the same column under
// the same rail: first the placeholder, then the gate itself." There is no
// sentence in the section giving the gate reading a lighter ground than the
// placeholder reading.
//
// WHAT WAS MEASURED (cinatra#3242). The box that carries the gate — the one a
// person reads and decides on — drew on `.soft-panel`, which grounds on
// `var(--surface)`, one token light of the drawn `var(--surface-strong)`, so
// the card a reader is meant to focus on blended into the page around it. An
// earlier set (cinatra#3044) moved only the WORKING reading of the run page's
// panel onto the drawn ground; this file holds the reading that actually
// carries the gate, on every mount that has one.
//
// WHY THIS READS THE STYLESHEET RATHER THAN A BROWSER. jsdom implements
// neither Tailwind's utility generation nor custom-property substitution, so
// no `getComputedStyle` in this environment can tell a wrong colour from NO
// declaration at all. This file computes the ground the way the cascade does,
// in the shape `schedule-card-chosen-row-indigo-3279.test.tsx` already uses in
// this package: it takes the colour UTILITY off the class the section actually
// emits, maps it through the `@theme inline` registration, and resolves the
// token inside each palette block — light and dark — to the literal the
// browser would paint.
//
// WHY ONE MOUNT IS RENDERED AND THE OTHER IS READ AS SOURCE. The run page's
// panel is a client component and is rendered here in its real review reading,
// with the gate open, and the class is taken off the live DOM. The run
// screen's review step lives in `instance-screens.tsx`, which is a SERVER
// screen — "which no render of a server component can reach", as
// `instance-screens-setup-rail.test.ts` puts it — so that mount is read from
// the screen's own source, the same road that file already takes for the same
// section.
//
// THE CENSUS IS PART OF THE PIN. The defect's class is "every box that carries
// the gate draws the drawn ground", so the mounts are enumerated from the
// product tree rather than listed by hand: a mount added later with a review
// reading fails here, rather than first in a picture round.
//
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/run-gate-card-ground-surface-strong-3242.test.tsx

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

// NOTE ON THE IMPORT ROAD. The panel and its field renderers are imported
// DYNAMICALLY, inside the one arm that renders them, exactly as
// `review-gate-placeholder-heading-centring-ground-3053.test.tsx` imports the
// panel: a static import would pull the host's generated extension manifest
// into this file's module graph at COLLECT time, and the readings that need no
// render would then be lost with it wherever the dev-extension fleet is not
// synced.

// ---------------------------------------------------------------------------
// The panel's surroundings, stubbed exactly as this package's own review-slot
// pin stubs them (`agentic-run-panel.review-slot.test.tsx`), so the reading is
// about the run's state and nothing else.
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy({} as Record<string, () => null>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Loader2", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3242",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
  getSkillsForAgentAction: vi.fn(async () => []),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

const {
  readRunOutputEvidence,
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
} = vi.hoisted(() => ({
  readRunOutputEvidence: vi.fn(),
  getRunRecommendationHoldStateAction: vi.fn(),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction,
  confirmRunRecommendationAction,
  skipRunRecommendationAction,
}));
vi.mock("../run-actions", () => ({
  resetAgentRun: vi.fn(async () => ({ ok: true })),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  triggerAgentRun: vi.fn(async () => ({ ok: true })),
  readRunOutputEvidence,
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: null,
    error: null,
    presentationHint: null,
    isLive: false,
    interruptContext: null,
    streamedText: "",
    dataPartFrames: [],
  })),
}));

// ---------------------------------------------------------------------------
// The stylesheet, parsed as structure rather than searched as text. The shape
// is `schedule-card-chosen-row-indigo-3279.test.tsx`'s, for the same reason.
// ---------------------------------------------------------------------------

const APP_ROOT = path.resolve(__dirname, "../../../..");
const GLOBALS_CSS = readFileSync(path.join(APP_ROOT, "src/app/globals.css"), "utf8");

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
const PALETTES: Palette[] = ["light", "dark"];

/** Resolve a token to a literal by walking `var(...)` inside one palette
 *  block, falling back to `:root` the way the cascade does. */
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

/** `#ffffff` → `rgb(255, 255, 255)`; anything the browser would paint as it
 *  stands is handed back untouched, so a wrong colour is REPORTED rather than
 *  silently coerced. */
function asRgb(literal: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(literal.trim());
  if (!m) return literal.trim();
  const n = parseInt(m[1]!, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** The drawn ground, and the one-token-light ground the defect measured, as a
 *  browser reports them — per palette, from the palette's own block. */
const DRAWN = Object.fromEntries(
  PALETTES.map((p) => [p, asRgb(resolve(PALETTE[p], "--surface-strong"))]),
) as Record<Palette, string>;
const LIGHTER = Object.fromEntries(
  PALETTES.map((p) => [p, asRgb(resolve(PALETTE[p], "--surface"))]),
) as Record<Palette, string>;

type Utility = { token: string; alpha: number | null };

/** The colour utility a class list carries under one Tailwind prefix. */
function utility(className: string, prefix: string): Utility {
  const classes = className.split(/\s+/).filter(Boolean);
  // A VARIANT-QUALIFIED utility of the same property (`dark:bg-surface`)
  // outranks the plain one by specificity, so the plain reading below would be
  // a lie about what that palette paints. Refuse it rather than ignore it.
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
    // `bg-linear-to-b` is a gradient kind, not a colour.
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

/** The whole reading of one gate box's class: the drawn frame, the drawn
 *  ground in BOTH palettes, and the lighter ground gone. */
function readsAsTheDrawnGround(className: string, where: string): void {
  // The ground the defect measured is gone.
  expect(className, `${where} still draws the .soft-panel ground`).not.toMatch(
    /\bsoft-panel\b/,
  );
  // The drawn frame: `border: 1px solid var(--line); border-radius: 12px`.
  expect(className, `${where} draws the drawn card edge`).toMatch(/\bborder\b/);
  expect(className, `${where} draws the drawn card edge`).toMatch(/\bborder-line\b/);
  expect(className, `${where} draws the drawn card radius`).toMatch(/\brounded-card\b/);
  // `background: var(--surface-strong)`, resolved per palette.
  const ground = utility(className, "bg");
  expect(ground.alpha, `${where} paints its ground flat`).toBeNull();
  for (const palette of PALETTES) {
    expect(paints(ground, palette), `${where} in the ${palette} palette`).toBe(
      DRAWN[palette],
    );
    expect(paints(ground, palette), `${where} in the ${palette} palette`).not.toBe(
      LIGHTER[palette],
    );
  }
}

// ---------------------------------------------------------------------------
// The census: every mount of the run's review slot in PRODUCT code, and which
// of them have a reading that carries a gate.
// ---------------------------------------------------------------------------

const SLOT_ATTR = "data-run-review-slot";

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === ".next" ||
      entry === "__tests__"
    ) {
      continue;
    }
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** The value of one JSX attribute at `at`: a quoted literal, or a braced
 *  expression read with balanced braces. */
function attributeValue(src: string, at: number): { value: string; end: number } {
  let i = at;
  while (i < src.length && src[i] !== "=" && src[i] !== ">" && !/\s/.test(src[i]!)) i += 1;
  while (i < src.length && /\s/.test(src[i]!)) i += 1;
  if (src[i] !== "=") return { value: "", end: i };
  i += 1;
  while (i < src.length && /\s/.test(src[i]!)) i += 1;
  if (src[i] === '"' || src[i] === "'") {
    const quote = src[i]!;
    const end = src.indexOf(quote, i + 1);
    return { value: src.slice(i, end + 1), end: end + 1 };
  }
  if (src[i] === "{") {
    let depth = 0;
    const start = i;
    for (; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) return { value: src.slice(start, i + 1), end: i + 1 };
      }
    }
  }
  return { value: "", end: i };
}

/** The opening tag that carries the attribute at `at`. */
function openingTag(src: string, at: number): string {
  let start = at;
  while (start > 0 && src[start] !== "<") start -= 1;
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") depth -= 1;
    else if (src[i] === ">" && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

type Mount = { file: string; readings: string; className: string };

function mounts(): Mount[] {
  const found: Mount[] = [];
  const roots = [
    path.join(APP_ROOT, "src"),
    ...readdirSync(path.join(APP_ROOT, "packages"))
      .map((p) => path.join(APP_ROOT, "packages", p, "src"))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      }),
  ];
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, "utf8");
      let from = 0;
      for (;;) {
        const at = src.indexOf(SLOT_ATTR, from);
        if (at === -1) break;
        from = at + SLOT_ATTR.length;
        // Only a real JSX attribute counts — a mention inside a comment or a
        // selector string is not a mount.
        if (!/[\s]/.test(src[at - 1] ?? "")) continue;
        const { value } = attributeValue(src, at);
        if (value === "") continue;
        const tag = openingTag(src, at);
        const classAt = tag.indexOf("className");
        const className =
          classAt === -1 ? "" : attributeValue(tag, classAt).value;
        found.push({
          file: path.relative(APP_ROOT, file),
          readings: value,
          className,
        });
      }
    }
  }
  return found;
}

const MOUNTS = mounts();
/** A mount whose slot can read `review` is a box that carries a gate. */
const GATE_MOUNTS = MOUNTS.filter((m) => /"review"/.test(m.readings));

/** The class string literals one `className` expression can emit. */
function classLiterals(expr: string): string[] {
  const out = [...expr.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  expect(out.length, `no class string in: ${expr}`).toBeGreaterThan(0);
  return out;
}

// ---------------------------------------------------------------------------
// 1. THE CENSUS — which boxes carry a gate at all.
// ---------------------------------------------------------------------------

describe("the mounts of the run's review slot", () => {
  it("are the three the product draws, and two of them have a gate reading", () => {
    expect(MOUNTS.map((m) => m.file).sort()).toEqual([
      "packages/agents/src/agentic-run-panel.tsx",
      "packages/agents/src/instance-screens.tsx",
      "packages/agents/src/orchestrator-stepper-panel.tsx",
    ]);
    // The stepper panel's mount is WORKING-ONLY — it has no reading that
    // carries a gate, so the acceptance ("the reading that carries the card")
    // does not reach it and it keeps its own ground.
    expect(GATE_MOUNTS.map((m) => m.file).sort()).toEqual([
      "packages/agents/src/agentic-run-panel.tsx",
      "packages/agents/src/instance-screens.tsx",
    ]);
  });

  it("each draw the drawn ground on the reading that carries the gate", () => {
    // A mount added later without the drawn ground fails HERE, rather than
    // first in a picture round.
    expect(GATE_MOUNTS.length).toBeGreaterThan(0);
    for (const mount of GATE_MOUNTS) {
      for (const literal of classLiterals(mount.className)) {
        readsAsTheDrawnGround(literal, `${mount.file} (${literal})`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. THE RUN PAGE'S PANEL — rendered in its real review reading.
// ---------------------------------------------------------------------------

const SLOT = "[data-run-review-slot]";
const REVIEW_CARD = '[data-conformance-id="review-gate-card"]';

const RESOLVE_PENDING = {
  kind: "artifact_review_gate",
  state: { state: "pending", canDecide: true, canComment: true },
  body: null,
};

function stubFetch(run: () => Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/agents/runs/")) {
      return new Response(JSON.stringify(run()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(RESOLVE_PENDING), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The run has produced its output and is paused on its review gate. */
function gatedRun() {
  return {
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    messages: [],
    hitlContext: null,
    reviewGate: { ref: "lcr-opaque-3242", awaiting: false },
  };
}

beforeEach(() => {
  readRunOutputEvidence.mockReset();
  readRunOutputEvidence.mockResolvedValue({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
    outputsUnavailable: false,
    unlinkableOutputs: 0,
  });
  getRunRecommendationHoldStateAction.mockReset();
  getRunRecommendationHoldStateAction.mockResolvedValue({ state: "none" });
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function gateSlot(): Promise<HTMLElement> {
  stubFetch(gatedRun);
  const { ensureDefaultFieldRenderersRegistered } = await import(
    "../register-default-renderers"
  );
  ensureDefaultFieldRenderersRegistered();
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  render(
    <AgenticRunPanel
      runId="run-3242"
      initialStatus="running"
      initialError={null}
      initialMessages={[]}
      agUiEnabled={false}
      templateId="tmpl-3242"
      surface="agent-detail"
      initialReviewGate={{ ref: null, awaiting: false }}
    />,
  );
  await waitFor(
    () => {
      if (document.querySelector(REVIEW_CARD) === null) {
        throw new Error("the review screen did not arrive");
      }
    },
    { timeout: 10_000 },
  );
  const slot = document.querySelector<HTMLElement>(SLOT);
  expect(slot, "the run's review slot is drawn").not.toBeNull();
  expect(slot!.getAttribute(SLOT_ATTR)).toBe("review");
  return slot!;
}

describe("the run page's panel, on the reading that carries the gate", () => {
  it("draws the box on the drawn ground in both palettes, not the lighter one", async () => {
    const slot = await gateSlot();
    readsAsTheDrawnGround(slot.className, "the run panel's gate box");
  }, 20_000);

  it("keeps the swap the proof reads — the same slot, now reading review", async () => {
    const slot = await gateSlot();
    expect(slot.getAttribute(SLOT_ATTR)).toBe("review");
    expect(slot.querySelector(REVIEW_CARD)).not.toBeNull();
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 3. THE RUN SCREEN'S REVIEW STEP — the server screen, read as source.
// ---------------------------------------------------------------------------

const SCREEN_SRC = readFileSync(
  path.join(APP_ROOT, "packages/agents/src/instance-screens.tsx"),
  "utf8",
);

/** The review step's own surface: the opening tag of the box that says which
 *  reading it is drawing. */
function reviewStepSurfaceTag(): string {
  const at = SCREEN_SRC.indexOf(`${SLOT_ATTR}={gateRef`);
  expect(at, "the review step's surface names its reading off the gate ref").toBeGreaterThan(
    -1,
  );
  return openingTag(SCREEN_SRC, at);
}

describe("the run screen's review step, on the reading that carries the gate", () => {
  it("draws its box on the drawn ground in both palettes, not the lighter one", () => {
    const tag = reviewStepSurfaceTag();
    const classAt = tag.indexOf("className");
    expect(classAt, "the review step's surface carries a class").toBeGreaterThan(-1);
    for (const literal of classLiterals(attributeValue(tag, classAt).value)) {
      readsAsTheDrawnGround(literal, "the run screen's gate box");
    }
  });

  it("keeps the swap the proof reads — one box, two readings", () => {
    expect(reviewStepSurfaceTag()).toContain(`${SLOT_ATTR}={gateRef ? "review" : "working"}`);
  });
});

// ---------------------------------------------------------------------------
// 4. THE TWO GROUNDS ARE ACTUALLY DIFFERENT COLOURS, in each palette — so the
//    readings above are a measurement and not a tautology.
// ---------------------------------------------------------------------------

describe("the drawn ground and the one the defect measured", () => {
  it("are different literals in both palettes", () => {
    for (const palette of PALETTES) {
      expect(DRAWN[palette]).not.toBe(LIGHTER[palette]);
    }
    expect(DRAWN.light).toBe("rgb(255, 255, 255)");
    expect(LIGHTER.light).toBe("rgb(247, 247, 243)");
    expect(DRAWN.dark).toBe("oklch(0.21 0.04 259)");
    expect(LIGHTER.dark).toBe("oklch(0.165 0.04 259)");
  });

  it("read the same in the `:root` block the light palette inherits from", () => {
    expect(asRgb(resolve(ROOT_TOKENS, "--surface-strong"))).toBe(DRAWN.light);
    expect(asRgb(resolve(ROOT_TOKENS, "--surface"))).toBe(LIGHTER.light);
  });
});
