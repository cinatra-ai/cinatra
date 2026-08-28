// @vitest-environment jsdom
/**
 * WHERE EACH WINDOW STANDS (cinatra#2934, lifecycle-b W5c).
 *
 * The graded picture leg measured the review page's window OVER the review
 * card's decision bar: the bar 664–794 px, the window's panel 588–822 px, 130 px
 * of vertical overlap — the whole of the bar — and `elementFromPoint` at the
 * bar's centre landing inside the panel. The drawing at the contract's pin says
 * the opposite in so many words: the window sits BENEATH the decision bar, drawn
 * as two separately stacked examples.
 *
 * This is that rule, as a test. jsdom has no layout engine, so it does not
 * measure pixels — it asserts the two facts that MAKE the pixels, and either one
 * failing is what produced the overlap:
 *
 *   1. the window comes AFTER the card in document order, and
 *   2. the window is IN FLOW — no `sticky`/`fixed`/`absolute`, no `bottom`,
 *      no stacking context.
 *
 * Two static boxes in that order cannot overlap at any width. The pixels
 * themselves are measured on the running page and filed with the evidence.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

/** What the shared panel handed the field, captured at the mount. */
const promptField = vi.hoisted(() => ({
  submitAriaLabel: null as string | null,
  placeholder: null as string | null,
}));

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  // The real PromptField pulls browser-only deps jsdom cannot load. The stub
  // records the two things this suite is about — the sentence and the send
  // control's accessible name. A <div>, not a raw <input>: the design-system
  // lint gate forbids the bare element in favour of the shadcn <Input>.
  PromptField: ({
    placeholder,
    submitAriaLabel,
  }: {
    placeholder?: string;
    submitAriaLabel?: string;
  }) => {
    promptField.placeholder = placeholder ?? null;
    promptField.submitAriaLabel = submitAriaLabel ?? null;
    return <div data-testid="run-window-prompt">{placeholder}</div>;
  },
}));

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
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

import {
  HitlConversationPanel,
  RUN_WINDOW_PLACEMENTS,
  RUN_WINDOW_PLACEHOLDERS,
  runWindowSendLabel,
} from "../hitl-conversation-panel";
import type { RunWindowSurface } from "../run-window-conversation-store";

const SURFACES: RunWindowSurface[] = [
  "run-page",
  "step-by-step",
  "schedule",
  "armed-trigger",
  "review",
];

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function mount(surface: RunWindowSurface) {
  const main = document.createElement("main");
  // The card the window may not cover, standing where the page puts it.
  const bar = document.createElement("div");
  bar.setAttribute("data-testid", "decision-bar");
  main.appendChild(bar);
  document.body.appendChild(main);
  render(
    <HitlConversationPanel
      portalTarget={main}
      visible
      conversation={[]}
      promptPending={false}
      storageKey={`k-${surface}`}
      surface={surface}
      onSubmit={async () => {}}
    />,
  );
  const panel = main.querySelector<HTMLElement>("[data-run-window-placement]");
  return { main, bar, panel };
}

describe("§VI — the review page's window stands beneath the decision bar", () => {
  it("is IN FLOW: no sticky, no fixed, no absolute, no bottom, no stacking context", () => {
    const { panel } = mount("review");
    expect(panel).not.toBeNull();
    const cls = panel!.className;
    for (const token of ["sticky", "fixed", "absolute", "bottom-0", "z-30"]) {
      expect(cls).not.toContain(token);
    }
    // And no inline background fade either: nothing passes under it.
    expect(panel!.getAttribute("style") ?? "").toBe("");
  });

  it("comes AFTER the decision bar in document order", () => {
    const { bar, panel } = mount("review");
    const rel = bar.compareDocumentPosition(panel!);
    // eslint-disable-next-line no-bitwise
    expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // eslint-disable-next-line no-bitwise
    expect(rel & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeFalsy();
  });

  it("the other four windows keep the floating reading they were drawn with", () => {
    for (const surface of SURFACES.filter((s) => s !== "review")) {
      const { panel } = mount(surface);
      expect(panel!.className).toContain("sticky");
      expect(panel!.className).toContain("bottom-0");
      cleanup();
      document.body.innerHTML = "";
    }
  });

  it("every surface has a placement, and only the review page's is in flow", () => {
    expect(Object.keys(RUN_WINDOW_PLACEMENTS).sort()).toEqual([...SURFACES].sort());
    expect(RUN_WINDOW_PLACEMENTS.review).toBe("in-flow");
    for (const surface of SURFACES.filter((s) => s !== "review")) {
      expect(RUN_WINDOW_PLACEMENTS[surface]).toBe("floating");
    }
  });
});

describe("the send control's accessible name carries the window's own sentence", () => {
  it("is not the name borrowed from another surface", () => {
    for (const surface of SURFACES) {
      expect(runWindowSendLabel(surface)).not.toBe("Apply AI suggestion");
    }
  });

  for (const surface of SURFACES) {
    it(`"${surface}" — the name the field is given is that sentence`, () => {
      mount(surface);
      expect(promptField.submitAriaLabel).toBe(runWindowSendLabel(surface));
      expect(promptField.submitAriaLabel).not.toBe("Apply AI suggestion");
    });
  }

  for (const surface of SURFACES) {
    it(`"${surface}" — the send control says what this window does`, () => {
      const sentence = RUN_WINDOW_PLACEHOLDERS[surface].replace(/…$/u, "");
      const label = runWindowSendLabel(surface);
      expect(label.startsWith("Send — ")).toBe(true);
      expect(label.slice("Send — ".length).toLowerCase()).toBe(sentence.toLowerCase());
    });
  }
});
