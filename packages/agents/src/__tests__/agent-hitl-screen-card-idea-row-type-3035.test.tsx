// @vitest-environment jsdom
/**
 * cinatra#3035 - THE IDEA ROWS KEEP THEIR OWN TYPE ON THE CONVERSATION CARD.
 *
 * The approved drawing (`specs/app-artifact-review.html` I.1) gives every idea
 * row the same face on every host: a sentence-case sans title over the entry's
 * own muted detail line. Only the frame around the card differs between hosts.
 *
 * On a conversation host the card wraps its fields in the subordinate scope
 * (`.lifecycle-fields-subordinate`, src/app/globals.css). That scope draws a
 * field's label in the mono, uppercase, letter-spaced treatment, and it leaves
 * alone a label that WRAPS its own control. The chooser draws each row as a
 * label that wraps its radio, but the radio is a `role="radio"` button, not an
 * `<input>`, so the rule's input-only exclusion missed it: the row title and
 * the detail line inherited the eyebrow type.
 *
 * The rule's selector is read from the stylesheet, not copied, so this test
 * follows the rule as it is shipped. A field label drawn BESIDE its control
 * must still take the treatment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import type { LifecycleCardHost } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const screenStateMock = vi.fn();
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: async () => ({
    connectedApps: [],
    gmailAliases: [],
  }),
}));
vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true as const })),
  rejectReviewTask: vi.fn(async () => undefined),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { fieldRendererRegistry } from "../field-renderer-registry";
import {
  ensureDefaultFieldRenderersRegistered,
  registerFieldRendererBindings,
} from "../register-default-renderers";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const GLOBAL_STYLESHEET = join(REPO_ROOT, "src", "app", "globals.css");

const RUN_ID = "run-3035-row-type";
const IDEA_RENDERER_ID = "@cinatra-test/idea-kind-3035:row-type";
const FIELDS_REGION = '[data-conformance-id="hitl-screen-fields"]';
const IDEAS = [
  { title: "Row type idea one", summary: "The first detail line" },
  { title: "Row type idea two", summary: "The second detail line" },
];

const asking = {
  state: "asking" as const,
  runId: RUN_ID,
  screenRef: "hitl-screen-ref-row-type",
  gate: {
    reviewTaskId: "task-3035-row-type",
    xRenderer: IDEA_RENDERER_ID,
    inputSchema: {
      type: "object",
      properties: { selectedIdeaJson: { type: "string" } },
    },
    currentValues: { ideas: IDEAS },
    fieldName: undefined,
  },
};

/**
 * The selector of the subordinate scope's label rule: the one rule in the
 * stylesheet that sets the mono face on a label inside the scope.
 */
function subordinateLabelSelector(): string {
  const css = readFileSync(GLOBAL_STYLESHEET, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = css
    .split("}")
    .map((chunk) => chunk.split("{"))
    .filter(([selector, body]) =>
      selector !== undefined &&
      body !== undefined &&
      selector.includes(".lifecycle-fields-subordinate") &&
      /\blabel\b/.test(selector) &&
      /font-family:\s*var\(--font-mono\)/.test(body),
    )
    .map(([selector]) => selector!.replace(/\s+/g, " ").trim());
  expect(rules, "exactly one subordinate label rule").toHaveLength(1);
  return rules[0]!;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
  registerFieldRendererBindings([
    { id: IDEA_RENDERER_ID, kind: "blog-idea-selection", priority: 80, midRunHitl: true },
  ]);
  screenStateMock.mockImplementation(async () => asking);
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(asking), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
  vi.clearAllMocks();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));
    await Promise.resolve();
  });
}

function card(host: LifecycleCardHost) {
  return (
    <LifecycleCardSurfaceProvider host={host}>
      <AgentHitlScreenCard runId={RUN_ID} wireRef="task-3035-row-type" />
    </LifecycleCardSurfaceProvider>
  );
}

function textElement(container: HTMLElement, text: string): HTMLElement {
  const hit = Array.from(container.querySelectorAll<HTMLElement>("span")).find(
    (el) => el.textContent === text && el.children.length === 0,
  );
  expect(hit, `the element that draws "${text}"`).toBeDefined();
  return hit!;
}

describe("AgentHitlScreenCard - the idea rows keep their own type on the conversation card (cinatra#3035)", () => {
  it("chat_thread: the subordinate label rule reaches neither a row title nor its detail line", async () => {
    const selector = subordinateLabelSelector();
    const mounted = render(card("chat_thread"));
    await settle();
    await waitFor(() =>
      expect(mounted.container.querySelectorAll('[role="radio"]')).toHaveLength(2),
    );
    const region = mounted.container.querySelector<HTMLElement>(FIELDS_REGION);
    expect(region, "the card's fields region").not.toBeNull();
    // The premise: on this host the region carries the scope the rule targets.
    expect(region!.classList.contains("lifecycle-fields-subordinate")).toBe(true);

    for (const idea of IDEAS) {
      const title = textElement(mounted.container, idea.title);
      const detail = textElement(mounted.container, idea.summary);
      // The chooser's own type, as the run page draws it.
      expect(title.className).toContain("font-medium");
      expect(detail.className).toContain("text-muted-foreground");
      // No element from the row up to the region matches the rule, so nothing
      // in the row inherits the mono, uppercase, letter-spaced treatment.
      expect(title.closest(selector), `${idea.title}: no ancestor takes the label rule`).toBeNull();
      expect(detail.closest(selector), `${idea.summary}: no ancestor takes the label rule`).toBeNull();
    }
  });

  it("the rule still reaches a field label drawn beside its control", () => {
    const selector = subordinateLabelSelector();
    document.body.innerHTML =
      '<div class="lifecycle-fields-subordinate">' +
      '<label for="note-3035">Note</label><input id="note-3035" type="text" />' +
      "</div>";
    const label = document.body.querySelector("label")!;
    expect(label.matches(selector)).toBe(true);
    document.body.innerHTML = "";
  });
});
