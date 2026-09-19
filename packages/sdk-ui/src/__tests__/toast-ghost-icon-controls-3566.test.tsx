/**
 * Toast — the Copy and close controls are the drawing's ghost icon controls
 * (cinatra#3566).
 *
 * WHAT THIS SUITE PINS, and why it reads the BUILDER rather than a DOM.
 * The two controls on the right of a toast are made in ONE place: the option
 * builder of this module, which injects the default Copy action and turns the
 * library's built-in close control on. The host primitive
 * (src/components/ui/sonner.tsx) says so in its own words — "Copy and Close
 * controls are injected by the `cinatraToast(...)` wrapper through Sonner
 * `action` and `cancel` slots; this primitive owns the CSS chrome only" — so the
 * payload this builder hands the library IS the treatment of those controls.
 * Reading the payload makes a departure fail here instead of first in a picture
 * round.
 *
 * THE DRAWING (design specs/app-components.html, Toast / Sonner) draws every one
 * of the eight controls in its four worked toasts with one declaration:
 *   background:transparent;border:0;padding:0;cursor:pointer;color:currentColor;
 *   opacity:0.55;display:inline-grid;place-items:center
 * each around ONE glyph at width:13px;height:13px on stroke="currentColor" —
 * the copy glyph at stroke-width 2.2, the close glyph at stroke-width 2.4.
 *
 * WHY TWO DIFFERENT ROADS. The library paints both controls from a stylesheet it
 * injects at run time, so its rules are unlayered and a layered utility cannot
 * reach past them. It offers a per-toast INLINE style hook for the action button
 * (`actionButtonStyle`) and a per-toast CLASS hook for the close control
 * (`classNames.closeButton`) — and no inline hook for the close control at all.
 * So the copy control's ghost tokens are read here as an inline style and the
 * close control's as a class whose ground, border and ink carry `!important`.
 * OPACITY IS THE EXCEPTION for both controls and is read as a PLAIN layered
 * utility, because the library fades a collapsed back toast with an unlayered
 * rule on the toast's direct children — which both controls are — and an inline
 * or important 0.55 would pin the control visible over a faded toast,
 * because the library's own per-type rule
 * `[data-rich-colors=true][data-sonner-toast][data-type=error]
 * [data-close-button]` is more specific than any rule this module could write.
 *
 * The root vitest environment is "node", so the glyph label is rendered through
 * `react-dom/server`, the same rendering road three of this package's existing
 * suites already use (icons, pdf-detail-shell, w3-pdf-shell-byte-road).
 */
import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";

/**
 * The library stand-in. It is built inside `vi.hoisted` so the mock factory can
 * reach it, and so the two pass-through entries below can be compared by
 * identity WITHOUT this file importing the toast library — which the repository's
 * `no-restricted-imports` rule allows in the wrapper alone.
 */
const harness = vi.hoisted(() => {
  type Recorded = {
    entry: string;
    message: unknown;
    options: Record<string, unknown> | undefined;
  };
  const calls: Recorded[] = [];
  const record =
    (entry: string) =>
    (message: unknown, options?: Record<string, unknown>) => {
      calls.push({ entry, message, options });
      return entry;
    };
  return {
    calls,
    record,
    promise: record("promise"),
    loading: record("loading"),
    dismiss: record("dismiss"),
  };
});

// The mock is released again in afterAll below, and the module registry is reset
// after every case, so this file leaves the package's full run untouched.
vi.mock("sonner", () => ({
  toast: Object.assign(harness.record("callable"), {
    success: harness.record("success"),
    error: harness.record("error"),
    warning: harness.record("warning"),
    info: harness.record("info"),
    message: harness.record("message"),
    promise: harness.promise,
    loading: harness.loading,
    dismiss: harness.dismiss,
  }),
}));

import { buildOptions, cinatraToast } from "../toast";

/**
 * An error toast that carries a reference — the shape the issue photographs
 * ("every error toast that carries a reference, for example the failed
 * marketplace install").
 */
const REFERENCE_MESSAGE =
  "Marketplace install failed — reference CIN-3535-A1. Try again or copy this reference.";

