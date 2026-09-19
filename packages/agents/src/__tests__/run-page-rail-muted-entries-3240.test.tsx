// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// ONE ENTRY READS INK, EVERY OTHER ENTRY READS MUTED (cinatra#3240).
// ---------------------------------------------------------------------------
// The ratified drawing, agent run and review surface §I: "The step the run is
// paused on is highlighted; steps already passed sit above it, steps still to
// come below", and the rule itself, literally:
//
//   ".rail .step { color: var(--muted) }"    with ink reserved for
//   ".rail .step.active"
//
// WHAT THE MEASUREMENT FOUND, before a line of product code was written. One
// rail was rendered carrying a settled entry, the active entry and an upcoming
// entry together, and every title element was read:
//
//   settled  -> data-state="completed", utilities
//               data-[state=inactive]:text-muted-foreground
//               data-[state=completed]:text-muted-foreground
//   active   -> data-state="active",   the SAME two utilities
//   upcoming -> data-state="inactive", the SAME two utilities
//
// So the rows carry three distinct, correct states, and the two utilities are
// really emitted. What the rail never states is the OTHER half of the drawing's
// rule: at `data-state="active"` neither utility applies, and
// `src/components/reui/stepper.tsx` renders `StepperTitle` with no colour of its
// own, so the entry the reader is standing on computes no colour at all. It
// reads ink only by INHERITING the unlayered `body { color: var(--foreground) }`
// of `src/app/globals.css`, which is a colour the rail does not own: any
// container that states a text colour takes it, and the one distinction the
// drawing asks the rail to draw is left to the frame around it. The rail's
// fourth module already states both halves -- `runSurfaceRailTitleClass` in
// `run-surface-rail.tsx` returns `text-foreground` for the row the reader is on
// and `text-muted-foreground` for every other -- so this arm holds the three
// rows drawn through the vendored stepper to the same reading.
//
// WHY THIS READS THE STYLESHEET RATHER THAN A BROWSER. jsdom implements neither
// Tailwind's utility generation nor custom-property substitution, so no
// `getComputedStyle` in this environment can tell a wrong colour from NO
// declaration at all (the reason `schedule-card-chosen-row-indigo-3279.test.tsx`
// reads the same two halves, and the shape this file is written in). This file
// computes each entry's colour the way the cascade does: it takes the colour
// UTILITY that applies AT THAT ENTRY'S OWN `data-state`, maps it through the
// `@theme inline` registration, and resolves the token inside the palette block
// -- light and dark -- to the literal the browser would paint.
//
// Run:
//   pnpm --filter @cinatra-ai/agents exec vitest run \
//     src/__tests__/run-page-rail-muted-entries-3240.test.tsx

import { readFileSync } from "node:fs";
import path from "node:path";

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { RunStepRailPanel } from "../run-step-rail-panel";
import type { RunStepRailEntry } from "../run-step-rail";

// ---------------------------------------------------------------------------
// THE LIVE RAIL IS MOUNTED HERE TOO, so the wall below is the one
// `run-rail-active-step.test.tsx` already stands `OrchestratorStepperPanel` up
// behind: the run page's own rail row is one of the three sites that draw a
// rail title, and a reading that never mounts it cannot see it drift. Nothing
// here stubs a colour, a class or a stylesheet -- only the run's network,
// navigation and icon surroundings, which this file says nothing about.
// ---------------------------------------------------------------------------
const stream = vi.hoisted(() => ({ interruptContext: null as unknown }));

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/generated/field-renderer-components", () => ({
  GENERATED_FIELD_RENDERER_COMPONENTS: {},
}));
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {},
  GENERATED_CONNECTOR_ENTRY_MODULES: {},
  GENERATED_CONNECTOR_MCP_MODULES: {},
  GENERATED_DEV_SETUP_MODULES: {},
  GENERATED_WIDGET_STREAM_AGENTS: {},
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/agents/cinatra-ai/email-outreach-agent/run-3240",
}));
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="run-window-prompt">{placeholder}</div>
  ),
}));
vi.mock("../run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => ({ ok: true, entries: [] })),
}));
vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../a2a-actions", () => ({ getAgentBuilderTask: vi.fn(async () => null) }));
vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));
vi.mock("../orchestrator-actions", () => ({
  cancelOrchestratorAction: vi.fn(async () => ({ ok: true })),
  resumeStoppedOrchestratorAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../run-actions", () => ({
  startDevChildPreviewRun: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
  })),
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true })),
  decideRunRecommendationAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));
vi.mock("../server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3240",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
  setRunTrigger: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));
vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts?: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "completed",
    interruptContext: stream.interruptContext,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    lifecycleInterrupt: null,
    isLive: true,
    error: null,
  }),
}));

