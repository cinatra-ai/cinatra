// @vitest-environment jsdom
//
// §I INPUT HIERARCHY — the HITL card's fields, per host (cinatra#2930, W3).
//
// The ratified drawing at the contract's pin, §I, "The rule, wherever a card
// meets a chat box", verbatim:
//
//   "Exactly one primary input is drawn per conversation, and it is the chat
//    box. Any field a card carries is drawn subordinate to it. Where there is
//    no chat box to be subordinate to — the run page and the review page — the
//    card's field is the only input there is and takes the primary treatment
//    instead. The hierarchy is between the two inputs, not a fixed look for
//    either one."
//
// and the two treatments it names:
//
//   subordinate — "No box of its own, no fill, no send. A ruled baseline under
//                  a mono label — it reads as a field on the card, not as
//                  somewhere to start typing."
//   primary     — "Its own box on the raised ground, the line-strong edge and
//                  the send affordance."
//
// WHAT IS PINNED HERE. The card mounts arbitrary field renderers, so the
// treatment cannot ride on any one of them: it is declared ONCE, on the fields
// region every renderer is drawn inside, and it is keyed by the HOST. A
// conversation host draws the field subordinate; the run page and the review
// page keep the primary treatment they already have.
//
// THE CARD'S OWN CONTINUE IS NOT AN INPUT. It is the card's control and it
// stays on every host — what §I moves is the weight of the FIELD. It is drawn
// OUTSIDE the fields region, which is what makes "no send affordance" a
// measurable fact about the region rather than a claim about the card.
//
// AND "NO SEND" IS THE THIRD GIVE-UP, not an exemption for whoever drew the
// button. The graded pictures caught a SETUP gate in a conversation drawing the
// renderer's own filled Continue INSIDE the fields region while the card's own
// measured zero — a send affordance inside the subordinate field, which is the
// second primary input §I exists to forbid. So on a conversation host the send
// is the CARD'S: the card draws its own Continue for a setup gate too, outside
// the region, and the renderer's own submit is not drawn inside it. The run
// page and the review page keep the primary treatment and the renderer's own
// button exactly as they were.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { LifecycleCardHost } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const screenStateMock = vi.fn();
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: async () => ({ connectedApps: [] }),
}));
vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";
import { Textarea } from "@/components/ui/textarea";
import { SchemaOnlyFloorRenderer } from "../schema-field-renderer";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import { approveReviewTask } from "../hitl-actions";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const GLOBAL_STYLESHEET = join(REPO_ROOT, "src", "app", "globals.css");

const RUN_ID = "run-2930";
const FIELDS_REGION = '[data-conformance-id="hitl-screen-fields"]';
const CONTINUE = '[data-action="submit-hitl-screen"]';

/** A MID-RUN gate — the shape that draws the card's own Continue. */
const ASKING = {
  state: "asking" as const,
  runId: RUN_ID,
  screenRef: "hitl-screen-ref-2930",
  gate: {
    reviewTaskId: "task-2930",
    xRenderer: "cinatra.schema-field:output",
    inputSchema: { type: "object", properties: { idea: { type: "string" } } },
    currentValues: {},
    fieldName: undefined,
  },
};

/** A SETUP-LOOP gate on the shipped fallback — the exact pairing the graded
 *  pictures caught: the `idea` field, drawn by the component this slice does not
 *  own, inside the card's fields region. */
const SHIPPED_GATE = {
  state: "asking" as const,
  runId: RUN_ID,
  screenRef: null,
  gate: {
    reviewTaskId: "setup-run-2930",
    xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
    inputSchema: { type: "string", title: "Idea" },
    currentValues: {},
    fieldName: "idea",
  },
};

/** The two hosts a chat box sits under, and the two with none. */
const SUBORDINATE_HOSTS: LifecycleCardHost[] = ["chat_thread", "site_widget"];
const PRIMARY_HOSTS: LifecycleCardHost[] = ["run_card", "page_gate_region"];

/**
 * A renderer shaped like the one the graded pictures caught — a labelled text
 * field that draws its own box. It is registered as `credentialSafe` so the
 * widget arm measures the TREATMENT rather than the containment rule, which is
 * pinned in the card's own suite.
 */