/** The drawing's declaration for the two controls, token by token. */
const DRAWN = {
  ground: "transparent",
  border: 0,
  padding: 0,
  ink: "currentColor",
  opacityClass: "opacity-[0.55]",
  display: "inline-grid",
  placeItems: "center",
  glyphSize: "13",
  copyStrokeWidth: "2.2",
  closeStrokeWidth: "2.4",
} as const;

/** Every variant entry of the wrapper, plus the bare callable. */
const VARIANT_ENTRIES = [
  "callable",
  "success",
  "error",
  "warning",
  "info",
  "message",
] as const;

function raise(entry: (typeof VARIANT_ENTRIES)[number], message: string) {
  if (entry === "callable") return cinatraToast(message);
  return cinatraToast[entry](message);
}

function ghostStyleOf(options: Record<string, unknown> | undefined) {
  return options?.actionButtonStyle as Record<string, unknown> | undefined;
}

function closeClassOf(options: Record<string, unknown> | undefined) {
  const classNames = options?.classNames as
    | { closeButton?: string }
    | undefined;
  return classNames?.closeButton ?? "";
}

function actionClassOf(options: Record<string, unknown> | undefined) {
  const classNames = options?.classNames as
    | { actionButton?: string }
    | undefined;
  return classNames?.actionButton ?? "";
}

/**
 * A class string is read as its TOKENS, never as a substring: `bg-transparent!`
 * is a substring of `hover:bg-transparent!`, so a substring reading of the
 * resting ground would pass on a class that declared the hover ground alone.
 */
