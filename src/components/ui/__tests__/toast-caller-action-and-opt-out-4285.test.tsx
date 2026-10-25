// @vitest-environment jsdom
/**
 * Toast: a caller's own action replaces the default Copy, and `action: null`
 * opts out of it, in a REAL rendered `<Toaster>` (cinatra#4285).
 *
 * The components drawing (Toast / Sonner) says "Every toast carries a Copy
 * action by default and a Close". The wrapper's option builder
 * (packages/sdk-ui/src/toast.ts, `buildOptions`) adds that Copy for a message
 * that is a non-empty string (or when `copyText` is non-empty), unless the
 * caller passes its own `action`, which replaces it, or `action: null`, which
 * leaves it out. The builder's payload is pinned by
 * packages/sdk-ui/src/__tests__/toast-ghost-icon-controls-3566.test.tsx (C8).
 * This file reads the same two cases where a user sees them: the product's own
 * Toaster (src/components/ui/sonner.tsx) renders the toast through the toast
 * library, and the test reads the buttons inside that toast by their
 * accessible names.
 *
 * The first case is the control: a toast with a non-empty text message (or a
 * non-empty `copyText`) and no action carries Copy and Close, so the absence
 * of Copy in the other two cases is a reading of the rendered toast and not of
 * a Toaster that never draws Copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { Toaster } from "@/components/ui/sonner";
import { toast, type CinatraToastOptions } from "@/lib/cinatra-toast";

const writeText = vi.fn().mockResolvedValue(undefined);
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "cinatra" }) }));

beforeEach(() => {
  writeText.mockClear();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  toast.dismiss();
  cleanup();
  vi.unstubAllGlobals();
});

/** The accessible name the toast library gives its own Close control. */
const CLOSE = "Close toast";

/**
 * Mounts the product's Toaster, raises one toast through the wrapper from a
 * user click (the same road the conformance fixture takes), and returns the
 * rendered toast element that carries `message`.
 */
async function raiseToast(
  message: string,
  options: CinatraToastOptions,
): Promise<HTMLElement> {
  render(
    <>
      <Toaster richColors />
      <button
        type="button"
        onClick={() => toast(message, { duration: Infinity, ...options })}
      >
        Raise toast
      </button>
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Raise toast" }));
  const text = await screen.findByText(message);
  const rendered = text.closest<HTMLElement>("[data-sonner-toast]");
  if (!rendered) {
    throw new Error(`no rendered toast element carries "${message}"`);
  }
  return rendered;
}

/**
 * A short name for every button inside one rendered toast, sorted: its own
 * aria-label, else the aria-label of the glyph it holds (the default Copy
 * carries its name on its glyph), else its text.
 */
function buttonNamesIn(rendered: HTMLElement): string[] {
  return within(rendered)
    .queryAllByRole("button")
    .map(
      (button) =>
        button.getAttribute("aria-label") ??
        button.querySelector("[aria-label]")?.getAttribute("aria-label") ??
        button.textContent ??
        "",
    )
    .map((name) => name.trim())
    .sort();
}

describe("cinatra#4285: the Copy control in a rendered Toaster", () => {
  it("control: a toast with no action carries the default Copy and the Close", async () => {
    const message = "Install failed: reference CIN-4285-C0.";
    const rendered = await raiseToast(message, {});

    expect(
      within(rendered).queryByRole("button", { name: "Copy" }),
      "the default Copy is not drawn",
    ).not.toBeNull();
    expect(
      within(rendered).queryByRole("button", { name: CLOSE }),
      "the Close is not drawn",
    ).not.toBeNull();
  });

  it("(a) a caller-supplied action replaces the default Copy, and Close remains", async () => {
    const message = "Saved: 3 rows changed. Reference CIN-4285-A.";
    const onUndo = vi.fn();
    const rendered = await raiseToast(message, {
      action: { label: "Undo", onClick: onUndo },
    });

    const undo = within(rendered).queryByRole("button", { name: "Undo" });
    expect(undo, "the caller's own action is not drawn").not.toBeNull();
    expect(
      within(rendered).queryByRole("button", { name: "Copy" }),
      "the default Copy is drawn beside or instead of the caller's own action",
    ).toBeNull();
    expect(
      within(rendered).queryByRole("button", { name: CLOSE }),
      "the Close is not drawn",
    ).not.toBeNull();
    expect(buttonNamesIn(rendered)).toEqual([CLOSE, "Undo"].sort());

    // The drawn button is the caller's own: its click runs the caller's
    // handler and never the Copy's clipboard write.
    fireEvent.click(undo as HTMLElement);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("(b) action: null opts out of the default Copy, and Close remains", async () => {
    const message = "Install failed: reference CIN-4285-B.";
    const rendered = await raiseToast(message, { action: null });

    expect(
      within(rendered).queryByRole("button", { name: "Copy" }),
      "the default Copy is drawn although the caller opted out",
    ).toBeNull();
    expect(
      within(rendered).queryByRole("button", { name: CLOSE }),
      "the Close is not drawn",
    ).not.toBeNull();
    expect(buttonNamesIn(rendered)).toEqual([CLOSE]);
  });
});