function registerFieldFixture(): void {
  fieldRendererRegistry.clear();
  fieldRendererRegistry.register({
    id: "@cinatra-ai/test:boxed-field",
    priority: 90,
    condition: (_f, _s, ctx) => ctx.xRenderer === ASKING.gate.xRenderer,
    renderer: () => (
      <div className="flex flex-col gap-2">
        {/* BESIDE its control, which is how every shipped schema-fallback
            branch draws it (`schema-field-renderer.tsx`) — a label that wraps
            its own field is deliberately left alone by the scope, because the
            mono treatment would inherit into the field it wraps. */}
        <label htmlFor="field-idea">Idea (optional)</label>
        <Textarea
          id="field-idea"
          className="rounded-control border border-line bg-surface-strong"
        />
      </div>
    ),
    credentialSafe: true,
  });
}

const WIDGET_AUTH = {
  headers: () => ({ Authorization: "Bearer cwu_site" }),
  credentials: "omit" as const,
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  registerFieldFixture();
  screenStateMock.mockImplementation(async () => ASKING);
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(ASKING), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
});

afterEach(() => {
  fieldRendererRegistry.clear();
  globalThis.fetch = originalFetch;
  cleanup();
  vi.clearAllMocks();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });
}

function mountOn(host: LifecycleCardHost) {
  const auth = host === "site_widget" ? WIDGET_AUTH : undefined;
  const frame = host === "site_widget" ? { assistant: "a", instanceId: "i" } : undefined;
  return render(
    <LifecycleCardSurfaceProvider host={host} auth={auth} frame={frame}>
      <AgentHitlScreenCard runId={RUN_ID} wireRef="task-2930" />
    </LifecycleCardSurfaceProvider>,
  );
}

async function fieldsRegionOn(host: LifecycleCardHost): Promise<HTMLElement> {
  const mounted = mountOn(host);
  await settle();
  return waitFor(() => {
    const found = mounted.container.querySelector<HTMLElement>(FIELDS_REGION);
    if (!found) throw new Error(`no fields region on ${host}`);
    return found;
  });
}

const classesOf = (el: Element) => el.className.split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------------------
// 1. A CONVERSATION HOST — the field is subordinate to the chat box
// ---------------------------------------------------------------------------

