// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// §I INPUT HIERARCHY — the decision bar's note field is SUBORDINATE (#2865).
// ---------------------------------------------------------------------------
// Design: `specs/app-lifecycle-cards.html` §I at
// 60b27dfbb8a2a1594e6e88333cc5c048c244e640 (the `.notefield` / `.nf-input`
// rules).
//
// The drawing's rule is that exactly ONE primary input is drawn per
// conversation and it is the chat box; every field a card carries is drawn
// subordinate to it. What makes an input read as somewhere to type is a closed
// list of three things — the enclosing box, the raised ground and the send
// affordance — so this file pins BOTH directions: the dashed baseline is there,
// and none of the three came back. The negative matters more than the positive:
// a later "tidy" that restored the stock bordered `Textarea` would still show a
// dashed bottom edge under a naive positive-only check, because the stock box
// draws all four edges.
//
// Label and placeholder are asserted BYTE-IDENTICAL: this slice moves weight,
// it does not reword the field.
// ---------------------------------------------------------------------------

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The shipped bar calls `router.refresh()` after a landed decision; jsdom has
// no router mounted, so the seam is stubbed and the bar never navigates.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import type { ReviewSubmitOutcome } from "@/lib/artifacts/review-surface-model";
import { ReviewDecisionBar } from "../review-decision-bar";
import { LifecycleCardSurfaceProvider, LifecycleComposerFocusProvider, createComposerFocusStore } from "../lifecycle-card-runtime";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOTE_FIELD = '[data-conformance-id="review-note-field-subordinate"]';

function renderBar(
  outcome: ReviewSubmitOutcome = { kind: "annotated" },
  permissions = { canDecide: true, canComment: true },
) {
  const submitAction = vi.fn(async () => outcome);
  const result = render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <LifecycleComposerFocusProvider store={createComposerFocusStore()}>
        <ReviewDecisionBar permissions={permissions} submitAction={submitAction} />
      </LifecycleComposerFocusProvider>
    </LifecycleCardSurfaceProvider>,
  );
  return { ...result, submitAction };
}

/** The field's classes as the browser sees them, after `cn` has merged them. */
function classesOf(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

function noteField(): HTMLElement {
  return screen.getByTestId("review-rationale");
}

describe("§I — the note field carries the subordinate treatment (#2865)", () => {
  it("names itself with the §I conformance id", () => {
    const { container } = renderBar();
    const wrapper = container.querySelector(NOTE_FIELD);
    expect(wrapper, "the §I subordinate note-field wrapper").not.toBeNull();
    // The field itself lives inside the region that claims the id.
    expect(wrapper!.contains(noteField())).toBe(true);
  });

  it("draws the dashed baseline on transparent ground, flush left, muted 12px", () => {
    renderBar();
    const classes = classesOf(noteField());
    for (const cls of [
      // the drawing's `.nf-input`: border:0; border-bottom:1px dashed var(--line)
      "border-0",
      "border-b",
      "border-dashed",
      "border-line",
      // border-radius: 0; background: transparent; flush-left
      "rounded-none",
      "bg-transparent",
      "dark:bg-transparent",
      "px-0",
      // font-size: 12px; color: var(--muted)
      "text-xs",
      "md:text-xs",
      "text-muted-foreground",
      // the raised ground the chat box keeps and this field gives up
      "shadow-none",
    ]) {
      expect(classes, `expected the note field to carry \`${cls}\``).toContain(cls);
    }
  });

  it("NEGATIVE — renders no bordered box: no all-sides border, no radius, no fill, no elevation, no ring, no send control", () => {
    const { container } = renderBar();
    const field = noteField();
    const classes = classesOf(field);

    // The stock `Textarea` box, class by class — every one of these must have
    // been merged away rather than merely overdrawn.
    expect(classes, "the all-sides border").not.toContain("border");
    expect(
      classes.filter((c) => /^rounded-(?!none$)/.test(c)),
      "a corner radius (the box's silhouette)",
    ).toEqual([]);
    expect(
      classes.filter((c) => /^(dark:)?bg-(?!transparent$)/.test(c)),
      "a raised/filled ground",
    ).toEqual([]);
    expect(
      classes.filter((c) => /^shadow-(?!none$)/.test(c)),
      "an elevation shadow",
    ).toEqual([]);
    // A focus ring is a box drawn on focus, so the WIDTH goes to zero. The
    // inert `ring-ring/50` colour the base keeps paints nothing at width 0, and
    // focus stays visible: the base's `focus-visible:border-ring` recolours the
    // dashed rule itself.
    expect(
      classes.filter((c) => /^focus-visible:ring-\d/.test(c)),
      "a focus ring (a box drawn on focus is still a box)",
    ).toEqual(["focus-visible:ring-0"]);

    // The third thing an input-to-type carries: something to press to send.
    // The note field's region has none — the decision floor's buttons sit
    // OUTSIDE it, which is what this scoping check proves.
    const wrapper = container.querySelector(NOTE_FIELD)!;
    expect(wrapper.querySelector("button"), "a send affordance").toBeNull();
    expect(wrapper.querySelectorAll("textarea, input")).toHaveLength(1);
  });

  it("keeps the label and the placeholder byte-identical", () => {
    const { container } = renderBar();
    const label = container.querySelector("label[for='review-rationale']")!;
    expect(label.textContent).toBe(
      "Decision rationale (optional on approve, expected on reject)",
    );
    // The drawing's mono, 9px, wide-tracked, uppercase label — unchanged.
    const labelClasses = classesOf(label);
    for (const cls of ["font-mono", "uppercase", "tracking-widest", "text-muted-foreground"]) {
      expect(labelClasses).toContain(cls);
    }
    expect(noteField().getAttribute("placeholder")).toBe(
      "Add a note for the run and the audit trail…",
    );
  });

  it("DISABLED/SETTLED — keeps the same dashed rule at the platform's standard disabled opacity", async () => {
    renderBar({ kind: "decided", disposition: "approve", idempotent: false });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect((noteField() as HTMLTextAreaElement).disabled).toBe(true),
    );

    const classes = classesOf(noteField());
    // Same rule …
    expect(classes).toContain("border-b");
    expect(classes).toContain("border-dashed");
    // … the platform's standard disabled opacity, and nothing else …
    expect(classes).toContain("disabled:opacity-50");
    // … in particular the stock filled disabled ground never comes back,
    // which would put the box back exactly where §I took it out.
    expect(classes).toContain("disabled:bg-transparent");
    expect(classes).toContain("dark:disabled:bg-transparent");
    expect(
      classes.filter((c) => /^(dark:)?disabled:bg-(?!transparent$)/.test(c)),
    ).toEqual([]);
  });
});