function tokensOf(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

afterEach(() => {
  harness.calls.length = 0;
  vi.resetModules();
});

afterAll(() => {
  vi.doUnmock("sonner");
  vi.resetModules();
});

describe("C4 — the Copy control is the drawing's ghost icon control", () => {
  it("carries the drawing's ground, border, padding and ink as an inline style on the action button", () => {
    const options = buildOptions(REFERENCE_MESSAGE);
    const style = ghostStyleOf(options as unknown as Record<string, unknown>);

    expect(style).toBeDefined();
    // No filled ground, no border, no padding.
    expect(style?.background).toBe(DRAWN.ground);
    expect(style?.border).toBe(DRAWN.border);
    expect(style?.padding).toBe(DRAWN.padding);
    // The ink is the toast's own status colour.
    expect(style?.color).toBe(DRAWN.ink);
    // The glyph's own box, centred in a grid — the drawing's control geometry,
    // in place of the library's 24px padded pill.
    expect(style?.display).toBe(DRAWN.display);
    expect(style?.placeItems).toBe(DRAWN.placeItems);
    expect(style?.height).toBe("auto");
  });

  it("carries the drawing's opacity as a CLASS and never inline, so a collapsed back toast still fades", () => {
    const options = buildOptions(REFERENCE_MESSAGE);
    const style = ghostStyleOf(options as unknown as Record<string, unknown>);

    // Inline or important, the drawing's 0.55 would outrank the library's own
    // unlayered stack-fade rule on the toast's direct children
    // (`[data-expanded=false][data-front=false][data-styled=true] > *`) and pin
    // the glyph visible over a faded back toast. A plain layered utility reads
    // 0.55 at rest and loses to that rule, which is the whole point.
    expect(style?.opacity).toBeUndefined();
    expect(
      tokensOf(actionClassOf(options as unknown as Record<string, unknown>)),
    ).toContain(DRAWN.opacityClass);
    expect(
      tokensOf(actionClassOf(options as unknown as Record<string, unknown>)),
    ).not.toContain(`${DRAWN.opacityClass}!`);
  });

  it("keeps anything else the caller declared for that button and writes the drawn tokens last", () => {
    const options = buildOptions(REFERENCE_MESSAGE, {
      actionButtonStyle: { marginLeft: 12, background: "red" },
      classNames: { actionButton: "caller-owned-action" },
    });
    const style = ghostStyleOf(options as unknown as Record<string, unknown>);

    expect(style?.marginLeft).toBe(12);
    // The drawing wins on the property both of them declare.
    expect(style?.background).toBe(DRAWN.ground);
    expect(
      tokensOf(actionClassOf(options as unknown as Record<string, unknown>)),
    ).toEqual(["caller-owned-action", DRAWN.opacityClass]);
  });

  it("hands that same ghost treatment through the bare callable and each of the five variant entries", () => {
    for (const entry of VARIANT_ENTRIES) raise(entry, REFERENCE_MESSAGE);

    expect(harness.calls.map((call) => call.entry)).toEqual([
      ...VARIANT_ENTRIES,
    ]);
    for (const call of harness.calls) {
      const style = ghostStyleOf(call.options);
      expect(style, `${call.entry} carries no ghost style`).toBeDefined();
      expect(style?.background).toBe(DRAWN.ground);
      expect(style?.border).toBe(DRAWN.border);
      expect(style?.padding).toBe(DRAWN.padding);
      expect(style?.color).toBe(DRAWN.ink);
      expect(style?.opacity).toBeUndefined();
      expect(
        tokensOf(actionClassOf(call.options)),
        `${call.entry} carries no drawn opacity`,
      ).toContain(DRAWN.opacityClass);
    }
  });
});

describe("C6 — the Copy action keeps its accessible name", () => {
  it("renders ONE glyph element at the drawing's size and weight, with the word Copy as its accessible name and not as drawn text", () => {
    const options = buildOptions(REFERENCE_MESSAGE);
    const action = options.action as { label: ReactNode; onClick: unknown };

    expect(action).toBeDefined();
    expect(typeof action.onClick).toBe("function");
    // The label is an element, never the bare word.
    expect(typeof action.label).not.toBe("string");

    const markup = renderToStaticMarkup(action.label as ReactElement);

    // Exactly one glyph.
    expect(markup.match(/<svg/g)).toHaveLength(1);
    // The drawing's geometry and weight for the copy glyph.
    expect(markup).toContain(`width="${DRAWN.glyphSize}"`);
    expect(markup).toContain(`height="${DRAWN.glyphSize}"`);
    expect(markup).toContain(`stroke-width="${DRAWN.copyStrokeWidth}"`);
    expect(markup).toContain('stroke="currentColor"');
    // The accessible name survives as the word Copy, carried by the glyph.
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Copy"');
    // …and the word appears NOWHERE as visible text.
    expect(markup.replace(/aria-label="Copy"/g, "")).not.toContain("Copy");
  });
});

describe("C5 — the close control is the drawing's ghost icon control", () => {
  it("declares the drawing's transparent ground at rest and under the pointer, no border, currentColor ink, the drawing's opacity and its glyph at 13px / stroke-width 2.4", () => {
    const options = buildOptions(REFERENCE_MESSAGE);
    const closeClass = closeClassOf(
      options as unknown as Record<string, unknown>,
    );

    // Read as TOKENS: `bg-transparent!` is a substring of
    // `hover:bg-transparent!`, so a substring reading of the resting ground
    // would pass on a class that declared the hover ground alone.
    const tokens = tokensOf(closeClass);

    expect(tokens).not.toEqual([]);
    // Ground: the drawing's transparent, at rest AND under the pointer, each
    // declared important so it outranks the library's unlayered per-type rule.
    expect(tokens).toContain("bg-transparent!");
    expect(tokens).toContain("hover:bg-transparent!");
    // Border: none, in both palettes and in the error type's own rule.
    expect(tokens).toContain("border-0!");
    expect(tokens).toContain("hover:border-0!");
    // Ink: the toast's own status colour.
    expect(tokens).toContain("text-current!");
    // The drawing's opacity — plain, so the library's own unlayered stack-fade
    // rule still fades this control with the rest of a collapsed back toast.
    expect(tokens).toContain(DRAWN.opacityClass);
    expect(tokens).not.toContain(`${DRAWN.opacityClass}!`);
    // The glyph at the drawing's size and weight, where the library ships 12px
    // at stroke-width 1.5.
    expect(tokens).toContain(`[&>svg]:size-[${DRAWN.glyphSize}px]`);
    expect(tokens).toContain(
      `[&>svg]:[stroke-width:${DRAWN.closeStrokeWidth}]`,
    );
  });

  it("hands that class through the bare callable and each of the five variant entries", () => {
    for (const entry of VARIANT_ENTRIES) raise(entry, REFERENCE_MESSAGE);

    for (const call of harness.calls) {
      const tokens = tokensOf(closeClassOf(call.options));
      expect(tokens, `${call.entry} carries no close class`).toContain(
        "bg-transparent!",
      );
      expect(tokens).toContain("border-0!");
      expect(tokens).toContain("text-current!");
      expect(tokens).toContain(DRAWN.opacityClass);
    }
  });

  it("appends the ghost class to a caller's own close class instead of replacing it", () => {
    const options = buildOptions(REFERENCE_MESSAGE, {
      classNames: { closeButton: "caller-owned-close" },
    });
    const tokens = tokensOf(
      closeClassOf(options as unknown as Record<string, unknown>),
    );

    expect(tokens).toEqual([
      "caller-owned-close",
      "bg-transparent!",
      "hover:bg-transparent!",
      "border-0!",
      "hover:border-0!",
      "text-current!",
      DRAWN.opacityClass,
      `[&>svg]:size-[${DRAWN.glyphSize}px]`,
      `[&>svg]:[stroke-width:${DRAWN.closeStrokeWidth}]`,
    ]);
  });

  it("carries every other per-toast class the caller passed through untouched", () => {
    const options = buildOptions(REFERENCE_MESSAGE, {
      classNames: { toast: "caller-owned-toast", title: "caller-owned-title" },
    });
    const classNames = (options as unknown as Record<string, unknown>)
      .classNames as Record<string, string>;

    expect(classNames.toast).toBe("caller-owned-toast");
    expect(classNames.title).toBe("caller-owned-title");
  });
});

describe("C7 — the close control keeps its keyboard reach", () => {
  it("leaves the library's built-in close control turned on for every toast the builder makes", () => {
    for (const entry of VARIANT_ENTRIES) raise(entry, REFERENCE_MESSAGE);

    for (const call of harness.calls) {
      expect(call.options?.closeButton, `${call.entry}`).toBe(true);
    }
  });

  it("still lets a caller turn it off for a toast that must live until done", () => {
    const options = buildOptions(REFERENCE_MESSAGE, { closeButton: false });
    expect(options.closeButton).toBe(false);
  });
});

describe("C8 — a labelled action a caller supplies is untouched", () => {
  it("hands the product's own Undo action through with no ghost style and no glyph", () => {
    const onClick = () => {};
    const options = buildOptions("Saved — 3 rows changed.", {
      action: { label: "Undo", onClick },
    });

    expect(options.action).toEqual({ label: "Undo", onClick });
    expect((options.action as { label: ReactNode }).label).toBe("Undo");
    expect(
      ghostStyleOf(options as unknown as Record<string, unknown>),
    ).toBeUndefined();
    // …and no ghost class either: the drawn opacity belongs to the Copy glyph.
    expect(
      actionClassOf(options as unknown as Record<string, unknown>),
    ).toBe("");
  });

  it("leaves the explicit opt-out with no action and no ghost style", () => {
    const options = buildOptions(REFERENCE_MESSAGE, { action: null });

    expect(options.action).toBeUndefined();
    expect(
      ghostStyleOf(options as unknown as Record<string, unknown>),
    ).toBeUndefined();
    expect(
      actionClassOf(options as unknown as Record<string, unknown>),
    ).toBe("");
  });

  it("gives the close control the drawing's ghost class even on those toasts, because the drawing draws that control on every toast", () => {
    const withCallerAction = buildOptions("Saved — 3 rows changed.", {
      action: { label: "Undo", onClick: () => {} },
    });
    const optedOut = buildOptions(REFERENCE_MESSAGE, { action: null });

    for (const options of [withCallerAction, optedOut]) {
      expect(
        tokensOf(closeClassOf(options as unknown as Record<string, unknown>)),
      ).toContain("bg-transparent!");
    }
  });
});

describe("C9 — the census of controls this change touches is exactly the builder's", () => {
  it("leaves the two pass-through entries bypassing the builder entirely", () => {
    // `promise` and `loading` are the library's own functions, assigned through
    // untouched — they never reach the builder, so no control of theirs is in
    // this change's census.
    expect(cinatraToast.promise).toBe(harness.promise);
    expect(cinatraToast.loading).toBe(harness.loading);
    expect(cinatraToast.dismiss).toBe(harness.dismiss);
  });

  it("carries every other option the caller passed through unchanged", () => {
    const options = buildOptions(REFERENCE_MESSAGE, {
      duration: 12000,
      id: "install-failure",
    });

    expect(options.duration).toBe(12000);
    expect(options.id).toBe("install-failure");
  });
});