describe("§I — inside a conversation the card's fields are subordinate", () => {
  it.each(SUBORDINATE_HOSTS)("%s: the region says which side of the rule it is on", async (host) => {
    const region = await fieldsRegionOn(host);
    expect(region.getAttribute("data-field-presentation")).toBe("subordinate");
  });

  it.each(SUBORDINATE_HOSTS)("%s: no box of its own and no fill", async (host) => {
    const region = await fieldsRegionOn(host);
    const classes = classesOf(region);
    // The three the drawing takes away, as they are spelled on this region:
    // the panel border, the panel radius and the ground.
    expect(classes, "the region's own box").not.toContain("soft-panel");
    expect(classes, "the region's own radius").not.toContain("rounded-panel");
    expect(classes, "the region's own fill").not.toContain("bg-surface-muted");
    // …and the scope that carries the ruled baseline down to every field the
    // card can mount, whatever renderer drew it.
    expect(classes, "the §I subordinate scope").toContain("lifecycle-fields-subordinate");
  });

  it.each(SUBORDINATE_HOSTS)("%s: the card adds no send affordance to the region", async (host) => {
    const region = await fieldsRegionOn(host);
    // §I's third give-up, measured as a fact about the REGION'S OWN chrome, the
    // same scoping proof the review card's note field is held to: the card puts
    // nothing to press inside the region, and its Continue — the card's control
    // rather than an input — is drawn outside it.
    expect(region.querySelector("button"), "a send affordance the CARD drew").toBeNull();
    expect(region.querySelector(CONTINUE), "the Continue is not in the region").toBeNull();
  });

  it.each(SUBORDINATE_HOSTS)("%s: the card's own Continue still stands, outside it", async (host) => {
    const mounted = mountOn(host);
    await settle();
    const card = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLElement>(
        '[data-lifecycle-card="agent_hitl_screen"]',
      );
      if (!found) throw new Error(`no card on ${host}`);
      return found;
    });
    expect(card.querySelectorAll(CONTINUE), "the card's control").toHaveLength(1);
    expect(card.querySelectorAll(FIELDS_REGION), "one fields region").toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. A PAGE HOST — there is no chat box, so the field IS the primary input
// ---------------------------------------------------------------------------

describe("§I — with no chat box to be subordinate to, the field takes the primary treatment", () => {
  it.each(PRIMARY_HOSTS)("%s: the region says primary and keeps its box, ground and inset", async (host) => {
    const region = await fieldsRegionOn(host);
    expect(region.getAttribute("data-field-presentation")).toBe("primary");
    const classes = classesOf(region);
    expect(classes, "its own box").toContain("soft-panel");
    expect(classes, "its own radius").toContain("rounded-panel");
    expect(classes, "the ground").toContain("bg-surface-muted");
    expect(classes, "the subordinate scope must NOT reach a page host").not.toContain(
      "lifecycle-fields-subordinate",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. THE SCOPE ITSELF — the ruled baseline under a mono label
// ---------------------------------------------------------------------------
//
// The class the region carries is what reaches a renderer this repository has
// never read, so what it DECLARES is part of the contract and is read off the
// stylesheet rather than assumed.

describe("§I — the subordinate scope declares the drawing's own treatment", () => {
  const stylesheet = () => readFileSync(GLOBAL_STYLESHEET, "utf8");

  function scopeBlocks(): string {
    const css = stylesheet();
    const blocks = css
      .split("}")
      .filter((b) => b.includes(".lifecycle-fields-subordinate"))
      .join("}\n");
    expect(blocks.length, "the .lifecycle-fields-subordinate scope").toBeGreaterThan(0);
    return blocks;
  }

  it("takes the box, the fill and the radius off every field inside it", () => {
    const blocks = scopeBlocks();
    expect(blocks).toMatch(/border:\s*0/);
    expect(blocks).toMatch(/background:\s*transparent/);
    expect(blocks).toMatch(/border-radius:\s*0/);
  });

  it("keeps the one ruled baseline the drawing names", () => {
    // `.notefield .nf-input { border: 0; border-bottom: 1px dashed var(--line); … }`
    expect(scopeBlocks()).toMatch(/border-bottom:\s*1px dashed var\(--line\)/);
  });

  it("draws the label in the mono treatment", () => {
    const blocks = scopeBlocks();
    expect(blocks).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(blocks).toMatch(/text-transform:\s*uppercase/);
  });

  it("and that rule REACHES the label the renderer actually drew", async () => {
    const region = await fieldsRegionOn("chat_thread");
    const label = region.querySelector("label");
    expect(label, "the renderer's own label").not.toBeNull();
    // The shipped fallback draws the label BESIDE its control, which is the
    // case the rule is written for — a label that WRAPS its field is excluded
    // on purpose, so this is the mounted proof rather than a stylesheet grep.
    expect(
      label!.querySelector("input, textarea, select"),
      "a label wrapping its own control is excluded by the rule",
    ).toBeNull();
    expect(
      label!.matches("label:not(:has(input)):not(:has(textarea)):not(:has(select))"),
    ).toBe(true);
  });

  it("leaves the controls a reader does not type into alone", () => {
    // A checkbox, a radio, a file picker, a range and a button-typed input take
    // none of the treatment — not the baseline, not the focus rule and not the
    // disabled ground.
    for (const type of ["checkbox", "radio", "range", "file", "submit", "button"]) {
      const guarded = scopeBlocks()
        .split("\n")
        .filter((line) => line.includes("input:not("))
        .every((line) => line.includes(`[type="${type}"]`));
      expect(guarded, `every input rule excludes ${type}`).toBe(true);
    }
    // …and the focus rule still leaves a visible mark rather than only removing
    // one, which is what makes "nothing is hidden" true of the keyboard too.
    expect(scopeBlocks()).toMatch(/border-bottom-style:\s*solid/);
  });

  it("treats an input group as ONE field, never as a box with a ruled field inside it", () => {
    const blocks = scopeBlocks();
    // The wrapper takes the treatment — it is what owns the box and the ground…
    expect(blocks).toMatch(/\.lifecycle-fields-subordinate \[data-slot="input-group"\]/);
    // …and every control arm excludes the control the wrapper holds, or the
    // group and its own field would each draw a baseline.
    const arms = blocks
      .split("\n")
      .filter((line) => /\b(input|textarea|select):?/.test(line) && line.includes(".lifecycle-fields-subordinate"))
      .filter((line) => !line.includes('[data-slot="input-group"]'))
      .filter((line) => /(^|\s)\.lifecycle-fields-subordinate (input|textarea|select)/.test(line));
    expect(arms.length, "the control arms").toBeGreaterThan(0);
    for (const arm of arms) {
      expect(arm, "excludes the group's own control").toContain('[data-slot="input-group-control"]');
    }
  });

  it("invents no colour — every colour it names is a token the repository already has", () => {
    const blocks = scopeBlocks();
    const literals = blocks.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\boklch\(|\bhsla?\(/g) ?? [];
    expect(literals, "a hard-coded colour in the §I scope").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. THE SHIPPED RENDERER, MOUNTED
// ---------------------------------------------------------------------------
//
// The arms above measure the card's own chrome through a fixture. This one
// mounts the SHIPPED fallback — the component the graded pictures caught, the
// same entry `register-default-renderers.ts` registers for
// `schema-field-fallback` — so the scope is proven against a renderer this
// slice does not own.

describe("§I — the shipped fallback renderer, drawn inside the region", () => {
  function registerShippedFallback(): void {
    fieldRendererRegistry.clear();
    fieldRendererRegistry.register({
      id: SCHEMA_FIELD_FALLBACK_RENDERER_ID,
      priority: 1,
      condition: (_f, _s, ctx) => ctx.xRenderer === SHIPPED_GATE.gate.xRenderer,
      renderer: SchemaOnlyFloorRenderer,
      credentialSafe: true,
    });
  }

  it("draws the field inside the scope, so the treatment reaches it", async () => {
    registerShippedFallback();
    screenStateMock.mockImplementation(async () => SHIPPED_GATE);
    const region = await fieldsRegionOn("chat_thread");
    expect(region.className).toContain("lifecycle-fields-subordinate");
    const field = region.querySelector("textarea, input, [data-slot='input-group']");
    expect(field, "the shipped renderer's own field").not.toBeNull();
    // The rule reaches it because it is INSIDE the scope — asserted on the
    // mounted element against the stylesheet's own selector, not inferred.
    expect(
      field!.closest(".lifecycle-fields-subordinate"),
      "the field is inside the scope",
    ).toBe(region);
  });

  it("draws NO send inside the region on a conversation host — §I's third give-up", async () => {
    registerShippedFallback();
    screenStateMock.mockImplementation(async () => SHIPPED_GATE);
    const region = await fieldsRegionOn("chat_thread");
    // THE DEFECT THE GRADED PICTURES MEASURED, now the rule. The shipped
    // fallback draws its own Continue; inside a conversation that button is a
    // send affordance inside the subordinate field, and §I's own example draws
    // that field with no button at all. The card carries the rule to the
    // renderer through the SHARED props contract, so it reaches a renderer this
    // slice does not own.
    expect([...region.querySelectorAll("button")], "any send inside the field").toHaveLength(0);
    // …and the region says so on the DOM, which is what the stylesheet's own
    // containment backstop hangs on and what a picture is graded against.
    expect(region.getAttribute("data-send-affordance")).toBe("card");
  });

  it("puts the card's OWN Continue in its place, outside the region", async () => {
    registerShippedFallback();
    screenStateMock.mockImplementation(async () => SHIPPED_GATE);
    const mounted = mountOn("chat_thread");
    await settle();
    const card = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLElement>(
        '[data-lifecycle-card="agent_hitl_screen"]',
      );
      if (!found) throw new Error("no card");
      return found;
    });
    // The send MOVES rather than disappearing — taking it away without putting
    // the card's control in its place is the regression `agentic-run-panel.tsx`
    // records from the last time a surface hid it.
    expect(card.querySelectorAll(CONTINUE), "the card's own control").toHaveLength(1);
    const region = card.querySelector<HTMLElement>(FIELDS_REGION)!;
    expect(region.querySelectorAll(CONTINUE), "and NOT inside the field").toHaveLength(0);
  });

  it("run_card keeps the renderer's own Continue, and the card draws none", async () => {
    registerShippedFallback();
    screenStateMock.mockImplementation(async () => SHIPPED_GATE);
    const mounted = mountOn("run_card");
    await settle();
    const card = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLElement>(
        '[data-lifecycle-card="agent_hitl_screen"]',
      );
      if (!found) throw new Error("no card");
      return found;
    });
    const region = card.querySelector<HTMLElement>(FIELDS_REGION)!;
    // WHERE THERE IS NO CHAT BOX the field is the primary input and its own
    // control is the only way forward. Nothing here moves.
    const buttons = [...region.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent), "the renderer's own control").toContain("Continue");
    expect(region.getAttribute("data-send-affordance"), "not declared on a page host").toBeNull();
    expect(card.querySelectorAll(CONTINUE), "the card adds none").toHaveLength(0);
  });

  it("the card's Continue submits EXACTLY what the renderer's button submitted", async () => {
    registerShippedFallback();
    screenStateMock.mockImplementation(async () => SHIPPED_GATE);
    const mounted = mountOn("chat_thread");
    await settle();
    const card = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLElement>(
        '[data-lifecycle-card="agent_hitl_screen"]',
      );
      if (!found) throw new Error("no card");
      return found;
    });
    const field = card.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `${FIELDS_REGION} textarea, ${FIELDS_REGION} input`,
    )!;
    expect(field, "the shipped renderer's own field").not.toBeNull();
    await act(async () => {
      fireEvent.change(field, { target: { value: "How small teams keep research organised" } });
    });
    const continueButton = card.querySelector<HTMLButtonElement>(CONTINUE)!;
    await act(async () => {
      fireEvent.click(continueButton);
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    // THE SAME CORE, THE SAME ARGUMENTS. A setup-loop answer is the value
    // wrapped under the gate's OWN field name and handed to the shipped
    // review-task approval — which is exactly what the renderer's own button
    // produced before this control existed. There is no second submit path.
    expect(approveReviewTask).toHaveBeenCalledTimes(1);
    expect(approveReviewTask).toHaveBeenCalledWith(
      "setup-run-2930",
      { idea: "How small teams keep research organised" },
      "idea",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. THE MID-RUN GATE IS UNCHANGED
// ---------------------------------------------------------------------------

describe("§I — the mid-run gate keeps the shape it already had", () => {
  it.each(SUBORDINATE_HOSTS)(
    "%s: the card's own Continue, outside a region that holds no send",
    async (host) => {
      const mounted = mountOn(host);
      await settle();
      const card = await waitFor(() => {
        const found = mounted.container.querySelector<HTMLElement>(
          '[data-lifecycle-card="agent_hitl_screen"]',
        );
        if (!found) throw new Error(`no card on ${host}`);
        return found;
      });
      expect(card.querySelectorAll(CONTINUE), "the card's control").toHaveLength(1);
      const region = card.querySelector<HTMLElement>(FIELDS_REGION)!;
      expect(region.querySelectorAll("button"), "no send in the field").toHaveLength(0);
    },
  );

  it.each(PRIMARY_HOSTS)("%s: the card's own Continue, and no declaration", async (host) => {
    const mounted = mountOn(host);
    await settle();
    const card = await waitFor(() => {
      const found = mounted.container.querySelector<HTMLElement>(
        '[data-lifecycle-card="agent_hitl_screen"]',
      );
      if (!found) throw new Error(`no card on ${host}`);
      return found;
    });
    expect(card.querySelectorAll(CONTINUE), "the card's control").toHaveLength(1);
    const region = card.querySelector<HTMLElement>(FIELDS_REGION)!;
    expect(region.getAttribute("data-send-affordance")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. THE STYLESHEET'S CONTAINMENT BACKSTOP
// ---------------------------------------------------------------------------

describe("§I — the scope hides a send a renderer drew anyway, and only where the card owns it", () => {
  const blocks = () =>
    readFileSync(GLOBAL_STYLESHEET, "utf8")
      .split("}")
      .filter((b) => b.includes(".lifecycle-fields-subordinate"))
      .join("}\n");

  it("hides a submit-typed control, and hangs the rule on the card's own declaration", () => {
    const rule = blocks()
      .split("\n")
      .filter((line) => line.includes('[data-send-affordance="card"]'));
    expect(rule.length, "the backstop").toBeGreaterThan(0);
    for (const line of rule) {
      expect(line, "scoped to the subordinate region").toContain(".lifecycle-fields-subordinate");
      expect(line, "and to the card's own declaration").toContain(
        '[data-send-affordance="card"]',
      );
      expect(line, "an unambiguous send only").toMatch(/\[type="submit"\]/);
    }
  });
});