beforeEach(() => {
  stream.interruptContext = null;
  document.body.innerHTML = "";
  document.body.appendChild(document.createElement("main"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "pending_approval", inputParams: {} }),
    })),
  );
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    // any grouped PART is exactly this selector, so a grouped re-declaration of
    // a token cannot hide from this reading.
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

/** `#15213a` -> `rgb(21, 33, 58)`; anything the browser would paint as it
 *  stands (an `oklch(...)`, a keyword) is handed back untouched, so a wrong
 *  colour is REPORTED rather than silently coerced. */
function asRgb(literal: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(literal.trim());
  if (!m) return literal.trim();
  const n = parseInt(m[1]!, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** The literal one palette paints for a token the rail asks for by name. */
function tokenLiteral(palette: Palette, token: string): string {
  return asRgb(resolve(PALETTE[palette], token));
}

/** The literal a colour utility paints in one palette -- the registration in
 *  `@theme inline` followed by the token chain inside that palette's block. */
function paints(token: string, palette: Palette): string {
  const registered = THEME.get(`--color-${token}`);
  expect(
    registered,
    `\`--color-${token}\` is not registered in @theme inline, so the utility emits no rule at all`,
  ).toBeDefined();
  const varName = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/.exec(registered!);
  if (!varName) return asRgb(registered!);
  return asRgb(resolve(PALETTE[palette], varName[1]!));
}

/** A `text-*` class names a COLOUR only when `@theme inline` registers one for
 *  it: that is the same test the utility generator applies, and it is what keeps
 *  `text-sm`, `text-start` and `leading-[1.15]` out of this reading. */
function colourToken(cls: string, prefix = ""): string | null {
  if (!cls.startsWith(`${prefix}text-`)) return null;
  const name = cls.slice(`${prefix}text-`.length);
  if (name.startsWith("[")) return null;
  return THEME.has(`--color-${name}`) ? name : null;
}

/**
 * THE COLOUR ONE ELEMENT COMPUTES IN ONE OF ITS STATES.
 *
 * A rail title's class list is the same string in every state -- the state is a
 * `data-state` attribute the state-scoped utilities key off -- so reading the
 * list whole says nothing about what any one entry paints. This takes the
 * utility that actually APPLIES at the given state: its own
 * `data-[state=<state>]:text-*` when the list carries one, and the unscoped
 * `text-*` colour otherwise.
 */
function colourUtilityAt(className: string, state: string): string {
  const classes = className.split(/\s+/).filter(Boolean);
  // A VARIANT-QUALIFIED utility of the same property (`dark:text-foreground`)
  // outranks the plain one by specificity, so the reading below would be a lie
  // about what that palette paints. Refuse it rather than ignore it.
  const foreign = classes.filter((c) => {
    const colon = c.lastIndexOf(":");
    if (colon === -1) return false;
    const variant = c.slice(0, colon);
    return variant !== `data-[state=${state}]` && colourToken(c.slice(colon + 1)) !== null;
  });
  const applicable = foreign.filter((c) => !c.startsWith("data-[state="));
  expect(
    applicable,
    `a variant-qualified colour utility outranks the plain one in: ${className}`,
  ).toEqual([]);

  const scoped = classes
    .map((c) => colourToken(c, `data-[state=${state}]:`))
    .filter((t): t is string => t !== null);
  const plain = classes.map((c) => colourToken(c)).filter((t): t is string => t !== null);
  const found = scoped.length > 0 ? scoped : plain;
  expect(
    found.length,
    `the entry at data-state="${state}" states no colour of its own; it carries only: ${className}`,
  ).toBe(1);
  return found[0]!;
}

// ---------------------------------------------------------------------------
// ONE RAIL, THREE ENTRIES, RENDERED TOGETHER -- AT EVERY SITE THAT DRAWS ONE.
//
// THREE modules draw a rail row's title through the vendored stepper: the page
// rail's own step row (`run-step-rail-panel.tsx`), the shared gate /
// verification / lifecycle row (`run-step-rail-extra-entry.tsx`) and the run
// page's live rail row (`orchestrator-stepper-panel.tsx`). The colour rule is
// ONE rule for all three, so reading only the first would leave the other two
// free to drift back: a rail whose gate row or whose live row stated the muted
// half alone would again paint the entry the reader is standing on by
// inheritance, and every reading in this file would stay green. Each of the
// three is therefore rendered and read below, in both palettes.
// ---------------------------------------------------------------------------

function stepEntry(
  key: string,
  ordinal: number,
  status: RunStepRailEntry["status"],
): RunStepRailEntry {
  return { key, ordinal, kind: "step", label: key, status, sources: [] } as RunStepRailEntry;
}

/** A gate row -- "Review" -- drawn by the SHARED `RailExtraEntry`. */
function gateEntry(
  key: string,
  ordinal: number,
  status: RunStepRailEntry["status"],
): RunStepRailEntry {
  return {
    key,
    ordinal,
    kind: "gate",
    label: key,
    status,
    sources: ["gate"],
    gate: {
      gateId: `gate-${ordinal}`,
      reviewTaskId: `task-${ordinal}`,
      disposition: status === "resolved" ? "approved" : null,
      resolved: status === "resolved",
    },
  } as RunStepRailEntry;
}

type RailRow = { state: string; title: HTMLElement };

/**
 * EVERY RAIL TITLE STANDING IN THE GIVEN ROOT, keyed by the row's own rail
 * anchors -- `data-rail-kind` and `data-rail-status`, the vocabulary the rail
 * names its rows in -- together with the `data-state` that row actually
 * carries. Nothing is read off a class list here: the state is the attribute
 * the stepper wrote, and the colour is resolved from it further down.
 */
function railRowsIn(root: ParentNode): Map<string, RailRow> {
  const rows = new Map<string, RailRow>();
  for (const title of Array.from(
    root.querySelectorAll<HTMLElement>('[data-run-step-rail] [data-slot="stepper-title"]'),
  )) {
    const row = title.closest<HTMLElement>("[data-rail-kind]");
    expect(row, "every rail title stands in a row the rail anchors").not.toBeNull();
    const key = `${row!.getAttribute("data-rail-kind")}:${row!.getAttribute("data-rail-status")}`;
    rows.set(key, { state: title.getAttribute("data-state")!, title });
  }
  return rows;
}

/** One rail, rendered from the page rail's own entries. */
function panelRows(entries: RunStepRailEntry[], activeOrdinal: number): Map<string, RailRow> {
  const { container } = render(
    <RunStepRailPanel
      entries={entries}
      activeOrdinal={activeOrdinal}
      reviewHrefBase="/agents/v/p/i"
    />,
  );
  return railRowsIn(container);
}

/** What one row of a rendered rail paints in one palette. */
function rowPaints(rows: Map<string, RailRow>, key: string, palette: Palette): string {
  const row = rows.get(key);
  expect(row, `no ${key} row on the rendered rail`).toBeDefined();
  return paints(colourUtilityAt(row!.title.className, row!.state), palette);
}

/**
 * THE SPLIT THE DRAWING ASKS FOR, on one rendered rail: the row named by
 * `activeKey` reads the palette's ink, and EVERY other row on that rail reads
 * its muted. The three `data-state` values are required to be present and
 * distinct first, so a rail that collapsed them all into one state could not
 * pass this by accident.
 */
function readsTheSplitOn(rows: Map<string, RailRow>, activeKey: string, palette: Palette) {
  const ink = tokenLiteral(palette, "--foreground");
  const muted = tokenLiteral(palette, "--muted");
  // Ink and muted are two colours, or the reading below proves nothing.
  expect(ink).not.toBe(muted);

  expect([...rows.values()].map((r) => r.state).sort()).toEqual([
    "active",
    "completed",
    "inactive",
  ]);
  expect(rows.get(activeKey)!.state, "the row the run is paused on is the active one").toBe(
    "active",
  );

  // The entry the run is paused on, and it alone, reads the ink.
  expect(rowPaints(rows, activeKey, palette)).toBe(ink);
  // Every other entry on the rail -- the one above it and the one below it --
  // reads the muted token.
  for (const key of rows.keys()) {
    if (key === activeKey) continue;
    expect(rowPaints(rows, key, palette), `${key} reads muted`).toBe(muted);
  }
}

/** The rail the drawing describes, drawn from plain STEP rows: a step already
 *  passed, the step the run is paused on, and a step still to come -- in that
 *  order, in ONE list. */
function readsTheSplit(palette: Palette) {
  readsTheSplitOn(
    panelRows(
      [
        stepEntry("Settled step", 1, "completed"),
        stepEntry("Active step", 2, "pending"),
        stepEntry("Upcoming step", 3, "upcoming"),
      ],
      2,
    ),
    "step:pending",
    palette,
  );
}

/** The same rail drawn from the SHARED row instead: a gate already resolved,
 *  the gate the run is parked on, and a gate still to come. */
function readsTheSplitOnTheSharedRow(palette: Palette) {
  readsTheSplitOn(
    panelRows(
      [
        gateEntry("Settled review", 1, "resolved"),
        gateEntry("Open review", 2, "pending"),
        gateEntry("Later review", 3, "upcoming"),
      ],
      2,
    ),
    "gate:pending",
    palette,
  );
}

// ---------------------------------------------------------------------------
// THE RUN PAGE'S OWN LIVE RAIL, mounted -- the third site.
// ---------------------------------------------------------------------------

type PanelProps = import("../orchestrator-stepper-panel").OrchestratorStepperPanelProps;

/** The renderer id of the spine step the run is parked on below. */
const PARKED_RENDERER = "@cinatra-ai/email-recipient-selection-agent:output";

/** Three spine steps, so the live rail carries a passed row, the parked row and
 *  a row still to come -- the same three the page rail is read on above. */
const SPINE: PanelProps["stepperSteps"] = [
  { index: 1, stepNumber: 0, label: "Campaign setup", xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID },
  { index: 2, stepNumber: 1, label: "Review recipients", xRenderer: PARKED_RENDERER },
  { index: 3, stepNumber: 2, label: "Send", xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID },
];

async function liveRailRows(): Promise<Map<string, RailRow>> {
  // The run is parked ON the spine, so the highlighted row is one the live rail
  // draws with its OWN title -- which is the row this file is here to read.
  stream.interruptContext = {
    xRenderer: PARKED_RENDERER,
    schema: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"] },
    values: { stepNumber: 1, recipients: [] },
    reviewTaskId: "lg-run-3240",
  };
  const { OrchestratorStepperPanel } = await import("../orchestrator-stepper-panel");
  render(
    <OrchestratorStepperPanel
      runId="run-3240"
      initialStatus="pending_approval"
      initialError={null}
      agUiEnabled
      agentPackageName="@cinatra-ai/email-outreach-agent"
      inputParams={{}}
      stepperSteps={SPINE}
      agentId="cinatra-ai/email-outreach-agent"
      lgThreadId={null}
      templateId="tmpl-3240"
      templateName="Email Outreach Agent"
      railExtras={[]}
      reviewHrefBase="/agents/cinatra-ai%2Femail-outreach-agent/run-3240/review"
    />,
  );
  await waitFor(() => expect(railRowsIn(document).size).toBe(3));
  return railRowsIn(document);
}

describe("the run page rail in the LIGHT palette", () => {
  it("reads ink on the entry the run is paused on and muted on every other entry", () => {
    expect(tokenLiteral("light", "--foreground")).toBe("rgb(21, 33, 58)");
    expect(tokenLiteral("light", "--muted")).toBe("rgb(90, 100, 119)");
    readsTheSplit("light");
  });

  it("reads the same split on the shared gate row", () => {
    readsTheSplitOnTheSharedRow("light");
  });

  it("reads the same split on the live rail the run page mounts", async () => {
    readsTheSplitOn(await liveRailRows(), "step:pending", "light");
  });
});

describe("the run page rail in the DARK palette", () => {
  it("reads ink on the entry the run is paused on and muted on every other entry", () => {
    expect(tokenLiteral("dark", "--foreground")).toBe("oklch(0.984 0.003 247.858)");
    expect(tokenLiteral("dark", "--muted")).toBe("oklch(0.704 0.04 256.788)");
    readsTheSplit("dark");
  });

  it("reads the same split on the shared gate row", () => {
    readsTheSplitOnTheSharedRow("dark");
  });

  it("reads the same split on the live rail the run page mounts", async () => {
    readsTheSplitOn(await liveRailRows(), "step:pending", "dark");
  });
});

// ---------------------------------------------------------------------------
// THE READING REFUSES THE WAYS IT COULD LIE. A substitute for a browser is only
// worth the cases it cannot be fooled by.
// ---------------------------------------------------------------------------
describe("the reading itself", () => {
  it("refuses an entry that states no colour of its own, rather than inheriting one", () => {
    // This is the defect exactly: a title with only the two other states named
    // paints nothing at `active` and takes whatever the frame around it says.
    expect(() =>
      colourUtilityAt(
        "text-sm font-medium text-start data-[state=inactive]:text-muted-foreground",
        "active",
      ),
    ).toThrow();
  });

  it("does not mistake a size or an alignment for a colour", () => {
    expect(colourToken("text-sm")).toBeNull();
    expect(colourToken("text-start")).toBeNull();
    expect(colourToken("text-muted-foreground")).toBe("muted-foreground");
  });

  it("refuses a palette-qualified utility that would outrank the plain one", () => {
    expect(() =>
      colourUtilityAt("text-foreground dark:text-muted-foreground", "active"),
    ).toThrow();
  });

  it("resolves a utility through the registration and the palette, not by its name", () => {
    expect(paints("muted-foreground", "light")).toBe("rgb(90, 100, 119)");
    expect(paints("foreground", "light")).toBe("rgb(21, 33, 58)");
    expect(paints("muted-foreground", "dark")).toBe("oklch(0.704 0.04 256.788)");
    expect(paints("foreground", "dark")).toBe("oklch(0.984 0.003 247.858)");
  });
});