describe("§I — the rationale plumbing is untouched (#2865 acceptance 4)", () => {
  it("still carries the typed note into the decision it rides", async () => {
    const { submitAction } = renderBar();
    fireEvent.change(noteField(), { target: { value: "  reads fine  " } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    expect(submitAction).toHaveBeenCalledWith({
      disposition: "comment",
      comment: "reads fine",
    });
  });

  it("still sends `null` for an empty note", async () => {
    const { submitAction } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledTimes(1));
    expect(submitAction).toHaveBeenCalledWith({ disposition: "comment", comment: null });
  });
});


describe("§VI authorized producer prefill is not a reader annotation", () => {
  for (const action of ["Comment", "Approve"] as const) {
    it(`does not sign untouched producer words as the reader's ${action}`, async () => {
      const submitAction = vi.fn(async (): Promise<ReviewSubmitOutcome> => ({ kind: "annotated" }));
      render(<ReviewDecisionBar permissions={{ canDecide: true, canComment: true }} submitAction={submitAction} recordedPrompt="a red fox in snow" />);
      expect((noteField() as HTMLTextAreaElement).value).toBe("a red fox in snow");
      fireEvent.click(screen.getByRole("button", { name: action }));
      await waitFor(() => expect(submitAction).toHaveBeenCalledWith({ disposition: action === "Approve" ? "approve" : "comment", comment: null }));
    });
  }
  it("preserves an explicitly edited reader note without changing the visible floor", async () => {
    const submitAction = vi.fn(async (): Promise<ReviewSubmitOutcome> => ({ kind: "annotated" }));
    render(<ReviewDecisionBar permissions={{ canDecide: true, canComment: true }} submitAction={submitAction} recordedPrompt="producer words" />);
    fireEvent.change(noteField(), { target: { value: "  actual reader words  " } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(submitAction).toHaveBeenCalledWith({ disposition: "comment", comment: "actual reader words" }));
    expect(screen.getAllByRole("button").map((button) => button.textContent?.trim())).toEqual(["Comment", "Reject", "Approve"]);
  });
});

// Compile the shipped stylesheet and real cached imports. Resolve from this
// test file, so package and repository-root invocations read the same inputs.
// These are CSS declaration values at real DOM selectors, not jsdom geometry.
let primaryRules: { selector: string; declarations: string }[];
let readingSize: string;
beforeAll(async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const stylesheet = resolve(root, "src/app/globals.css");
  const require = createRequire(resolve(root, "package.json"));
  const globals = await readFile(stylesheet, "utf8");
  const compiled = await compile(globals, {
    base: dirname(stylesheet),
    loadStylesheet: async (id, base) => {
      let path: string;
      if (id === "tw-animate-css") {
        const packageRoot = resolve(root, "node_modules", id);
        const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
        path = resolve(packageRoot, manifest.exports["."].style);
      } else {
        path = id.startsWith(".") ? resolve(base, id) : require.resolve(id, { paths: [base] });
      }
      return { path, base: dirname(path), content: await readFile(path, "utf8") };
    },
  });
  const css = compiled.build(["border", "border-line", "rounded-[7px]", "bg-surface", "min-h-[44px]", "px-[11px]", "py-[9px]", "text-reading"]);
  const reading = globals.match(/--text-reading:\s*([^;]+);/);
  if (!reading) throw new Error("Missing shipped text-reading token");
  readingSize = reading[1].trim();
  primaryRules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
    .filter((rule) => rule[1].trim().startsWith("."))
    .map((rule) => ({ selector: rule[1].trim(), declarations: rule[2] }));
});

function declaredPrimaryValue(element: HTMLElement, property: string): string {
  const values = primaryRules.filter((rule) => element.matches(rule.selector))
    .flatMap((rule) => [...rule.declarations.matchAll(/([a-z-]+):\s*([^;]+);/g)]
      .filter((match) => match[1] === property).map((match) => match[2].trim()));
  expect(values, `nonempty unambiguous shipped ${property} declaration`).toHaveLength(1);
  return values[0] === "var(--text-reading)" ? readingSize : values[0];
}

// App654: app-lifecycle-cards §I "Exactly one primary input" and
// app-artifact-review §VI boxed Note. Real host providers select the same
// composer binding read used by the shipped conversation, including nesting.
// These DOM/declaration pins are native checks, not painted browser evidence.
describe("§I / §VI — Note hierarchy follows the actual surface (App654)", () => {
  for (const palette of ["light", "dark"] as const) {
    for (const host of ["run_card", "page_gate_region", "chat_thread"] as const) {
      it(`${palette} ${host} without composer: the sole Note is primary and boxed with §VI values`, () => {
        const submitAction = vi.fn(async (): Promise<ReviewSubmitOutcome> => ({ kind: "annotated" }));
        const { container } = render(
          <div className={palette === "dark" ? "dark" : ""}>
            <LifecycleCardSurfaceProvider host={host}>
              <ReviewDecisionBar permissions={{ canDecide: true, canComment: true }} submitAction={submitAction} />
            </LifecycleCardSurfaceProvider>
          </div>,
        );
        const field = noteField();
        const classes = classesOf(field);
        expect(container.querySelector(NOTE_FIELD), "no subordinate claim without a chatbox").toBeNull();
        for (const token of ["border", "border-line", "rounded-[7px]", "bg-surface", "dark:bg-surface", "min-h-[44px]", "px-[11px]", "py-[9px]", "text-reading"]) {
          expect(classes, `§VI primary declaration ${token}`).toContain(token);
        }
        for (const token of ["border-0", "border-b", "border-dashed", "rounded-none", "bg-transparent", "dark:bg-transparent"]) {
          expect(classes, `§I no subordinate declaration ${token}`).not.toContain(token);
        }
        expect(declaredPrimaryValue(field, "min-height")).toBe("44px");
        expect(declaredPrimaryValue(field, "border-radius")).toBe("7px");
        expect(declaredPrimaryValue(field, "border-width")).toBe("1px");
        expect(declaredPrimaryValue(field, "padding-inline")).toBe("11px");
        expect(declaredPrimaryValue(field, "padding-block")).toBe("9px");
        expect(declaredPrimaryValue(field, "font-size")).toBe("12.5px");
        expect(declaredPrimaryValue(field, "background-color")).toBe("var(--surface)");
        expect(container.querySelectorAll("textarea")).toHaveLength(1);
        expect(field.getAttribute("placeholder")).toBe("Add a note for the run and the audit trail…");
        expect(screen.getAllByRole("button").map((button) => button.textContent?.trim())).toEqual(["Comment", "Reject", "Approve"]);
      });
    }
    for (const nested of [false, true]) {
      it(`${palette} conversation${nested ? " nested run card" : ""}: chatbox remains primary`, () => {
        const bar = <ReviewDecisionBar permissions={{ canDecide: true, canComment: true }} submitAction={vi.fn(async (): Promise<ReviewSubmitOutcome> => ({ kind: "annotated" }))} />;
        const { container } = render(
          <div className={palette === "dark" ? "dark" : ""}>
            <LifecycleCardSurfaceProvider host="chat_thread">
              <LifecycleComposerFocusProvider store={createComposerFocusStore()}>
                {nested ? <LifecycleCardSurfaceProvider host="run_card">{bar}</LifecycleCardSurfaceProvider> : bar}
              </LifecycleComposerFocusProvider>
            </LifecycleCardSurfaceProvider>
          </div>,
        );
        expect(container.querySelector(NOTE_FIELD)?.contains(noteField())).toBe(true);
        const classes = classesOf(noteField());
        for (const token of ["border-0", "border-b", "border-dashed", "rounded-none", "bg-transparent", "dark:bg-transparent"]) expect(classes).toContain(token);
        expect(classes).not.toContain("border");
        expect(container.querySelectorAll("textarea")).toHaveLength(1);
      });
    }
  }
});
