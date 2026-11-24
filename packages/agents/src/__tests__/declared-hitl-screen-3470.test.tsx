// @vitest-environment jsdom
/**
 * cinatra#3470: an agent DECLARES its HITL screen; the host draws it.
 *
 * A binding that carries `screen` is registered by the host from that
 * declaration: a "card" is drawn by the host's declared-screen card (title,
 * note, fact, words, quote and field sections, up to three decisions), and a
 * "kind" by the host's own component for the binding's kind. Pinned here:
 *
 *   - every word on the card comes from the declaration or the run value;
 *   - a decision or a field only STAGES its answer (carry keys + the exact
 *     declared answer); the card draws no send of its own, so the host's one
 *     Continue sends it (drawings: app-artifact-review I.4 and I.5,
 *     app-lifecycle-cards V.1);
 *   - design#243 V.1 draws it: each fact is its declared label over the value
 *     as text, with no box; the decision is one answer row per declared
 *     answer inside the card's fields, never a footer of buttons;
 *   - only an http(s) run value is drawn as a link; a missing value draws no line;
 *   - the declaration is validated again at registration: an invalid screen,
 *     an unknown or inherited kind name, or a kind whose host entry is only
 *     the schema floor registers NOTHING, and the package component is never
 *     the fallback;
 *   - a binding without `screen` keeps its existing road;
 *   - each stage is the WHOLE answer with its JSON as `userResponse`, and the
 *     entry tells every host to replace its buffer with it;
 *   - a conversation host registers a declared binding with its params, so a
 *     "kind" list picker keeps its declared question there too.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/declared-hitl-screen-3470.test.tsx
 */
import { useState } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen as dom, waitFor, within } from "@testing-library/react";

import type { LifecycleCardHost } from "@cinatra-ai/agent-ui-protocol/renderable-views";

// The conversation hosts read the gate through the card's own authorized read.
const screenStateMock = vi.fn();
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: async () => ({ connectedApps: [], gmailAliases: [] }),
  getRuntimeFieldRendererBindingsAction: async () => ({ bindings: [], refusedScreenIds: [] }),
}));
vi.mock("../list-picker-actions", () => ({
  fetchAvailableLists: vi.fn(async () => []),
}));
const hitlActions = vi.hoisted(() => ({
  approveReviewTask: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../hitl-actions", () => hitlActions);

import {
  RENDERER_NAMESPACE_RE,
  fieldRendererRegistry,
  type FieldRendererEntry,
  type FieldRendererProps,
} from "../field-renderer-registry";
import * as registerModule from "../register-default-renderers";
import { knownFieldRendererKinds, registerFieldRendererBindings } from "../register-default-renderers";
import {
  __resetFieldRendererComponentMapForTests,
  __setFieldRendererComponentMapForTests,
} from "../field-renderer-components";
import { ContextSelectorRenderer } from "../context-selector-renderer";
import { SchemaOnlyFloorRenderer } from "../schema-field-renderer";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";
import { parseAgentHitlScreenState } from "../agent-hitl-screen";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import {
  continueApprovalFlag,
  continueHeldByRenderer,
  declaredHitlApprovalFlag,
  isGroupedSetupRenderer,
} from "../hitl-gate-submit";

/** The gate of `ID` once the host's bindings loaded. */
const LOADED_GATE = { xRenderer: "@acme-test/publish-agent:confirm", bindings: { status: "loaded" as const, announcedIds: new Set<string>(), freshlyReadIds: new Set<string>() } };

const ID = "@acme-test/publish-agent:confirm";

// Fixture declaration: the words are the fixture's own, standing for an
// agent's declared text.
const CARD = {
  layout: "card",
  title: "Send this fixture out?",
  sections: [
    { type: "fact", label: "Account", key: "accountName" },
    { type: "fact", label: "Destination", key: "destinationName", qualifierKey: "destinationType" },
    { type: "fact", label: "Source", key: "sourceUrl" },
    { type: "words", label: "The words that go out", key: "content" },
    { type: "quote", key: "excerpt" },
    { type: "note", text: "Fixture note: go back to change the words." },
  ],
  decisionLabel: "Fixture decision",
  decisions: [
    { label: "Do not send", answer: { approved: false } },
    { label: "Send it", answer: { approved: true } },
  ],
  carry: ["itemId", "revisionId"],
  requires: ["itemId", "revisionId"],
};

const VALUE = {
  itemId: "item-1",
  revisionId: "rev-1",
  accountName: "Fixture Account",
  destinationName: "Fixture Org",
  destinationType: "organization",
  sourceUrl: "https://example.test/source",
  content: "Line one.\nLine two.",
  excerpt: "A fixture excerpt.",
  unrelated: "not carried",
};

/** What a declared card stages: the whole answer and its JSON as the resume text. */
function staged(answer: Record<string, unknown>): Record<string, unknown> {
  return { ...answer, userResponse: JSON.stringify(answer) };
}

function entryOf(id = ID): FieldRendererEntry | undefined {
  return fieldRendererRegistry.list().find((e) => e.id === id);
}

/** V.1 `nf-label`: the small uppercase mono label on the muted ink. */
function expectDeclaredLabel(el: HTMLElement) {
  for (const c of ["font-mono", "uppercase", "text-badge-2xs", "text-muted-foreground"]) {
    expect(el.className.split(/\s+/)).toContain(c);
  }
}

/** V.1 `nf-input`: no box and no fill, a dashed hairline under the text. */
function expectDeclaredInput(el: HTMLElement) {
  const classes = el.className.split(/\s+/);
  for (const c of ["border-0", "border-b", "border-dashed", "rounded-none", "bg-transparent", "px-0", "shadow-none"]) {
    expect(classes).toContain(c);
  }
  expect(classes).not.toContain("border");
}

/**
 * Mount the entry's renderer the way every mid-run host does: the run value
 * under a buffer the host keeps, each stage replacing that buffer, and the
 * two handed over apart (as `wholeAnswerStageProps` does). `initial` is a
 * buffer the host already holds (a card drawn again elsewhere in the
 * conversation).
 */
function mount(value: unknown, onChange = vi.fn(), initial: Record<string, unknown> = {}) {
  const entry = entryOf();
  expect(entry).toBeDefined();
  const Renderer = entry!.renderer;
  const runValue = value as Record<string, unknown>;
  function Host() {
    const [buffer, setBuffer] = useState<Record<string, unknown>>(initial);
    const props = {
      fieldName: "field",
      schema: { "x-renderer": ID },
      value: { ...runValue, ...buffer },
      onChange: (next: unknown) => {
        onChange(next);
        setBuffer(next as Record<string, unknown>);
      },
      context: { connectedApps: [] },
      // What `wholeAnswerStageProps` hands a whole-answer renderer.
      hitlStage: { runValue, staged: buffer },
    } as FieldRendererProps;
    return <Renderer {...props} />;
  }
  render(<Host />);
  return onChange;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fieldRendererRegistry.clear();
  __resetFieldRendererComponentMapForTests();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  fieldRendererRegistry.clear();
  __resetFieldRendererComponentMapForTests();
  vi.restoreAllMocks();
});

describe("a declared card is drawn by the host (cinatra#3470)", () => {
  beforeEach(() => {
    registerFieldRendererBindings([
      { id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: CARD },
    ]);
  });

  it("registers the card as a mid-run renderer that draws no send of its own", () => {
    const entry = entryOf();
    expect(entry).toBeDefined();
    expect(entry!.renderer).not.toBe(SchemaOnlyFloorRenderer);
    expect(entry!.drawsOwnSubmit).toBe(false);
    // Pure host rendering with no action: drawn on a credential-only host too.
    expect(entry!.credentialSafe).toBe(true);
    expect(entry!.midRunHitl).toBe(true);
  });

  it("is credential-safe in its own source: no server action, no registry lookup", () => {
    // The same two readings hitl-screen-credential-safety.test.ts makes of
    // every kind declared safe, made of the declared card's own module.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "declared-hitl-screen-renderer.tsx"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(source).toContain("export function makeDeclaredHitlScreenRenderer");
    expect(source).not.toMatch(/from\s+"\.\/[A-Za-z0-9-]*-actions"/);
    expect(source).not.toMatch(/"use server"/);
    expect(source).not.toMatch(/fieldRendererRegistry/);
  });

  it("draws the declared title, facts, words, quote and note from the run value", () => {
    mount(VALUE);
    expect(dom.getByText("Send this fixture out?")).toBeTruthy();
    expect(dom.getByText("Account")).toBeTruthy();
    expect(dom.getByText("Fixture Account")).toBeTruthy();
    expect(dom.getByText("Destination (organization)")).toBeTruthy();
    expect(dom.getByText("The words that go out")).toBeTruthy();
    expect(dom.getByText(/Line one\.\s+Line two\./)).toBeTruthy();
    expect(dom.getByText("A fixture excerpt.")).toBeTruthy();
    expect(dom.getByText("Fixture note: go back to change the words.")).toBeTruthy();
    // A fact value is text, never a link (app-lifecycle-cards V.1: "a fact is text").
    expect(dom.getByText("https://example.test/source")).toBeTruthy();
    expect(dom.queryByRole("link")).toBeNull();
    // The card draws the declared decisions and no Continue of its own.
    expect(dom.getByRole("radio", { name: "Do not send" })).toBeTruthy();
    expect(dom.getByRole("radio", { name: "Send it" })).toBeTruthy();
    expect(dom.queryByRole("button", { name: /continue/i })).toBeNull();
  });

  it("draws each fact as its declared label over the value as text, with no box (design#243 V.1)", () => {
    mount(VALUE);
    for (const [label, text] of [
      ["Account", "Fixture Account"],
      ["Destination (organization)", "Fixture Org"],
      ["Source", "https://example.test/source"],
    ]) {
      const labelEl = dom.getByText(label);
      const fact = labelEl.parentElement!;
      // Two lines: the label first, the value beneath it, and nothing else.
      expect(fact.children.length).toBe(2);
      expect(fact.children[0]).toBe(labelEl);
      expect(fact.children[1].textContent).toBe(text);
      expect(fact.textContent).toBe(`${label}${text}`);
      // Stacked, not run in one line after a colon.
      expect(fact.className).toMatch(/\bgrid\b/);
      // No box around it: nothing on the card suggests it can be changed.
      for (const el of [fact, ...Array.from(fact.querySelectorAll("*"))]) {
        expect(el.className.toString()).not.toMatch(/(^|\s)border(\s|$|-)/);
        expect(el.tagName).not.toBe("INPUT");
      }
    }
  });

  it("draws the words that go out as a read-only value: the declared label over the text, with no box (V.1)", () => {
    mount(VALUE);
    const labelEl = dom.getByText("The words that go out");
    expectDeclaredLabel(labelEl);
    const value = labelEl.parentElement!;
    expect(value.children.length).toBe(2);
    expect(value.children[1].textContent).toBe("Line one.\nLine two.");
    for (const el of [value, ...Array.from(value.querySelectorAll("*"))]) {
      expect(el.className.toString()).not.toMatch(/(^|\s)border(\s|$|-)/);
    }
  });

  it("draws no frame of its own: the host's frame or detail region holds the fields (V.1)", () => {
    mount(VALUE);
    expect(document.querySelector('[data-slot="card"]')).toBeNull();
    const root = document.querySelector("[data-declared-hitl-screen]")!;
    expect(root.className).not.toMatch(/(^|\s)(border|rounded|bg-|shadow)/);
  });

  it("draws the decision's declared label above its answer rows, in the label style (V.1)", () => {
    mount(VALUE);
    expect(dom.queryByText("Fixture decision")).not.toBeNull();
    const labelEl = dom.getByText("Fixture decision");
    expectDeclaredLabel(labelEl);
    const group = dom.getByRole("radiogroup", { name: "Fixture decision" });
    // The label stands directly above the answer rows.
    expect(labelEl.nextElementSibling).toBe(group);
  });

  it("draws one answer row per declared answer in the card's fields, never footer buttons (design#243 V.1)", () => {
    mount(VALUE);
    expect(document.querySelector('[data-slot="card-footer"]')).toBeNull();
    expect(dom.queryByRole("button", { name: "Do not send" })).toBeNull();
    expect(dom.queryByRole("button", { name: "Send it" })).toBeNull();
    expect(dom.queryByRole("radiogroup", { name: "Fixture decision" })).not.toBeNull();
    const group = dom.getByRole("radiogroup", { name: "Fixture decision" });
    expect(group.closest("[data-declared-hitl-screen]")).not.toBeNull();
    const rows = within(group).getAllByRole("radio");
    expect(rows.map((r) => r.closest("label")?.textContent)).toEqual(["Do not send", "Send it"]);
    // Nothing is chosen for the person.
    expect(rows.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    // Each row is one bordered line holding its radio and the declared label.
    for (const r of rows) {
      const row = r.closest("label")!;
      expect(row.className).toMatch(/\bborder\b/);
      expect(row.className).toMatch(/\brounded-lg\b/);
    }
  });

  it("a decline stages the declared answer with the carried keys only, and sends nothing itself", () => {
    const onChange = mount(VALUE);
    fireEvent.click(dom.getByRole("radio", { name: "Do not send" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(staged({ itemId: "item-1", revisionId: "rev-1", approved: false }));
    const decline = dom.getByRole("radio", { name: "Do not send" });
    expect(decline.getAttribute("aria-checked")).toBe("true");
    // The chosen row is marked as chosen; the other row is not.
    expect(decline.closest("label")!.className).toMatch(/\bborder-primary\b/);
    expect(dom.getByRole("radio", { name: "Send it" }).closest("label")!.className).not.toMatch(/\bborder-primary\b/);
    fireEvent.click(dom.getByRole("radio", { name: "Send it" }));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(staged({ itemId: "item-1", revisionId: "rev-1", approved: true }));
    expect(dom.getByRole("radio", { name: "Send it" }).getAttribute("aria-checked")).toBe("true");
    expect(dom.getByRole("radio", { name: "Do not send" }).getAttribute("aria-checked")).toBe("false");
  });

  it("a card drawn again with a staged choice shows that choice: the chosen row is read from the staged answer", () => {
    // The conversation moves the card (a new instance) while the host keeps
    // its staged answer: the row it will send is the row drawn as chosen.
    const onChange = mount(VALUE, vi.fn(), staged({ itemId: "item-1", revisionId: "rev-1", approved: false }));
    expect(dom.getByRole("radio", { name: "Do not send" }).getAttribute("aria-checked")).toBe("true");
    expect(dom.getByRole("radio", { name: "Send it" }).getAttribute("aria-checked")).toBe("false");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("holds the decisions while a required run value is blank", () => {
    const onChange = mount({ ...VALUE, revisionId: "  " });
    const decline = dom.getByRole("radio", { name: "Do not send" }) as HTMLButtonElement;
    expect(decline.disabled).toBe(true);
    fireEvent.click(decline);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("draws no line for a missing value, and never links a value", () => {
    mount({ ...VALUE, accountName: undefined, sourceUrl: "javascript:alert(1)" });
    expect(dom.queryByText("Account")).toBeNull();
    expect(dom.queryByRole("link")).toBeNull();
    expect(dom.getByText("javascript:alert(1)", { exact: false })).toBeTruthy();
  });

  it("carries own keys only, never an inherited one", () => {
    const value = Object.assign(Object.create({ revisionId: "inherited" }), {
      itemId: "item-1",
    }) as Record<string, unknown>;
    // The declaration omits `requires` (an `undefined` value is not plain JSON).
    const { requires: _requires, ...withoutRequires } = CARD;
    void _requires;
    registerFieldRendererBindings([
      { id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: withoutRequires },
    ]);
    const onChange = mount(value);
    fireEvent.click(dom.getByRole("radio", { name: "Send it" }));
    expect(onChange).toHaveBeenLastCalledWith(staged({ itemId: "item-1", approved: true }));
  });
});

describe("a declared text field (app-lifecycle-cards V.1)", () => {
  it("stages what the person types under the declared key, with the carried keys", () => {
    registerFieldRendererBindings([
      {
        id: ID,
        kind: "linkedin-draft-review",
        priority: 90,
        midRunHitl: true,
        screen: {
          layout: "card",
          title: "Fixture question",
          sections: [{ type: "field", key: "answer", label: "Fixture label", multiline: true, placeholder: "Fixture hint" }],
          carry: ["itemId"],
        },
      },
    ]);
    const onChange = mount({ itemId: "item-1" });
    const box = dom.getByLabelText("Fixture label");
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.getAttribute("placeholder")).toBe("Fixture hint");
    // V.1 `nf-label` over V.1 `nf-input`, on every host.
    expectDeclaredLabel(dom.getByText("Fixture label"));
    expectDeclaredInput(box);
    fireEvent.change(box, { target: { value: "typed" } });
    expect(onChange).toHaveBeenLastCalledWith(staged({ itemId: "item-1", answer: "typed" }));
    expect(dom.queryByRole("button")).toBeNull();
  });

  it("each stage is the whole answer: a second field keeps the first one's text", () => {
    registerFieldRendererBindings([
      {
        id: ID,
        kind: "linkedin-draft-review",
        priority: 90,
        midRunHitl: true,
        screen: {
          layout: "card",
          title: "Fixture question",
          sections: [
            { type: "field", key: "answer", label: "Fixture answer" },
            { type: "field", key: "detail", label: "Fixture detail" },
          ],
          carry: ["itemId"],
        },
      },
    ]);
    const entry = entryOf()!;
    // The entry tells the host to replace its buffer with each stage.
    expect(entry.stagesWholeAnswer).toBe(true);
    const Renderer = entry.renderer;
    const stages: unknown[] = [];
    // A host as the run page, the stepper and the card are: the run value
    // under the buffer, and the buffer replaced by each stage.
    function Host() {
      const [buffer, setBuffer] = useState<Record<string, unknown>>({});
      return (
        <Renderer
          {...({
            fieldName: "field",
            schema: { "x-renderer": ID },
            value: { itemId: "item-1", ...buffer },
            onChange: (next: unknown) => {
              stages.push(next);
              setBuffer(next as Record<string, unknown>);
            },
            context: { connectedApps: [] },
          } as FieldRendererProps)}
        />
      );
    }
    render(<Host />);
    fireEvent.change(dom.getByLabelText("Fixture answer"), { target: { value: "revise this" } });
    fireEvent.change(dom.getByLabelText("Fixture detail"), { target: { value: "Fixture detail" } });
    expect(stages.at(-1)).toEqual(staged({ itemId: "item-1", answer: "revise this", detail: "Fixture detail" }));
  });
});

describe("a declared card holds the host's Continue (cinatra#3470)", () => {
  const FIELD_SCREEN = {
    layout: "card",
    title: "Fixture question",
    sections: [{ type: "field", key: "answer", label: "Fixture label" }],
    carry: ["itemId"],
    requires: ["answer"],
  };

  function ready(runValue: Record<string, unknown>, staged: Record<string, unknown>): boolean | undefined {
    return entryOf()?.continueReady?.({ runValue, staged });
  }

  it("holds the Continue until one of the declared choices is made", () => {
    registerFieldRendererBindings([{ id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: CARD }]);
    expect(entryOf()?.continueReady).toBeTypeOf("function");
    expect(ready(VALUE, {})).toBe(false);
    expect(ready(VALUE, { itemId: "item-1", revisionId: "rev-1" })).toBe(false);
    expect(ready(VALUE, { approved: "false" })).toBe(false);
    expect(ready(VALUE, { itemId: "item-1", revisionId: "rev-1", approved: false })).toBe(true);
    expect(ready(VALUE, { approved: true })).toBe(true);
    // The run value never makes the choice for the person.
    expect(ready({ ...VALUE, approved: true }, {})).toBe(false);
  });

  it("holds the Continue while a required run value is blank, even with a choice made", () => {
    registerFieldRendererBindings([{ id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: CARD }]);
    expect(ready({ ...VALUE, revisionId: " " }, { approved: false })).toBe(false);
  });

  it("holds the Continue until a required field holds text, and the field stays usable", () => {
    registerFieldRendererBindings([{ id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: FIELD_SCREEN }]);
    expect(ready({ itemId: "item-1" }, {})).toBe(false);
    expect(ready({ itemId: "item-1" }, { answer: "   " })).toBe(false);
    expect(ready({ itemId: "item-1" }, { itemId: "item-1", answer: "typed" })).toBe(true);
    // `requires` names the field's own key: the field is NOT disabled by it.
    const onChange = mount({ itemId: "item-1" });
    const box = dom.getByLabelText("Fixture label") as HTMLInputElement;
    expect(box.disabled).toBe(false);
    fireEvent.change(box, { target: { value: "typed" } });
    expect(onChange).toHaveBeenLastCalledWith(staged({ itemId: "item-1", answer: "typed" }));
  });

  it("an untouched prefill holds the Continue until it is staged, and the card stages it once on mount", () => {
    registerFieldRendererBindings([{ id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: FIELD_SCREEN }]);
    // Ready reads what the Continue sends: a prefill nothing has staged is not sent.
    expect(ready({ itemId: "item-1", answer: "prefilled" }, {})).toBe(false);
    const onChange = mount({ itemId: "item-1", answer: "prefilled" });
    expect((dom.getByLabelText("Fixture label") as HTMLInputElement).value).toBe("prefilled");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(staged({ itemId: "item-1", answer: "prefilled" }));
  });

  it("treats every declared field as a required value", () => {
    const { requires: _requires, ...withoutRequires } = FIELD_SCREEN;
    void _requires;
    registerFieldRendererBindings([{ id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: withoutRequires }]);
    expect(ready({}, {})).toBe(false);
    expect(ready({}, { answer: "typed" })).toBe(true);
  });

  it("a card with no controls stages its carried values once on mount, and holds the Continue until it has", () => {
    const TITLE_ONLY = { layout: "card", title: "Fixture title only", carry: ["itemId"] };
    registerFieldRendererBindings([{ id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: TITLE_ONLY }]);
    // Ready reads what the Continue sends: nothing staged would lose itemId.
    expect(ready({ itemId: "item-1" }, {})).toBe(false);
    const onChange = mount({ itemId: "item-1", unrelated: "not carried" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(staged({ itemId: "item-1" }));
    expect(ready({ itemId: "item-1" }, staged({ itemId: "item-1" }))).toBe(true);
  });

  it("only the chosen decision declines: a staged approved: false on a field card is no decline", () => {
    registerFieldRendererBindings([{ id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: FIELD_SCREEN }]);
    expect(continueApprovalFlag({ ...staged({ itemId: "item-1", answer: "typed" }), approved: false }, ID)).toBe(true);
    registerFieldRendererBindings([{ id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: CARD }]);
    expect(continueApprovalFlag(staged({ itemId: "item-1", revisionId: "rev-1", approved: false }), ID)).toBe(false);
    expect(continueApprovalFlag(staged({ itemId: "item-1", revisionId: "rev-1", approved: true }), ID)).toBe(true);
  });

  it("a chosen decision whose answer sets approved to anything but true never continues as an approval", () => {
    // Past the schema (which refuses a non-boolean flag): the submission
    // reads only a literal true as an approval.
    const card = {
      ...CARD,
      decisions: [
        { label: "Fixture text no", answer: { approved: "false", mode: "a" } },
        { label: "Fixture number no", answer: { approved: 0, mode: "b" } },
        { label: "Fixture plain", answer: { mode: "c" } },
      ],
    };
    // red-first-expect: declaredHitlApprovalFlag is not a function
    expect(declaredHitlApprovalFlag(card, { itemId: "item-1", mode: "a", approved: "false" })).toBe(false);
    expect(declaredHitlApprovalFlag(card, { itemId: "item-1", mode: "b", approved: 0 })).toBe(false);
    expect(declaredHitlApprovalFlag(card, { itemId: "item-1", mode: "c" })).toBe(true);
  });

  it("a 'kind' layout whose untouched answer is an answer, and a binding without a screen, never hold the Continue", () => {
    registerFieldRendererBindings([
      { id: ID, kind: "context-selector", priority: 80, midRunHitl: true, screen: { layout: "kind" } },
    ]);
    expect(entryOf()).toBeDefined();
    expect(entryOf()?.continueReady).toBeUndefined();
    registerFieldRendererBindings([{ id: ID, kind: "linkedin-draft-review", priority: 90 }]);
    expect(entryOf()?.continueReady).toBeUndefined();
  });

  // Round 5, finding 3: a declared list step holds the host's Continue until a
  // usable pick exists, as a card holds it until its answer is complete.
  it("a declared list-picker kind holds the Continue until a usable pick exists", () => {
    registerFieldRendererBindings([
      { id: ID, kind: "list-picker", priority: 80, midRunHitl: true, screen: { layout: "kind" } },
    ]);
    expect(continueHeldByRenderer(entryOf(), {}, {}, LOADED_GATE)).toBe(true);
    expect(continueHeldByRenderer(entryOf(), {}, { listId: "  " }, LOADED_GATE)).toBe(true);
    expect(continueHeldByRenderer(entryOf(), {}, { listIds: [""] }, LOADED_GATE)).toBe(true);
    expect(continueHeldByRenderer(entryOf(), {}, { listId: "list-1" }, LOADED_GATE)).toBe(false);
    expect(continueHeldByRenderer(entryOf(), {}, { listIds: ["list-1"] }, LOADED_GATE)).toBe(false);
  });

  // The check of every other kind: a declared 'kind' registers only for a kind
  // with a host component. The list step's untouched answer answers nothing
  // (an empty snapshot), and the recipients and drafts reviews stage their
  // answer only once their rows are shown, so those three hold the Continue.
  // Context selection and the call to action continue on what they draw; the
  // grouped setup form sends from its own control.
  it("of every kind a 'kind' layout can declare, only the list step and the two reviews hold the Continue", () => {
    const holding: string[] = [];
    for (const kind of knownFieldRendererKinds()) {
      fieldRendererRegistry.clear();
      registerFieldRendererBindings([{ id: ID, kind, priority: 80, midRunHitl: true, screen: { layout: "kind" } }]);
      if (entryOf()?.continueReady !== undefined) holding.push(kind);
    }
    // red-first-expect: expected [] to deeply equal [
    expect([...holding].sort()).toEqual(["campaign-recipients-review", "email-drafts-review", "list-picker"]);
  });

  // The grouped setup form sends from its own control, which validates the
  // form first. Every host reads it so from the declared kind alone, with no
  // option of its own: the run panel and the conversation card ask without
  // one, and an outer Continue there would send the approval without the
  // form's values and past its validation.
  it("of every kind a 'kind' layout can declare, only the grouped setup form reads as one on every host", () => {
    const grouped: string[] = [];
    for (const kind of knownFieldRendererKinds()) {
      fieldRendererRegistry.clear();
      registerFieldRendererBindings([{ id: ID, kind, priority: 80, midRunHitl: true, screen: { layout: "kind" } }]);
      if (entryOf() !== undefined && isGroupedSetupRenderer(ID)) grouped.push(kind);
    }
    // red-first-expect: expected [] to deeply equal [ 'wayflow-setup-form' ]
    expect(grouped).toEqual(["wayflow-setup-form"]);
  });

  it("only a 'card' stages its whole answer; a 'kind' and a plain binding stage as their kind does", () => {
    registerFieldRendererBindings([{ id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: CARD }]);
    expect(entryOf()?.stagesWholeAnswer).toBe(true);
    registerFieldRendererBindings([
      { id: ID, kind: "context-selector", priority: 80, midRunHitl: true, screen: { layout: "kind" } },
    ]);
    expect(entryOf()?.stagesWholeAnswer).toBeUndefined();
    registerFieldRendererBindings([{ id: ID, kind: "linkedin-draft-review", priority: 90 }]);
    expect(entryOf()?.stagesWholeAnswer).toBeUndefined();
  });
});

describe("registration validates the declaration again (cinatra#3470)", () => {
  it("a 'kind' layout registers the host's own component for that kind", () => {
    registerFieldRendererBindings([
      { id: ID, kind: "context-selector", priority: 80, midRunHitl: true, screen: { layout: "kind" } },
    ]);
    expect(entryOf()?.renderer).toBe(ContextSelectorRenderer);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("a 'kind' layout on cta registers nothing and says why: its bare-text answer would never be sent", () => {
    registerFieldRendererBindings([
      { id: ID, kind: "cta", priority: 80, midRunHitl: true, screen: { layout: "kind" } },
    ]);
    // red-first-expect: expected { …(8) } to be undefined
    expect(entryOf()).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`declared screen of ${ID} refused: a "kind" screen cannot use kind "cta"`),
    );
  });

  it("a 'kind' layout registers for exactly the shared supported kinds the validator and the server read", async () => {
    // Read by a dynamic import of a named path, so a tree without the module
    // still loads this file and the case fails on its assertion.
    const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/extensions/agent-hitl-screen-schema.mjs");
    const hitlScreenSchema: { KIND_SCREEN_SUPPORTED_KINDS?: readonly string[] } = await import(
      /* @vite-ignore */ schemaPath
    ).catch(() => ({}));
    const supported = [...(hitlScreenSchema.KIND_SCREEN_SUPPORTED_KINDS ?? [])].sort();
    // red-first-expect: expected 0 to be greater than 0
    expect(supported.length).toBeGreaterThan(0);
    const registered: string[] = [];
    for (const kind of knownFieldRendererKinds()) {
      fieldRendererRegistry.clear();
      registerFieldRendererBindings([{ id: ID, kind, priority: 80, midRunHitl: true, screen: { layout: "kind" } }]);
      const entry = entryOf();
      if (entry) {
        expect(entry.renderer).not.toBe(SchemaOnlyFloorRenderer);
        registered.push(kind);
      }
    }
    expect(registered).toEqual(supported);
    expect(registered).not.toContain("linkedin-draft-review");
  });

  it("a 'kind' layout on blog-idea-selection registers nothing: the host keeps no idea chooser of its own (cinatra#4429)", () => {
    registerFieldRendererBindings([
      { id: ID, kind: "blog-idea-selection", priority: 80, midRunHitl: true, screen: { layout: "kind" } },
    ]);
    expect(entryOf()).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`declared screen of ${ID} refused`));
  });

  it("a card that carries or asks for a key the host writes registers nothing: no run value can stage a decline", () => {
    for (const screen of [
      { layout: "card", title: "Fixture question", sections: [{ type: "field", key: "answer", label: "Fixture label" }], carry: ["approved"] },
      { layout: "card", title: "Fixture question", sections: [{ type: "field", key: "approved", label: "Fixture label" }] },
    ]) {
      fieldRendererRegistry.clear();
      registerFieldRendererBindings([{ id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen }]);
      expect(entryOf()).toBeUndefined();
    }
  });

  it("a declared screen on a binding that is not mid-run registers nothing, and says why", () => {
    for (const [kind, screen] of [["linkedin-draft-review", CARD], ["context-selector", { layout: "kind" }]] as const) {
      for (const midRunHitl of [undefined, false]) {
        fieldRendererRegistry.clear();
        errorSpy.mockClear();
        registerFieldRendererBindings([
          { id: ID, kind, priority: 90, ...(midRunHitl === undefined ? {} : { midRunHitl }), screen },
        ]);
        expect(entryOf()).toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("a declared screen is drawn only at a mid-run gate"),
        );
      }
    }
  });

  it("a 'kind' layout whose host entry is only the schema floor registers nothing", () => {
    registerFieldRendererBindings([
      { id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: { layout: "kind" } },
    ]);
    expect(entryOf()).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(ID));
  });

  for (const [title, screen] of [
    ["an unknown layout", { layout: "page" }],
    ["an unknown section type", { ...CARD, sections: [{ type: "html", text: "x" }] }],
    ["a null screen", null],
    ["four decisions", { ...CARD, decisions: [...CARD.decisions, ...CARD.decisions] }],
  ] as const) {
    it(`${title} registers nothing and never falls back to the package component`, () => {
      const load = vi.fn(async () => ({ default: () => null }));
      __setFieldRendererComponentMapForTests({
        [ID]: { resolution: "guardedOptional", packageName: "@acme-test/publish-agent", propsApiVersion: 1, load },
      });
      registerFieldRendererBindings([
        { id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: screen as never },
      ]);
      expect(entryOf()).toBeUndefined();
      expect(load).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`declared screen of ${ID} refused`));
    });
  }

  for (const kind of ["constructor", "toString", "__proto__"]) {
    for (const screen of [CARD, { layout: "kind" }]) {
      it(`an inherited kind name "${kind}" registers nothing (${screen.layout})`, () => {
        registerFieldRendererBindings([{ id: ID, kind, priority: 90, midRunHitl: true, screen }]);
        expect(entryOf()).toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`declared screen of ${ID} refused`));
      });
    }
  }

  it("a per-binding card claims its own exact id only, never the kind's bare alias", () => {
    // A legacy interrupt of ANOTHER agent names only the kind's bare alias. A
    // declared card of that kind must not win it: every host resolves the gate
    // through this registry, and the card would draw that agent's gate.
    registerFieldRendererBindings([
      { id: "@acme-test/legacy-agent:output", kind: "email-drafts-review", priority: 80 },
      { id: ID, kind: "email-drafts-review", priority: 90, midRunHitl: true, screen: CARD },
    ]);
    const resolved = (xRenderer: string) =>
      fieldRendererRegistry.resolve("f", { "x-renderer": xRenderer }, { connectedApps: [] })?.id;
    expect(resolved(ID)).toBe(ID);
    // red-first-expect: expected '@acme-test/publish-agent:confirm' not to be '@acme-test/publish-agent:confirm'
    expect(resolved("email-drafts-review")).not.toBe(ID);
    expect(resolved("email-drafts-review")).toBe("@acme-test/legacy-agent:output");
  });

  it("a binding without a screen keeps its existing kind road", () => {
    registerFieldRendererBindings([{ id: ID, kind: "linkedin-draft-review", priority: 90 }]);
    expect(entryOf()?.renderer).toBe(SchemaOnlyFloorRenderer);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("the conversation hosts draw the declared card (cinatra#3470, V.1)", () => {
  // The renderer id names an installed package's binding: it is NOT in the
  // build-time map, so only the read's declared binding can draw it.
  const RUN_ID = "run-3470-chat";
  const DECLARED = {
    id: ID,
    kind: "linkedin-draft-review",
    priority: 90,
    midRunHitl: true,
    screen: CARD,
  };
  const ASKING = {
    state: "asking" as const,
    runId: RUN_ID,
    screenRef: null,
    gate: {
      reviewTaskId: "task-3470-chat",
      xRenderer: ID,
      inputSchema: { type: "object" },
      currentValues: VALUE,
      fieldName: null,
    },
    declaredScreen: DECLARED,
  };
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    screenStateMock.mockImplementation(async () => ASKING);
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(ASKING), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mountOn(host: LifecycleCardHost) {
    const widget = host === "site_widget";
    return render(
      <LifecycleCardSurfaceProvider
        host={host}
        {...(widget
          ? {
              auth: { headers: () => ({ Authorization: "Bearer cwu_fixture" }), credentials: "omit" as const },
              frame: { assistant: "a", instanceId: "i" },
            }
          : {})}
      >
        <AgentHitlScreenCard runId={RUN_ID} wireRef="task-3470-chat" />
      </LifecycleCardSurfaceProvider>,
    );
  }

  for (const host of ["chat_thread", "site_widget"] as const) {
    it(`${host}: draws the declared card inside the host's card frame, not "no renderer configured"`, async () => {
      expect(entryOf()).toBeUndefined();
      const { container } = mountOn(host);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      await waitFor(() => expect(within(container).queryAllByRole("radio")).toHaveLength(2));
      expect(container.textContent).not.toMatch(/no renderer configured/);
      const frame = container.querySelector('[data-conformance-id="agent-hitl-screen-card"]')!;
      expect(frame.getAttribute("data-lifecycle-card-host")).toBe(host);
      // The host's frame is the one box: the declared card adds none inside it.
      expect(frame.querySelector('[data-slot="card"]')).toBeNull();
      expect(within(container).getByText("Fixture decision")).toBeTruthy();
    });
  }

  it("chat_thread: a card is ready by its own answer alone, whatever its gate schema requires", async () => {
    // The gate schema requires a value the card never stages: only the card's
    // readiness holds its Continue.
    const fieldAsking = {
      ...ASKING,
      gate: {
        ...ASKING.gate,
        inputSchema: {
          type: "object",
          properties: { selectedIdeaJson: { type: "string", "x-required": true } },
        },
      },
      declaredScreen: {
        ...DECLARED,
        screen: {
          layout: "card",
          title: "Fixture schema question",
          sections: [{ type: "field", key: "answer", label: "Fixture answer" }],
          carry: ["itemId"],
        },
      },
    };
    screenStateMock.mockImplementation(async () => fieldAsking);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(fieldAsking), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const { container } = mountOn("chat_thread");
    const input = await waitFor(() => within(container).getByRole("textbox"));
    fireEvent.change(input, { target: { value: "revise this" } });
    const press = within(container).getByRole("button", { name: /^continue$/i }) as HTMLButtonElement;
    await waitFor(() => expect(press.disabled).toBe(false));
    fireEvent.click(press);
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect(hitlActions.approveReviewTask.mock.calls[0]![1]).toMatchObject({
      userResponse: JSON.stringify({ itemId: "item-1", answer: "revise this" }),
    });
    hitlActions.approveReviewTask.mockClear();
  });

  it("the read keeps only the declared binding of its own gate's renderer", () => {
    const kept = parseAgentHitlScreenState(ASKING);
    expect(kept?.state === "asking" && kept.declaredScreen).toEqual(DECLARED);
    const other = parseAgentHitlScreenState({ ...ASKING, declaredScreen: { ...DECLARED, id: "@acme-test/other:confirm" } });
    expect(other?.state === "asking" && other.declaredScreen).toBeUndefined();
  });

  it("the read keeps the binding's params, and refuses params that are not an object", () => {
    const withParams = { ...DECLARED, params: { question: "Fixture question?" } };
    const kept = parseAgentHitlScreenState({ ...ASKING, declaredScreen: withParams });
    expect(kept?.state === "asking" && kept.declaredScreen).toEqual(withParams);
    for (const params of [null, "x", ["x"]]) {
      const refused = parseAgentHitlScreenState({ ...ASKING, declaredScreen: { ...DECLARED, params } });
      expect(refused?.state === "asking" && refused.declaredScreen).toBeUndefined();
    }
  });

  it("a 'kind' list picker registered from the transport answer keeps its declared question", async () => {
    // The site widget reads the gate over the transport (fetch, then the
    // client parse), and the card registers the binding it was handed. The
    // params must survive that road to reach the component.
    const LIST_ID = "@acme-test/list-agent:pick-list";
    const listAsking = {
      ...ASKING,
      gate: { ...ASKING.gate, xRenderer: LIST_ID, currentValues: {} },
      declaredScreen: {
        id: LIST_ID,
        kind: "list-picker",
        priority: 80,
        midRunHitl: true,
        params: { question: "Fixture declared question?" },
        screen: { layout: "kind" },
      },
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(listAsking), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    mountOn("site_widget");
    // The card's own registration of the binding it was handed (under an id
    // scoped to the card, never the binding's id).
    const scopedEntry = () => fieldRendererRegistry.list().find((e) => e.id.startsWith(`${LIST_ID}#card-scope-`));
    await waitFor(() => expect(scopedEntry()).toBeDefined());
    const Picker = scopedEntry()!.renderer;
    cleanup();
    render(
      <Picker
        {...({
          fieldName: "field",
          schema: { "x-renderer": LIST_ID },
          value: {},
          onChange: vi.fn(),
          context: { connectedApps: [] },
          mode: "edit",
        } as FieldRendererProps)}
      />,
    );
    expect(dom.queryByTestId("list-picker-gate-question")?.textContent).toBe("Fixture declared question?");
  });
});

describe("a declared grouped setup form sends only from its own control (cinatra#3470)", () => {
  const RUN_ID = "run-3470-grouped";
  const GROUPED_ID = "@acme-test/setup-agent:details";
  const ASKING = {
    state: "asking" as const,
    runId: RUN_ID,
    screenRef: null,
    gate: {
      reviewTaskId: "task-3470-grouped",
      xRenderer: GROUPED_ID,
      inputSchema: {
        type: "object",
        properties: { projectName: { type: "string", title: "Project name" } },
        required: ["projectName"],
      },
      currentValues: {},
      fieldName: null,
    },
    declaredScreen: {
      id: GROUPED_ID,
      kind: "wayflow-setup-form",
      priority: 80,
      midRunHitl: true,
      screen: { layout: "kind" },
    },
  };
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    screenStateMock.mockImplementation(async () => ASKING);
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(ASKING), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("chat_thread: draws no outer Continue, and an invalid form sends nothing", async () => {
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <AgentHitlScreenCard runId={RUN_ID} wireRef="task-3470-grouped" />
      </LifecycleCardSurfaceProvider>,
    );
    const formSubmit = await waitFor(() => within(container).getByRole("button", { name: /save & start run/i }));
    // red-first-expect: Unable to find role="button" and name
    expect(within(container).queryByRole("button", { name: /^continue$/i })).toBeNull();
    // The required value is blank: the form's own control validates and sends nothing.
    await act(async () => {
      fireEvent.click(formSubmit);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    // Filled in, the same control sends the form's values with the approval.
    fireEvent.change(within(container).getByRole("textbox"), { target: { value: "Fixture project" } });
    await act(async () => {
      fireEvent.click(formSubmit);
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect(hitlActions.approveReviewTask.mock.calls[0]![1]).toMatchObject({
      projectName: "Fixture project",
      approved: true,
    });
    // The values reach the step as its answer: the one field the server resumes from.
    const sent = hitlActions.approveReviewTask.mock.calls[0]![1] as { userResponse?: unknown };
    expect(typeof sent.userResponse).toBe("string");
    expect(JSON.parse(sent.userResponse as string)).toEqual({ projectName: "Fixture project" });
  });
});

describe("each conversation card draws the declared screen it was handed (cinatra#3470)", () => {
  // Two open gates of the same binding id across a package revision: the
  // earlier gate's read handed over the earlier declaration, the later one
  // the later.
  const EARLIER = {
    layout: "card",
    title: "Fixture earlier revision",
    decisionLabel: "Fixture earlier decision",
    decisions: [
      { label: "Fixture earlier hold", answer: { approved: false } },
      { label: "Fixture earlier send", answer: { approved: true } },
    ],
    carry: ["itemId"],
  };
  const LATER = {
    layout: "card",
    title: "Fixture later revision",
    decisionLabel: "Fixture later decision",
    decisions: [{ label: "Fixture later send", answer: { approved: true, route: "later" } }],
    carry: ["revisionId"],
  };
  function askingFor(runId: string, reviewTaskId: string, screen: unknown) {
    return {
      state: "asking" as const,
      runId,
      screenRef: null,
      gate: { reviewTaskId, xRenderer: ID, inputSchema: { type: "object" }, currentValues: VALUE, fieldName: null },
      declaredScreen: { id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen },
    };
  }

  beforeEach(() => {
    screenStateMock.mockImplementation(async (input: { runId: string }) =>
      input.runId === "run-earlier"
        ? askingFor("run-earlier", "task-earlier", EARLIER)
        : askingFor("run-later", "task-later", LATER),
    );
    hitlActions.approveReviewTask.mockClear();
  });

  // Two cards of one id across a package revision, read through the
  // production lookup, are pinned in declared-screen-pin-3470.test.tsx.

  it("a card's declaration never replaces a binding registered under the same id by another source", async () => {
    // The run page registered the installed agent's current binding.
    registerFieldRendererBindings([{ id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: LATER }]);
    const pageEntry = entryOf();
    // red-first-expect: expected undefined to match object { title: 'Fixture later revision' }
    expect(pageEntry?.declaredScreen).toMatchObject({ title: "Fixture later revision" });
    const view = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <AgentHitlScreenCard runId="run-earlier" wireRef="task-earlier" />
      </LifecycleCardSurfaceProvider>,
    );
    await waitFor(() => expect(dom.queryAllByRole("radio").length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(entryOf()).toBe(pageEntry);
    expect(dom.getByText("Fixture earlier decision")).toBeTruthy();
    view.unmount();
    expect(entryOf()).toBe(pageEntry);
  });
});

describe("a card's own registration never takes a manifest binding's id (cinatra#3470)", () => {
  const scoped = registerModule as unknown as {
    registerScopedDeclaredScreen?: (binding: unknown) => FieldRendererEntry | null;
  };
  const BINDING = { id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: CARD };
  /** Open a card on BINDING: its scoped entry, or null. */
  const openCard = () => scoped.registerScopedDeclaredScreen?.(BINDING) ?? null;
  /** The number the next card takes after `entry`'s. */
  const nextNumber = (entry: FieldRendererEntry) => Number(/([0-9]+)$/.exec(entry.id)?.[1]) + 1;

  it("a card-scoped id is in a form the manifest id grammar refuses", async () => {
    const card = openCard();
    // red-first-expect: expected null not to be null
    expect(card).not.toBeNull();
    fieldRendererRegistry.unregisterEntry(card!);
    const kindsPath = join(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/extensions/agent-binding-kinds.mjs");
    const kinds: { BINDING_ID_RE?: RegExp } = await import(/* @vite-ignore */ kindsPath);
    expect(kinds.BINDING_ID_RE?.test(ID)).toBe(true);
    expect(kinds.BINDING_ID_RE?.test(card!.id)).toBe(false);
    expect(RENDERER_NAMESPACE_RE.test(card!.id)).toBe(false);
  });

  it("a manifest binding whose id looks like the old scoped form survives a card opening and closing", () => {
    const probe = openCard();
    // red-first-expect: expected null not to be null
    expect(probe).not.toBeNull();
    fieldRendererRegistry.unregisterEntry(probe!);
    const lookalike = `${ID}--card-scope-${nextNumber(probe!)}`;
    registerFieldRendererBindings([{ ...BINDING, id: lookalike }]);
    const manifestEntry = entryOf(lookalike);
    expect(manifestEntry).toBeDefined();
    const card = openCard();
    expect(card).not.toBeNull();
    expect(entryOf(lookalike)).toBe(manifestEntry);
    fieldRendererRegistry.unregisterEntry(card!);
    expect(entryOf(lookalike)).toBe(manifestEntry);
    expect(entryOf(card!.id)).toBeUndefined();
  });

  it("a card-scoped id already held by an entry is refused, never replaced, and closing removes nothing", () => {
    const probe = openCard();
    // red-first-expect: expected null not to be null
    expect(probe).not.toBeNull();
    fieldRendererRegistry.unregisterEntry(probe!);
    const held = { ...probe!, id: probe!.id.replace(/[0-9]+$/, String(nextNumber(probe!))) };
    fieldRendererRegistry.register(held);
    expect(openCard()).toBeNull();
    expect(entryOf(held.id)).toBe(held);
  });
});
