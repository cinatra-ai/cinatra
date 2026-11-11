// @vitest-environment jsdom
/**
 * Toast: toasts are icon led, and the stack keeps the newest on top, in a
 * REAL rendered `<Toaster>` (cinatra#3189, G4 toast).
 *
 *   pnpm exec vitest run src/components/ui/__tests__/toast-icon-led-and-stack-3189.test.tsx
 *
 * The components drawing (Toast / Sonner): "Five variants — default · success
 * · warning · error · info — each on the popover surface with a
 * status-coloured border and matching text; an icon on the left identifies
 * the type. ... Stack vertically, newest on top." Its examples draw the
 * glyphs: the default toast a muted circled alert (stroke 2.2), success the
 * check, warning the triangle, error the cross (stroke 2.4), each 14px. They
 * draw no info glyph, so the info toast keeps the library's own.
 *
 * With no caller icon, the toast library draws an icon only for a typed toast, and its own icons
 * are filled discs. The product's Toaster (src/components/ui/sonner.tsx) hands
 * the library the drawn typed glyphs; the toast wrapper
 * (packages/sdk-ui/src/toast.ts) hands the untyped toast (the bare call and
 * `.message`) the drawn default glyph. The Toaster is mounted with the props
 * the application mounts it with (src/app/providers.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Toaster } from "@/components/ui/sonner";
import { toast, type CinatraToastOptions } from "@/lib/cinatra-toast";

vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "cinatra" }) }));

beforeEach(() => {
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
});

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  cleanup();
  vi.unstubAllGlobals();
});

function mountToaster() {
  render(<Toaster richColors position="top-right" closeButton duration={8000} />);
}

async function rendered(message: string): Promise<HTMLElement> {
  const text = await screen.findByText(message);
  const el = text.closest<HTMLElement>("[data-sonner-toast]");
  if (!el) throw new Error(`no rendered toast carries "${message}"`);
  return el;
}

/** The drawn glyph of a rendered toast, as its shape list; null when it has none. */
function glyphOf(el: HTMLElement): string[] | null {
  const icon = el.querySelector(":scope > [data-icon]");
  const svg = icon?.querySelector("svg");
  if (!svg) return null;
  return Array.from(svg.children).map((c) =>
    c.tagName.toLowerCase() === "circle"
      ? `circle ${c.getAttribute("cx")},${c.getAttribute("cy")} r${c.getAttribute("r")}`
      : `path ${c.getAttribute("d")}`,
  );
}

const DEFAULT_GLYPH = ["circle 12,12 r9", "path M12 8v4", "path M12 16h.01"];
const TYPED: Array<[string, (m: string, o?: CinatraToastOptions) => unknown, string[]]> = [
  ["success", toast.success, ["path M20 6 9 17l-5-5"]],
  [
    "warning",
    toast.warning,
    [
      "path M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
      "path M12 9v4",
      "path M12 17h.01",
    ],
  ],
  ["error", toast.error, ["path M18 6 6 18", "path m6 6 12 12"]],
];

describe('"an icon on the left identifies the type": the default toast', () => {
  it("leads the bare toast with the drawn muted circled alert, before its message", async () => {
    mountToaster();
    act(() => {
      toast("Run #2,318 started.");
    });
    const el = await rendered("Run #2,318 started.");
    expect(glyphOf(el)).toEqual(DEFAULT_GLYPH);
    const svg = el.querySelector(":scope > [data-icon] svg")!;
    expect(svg.getAttribute("class")).toBe("text-muted-foreground");
    expect(svg.getAttribute("stroke-width")).toBe("2.2");
    expect(svg.getAttribute("width")).toBe("14");
    const icon = el.querySelector(":scope > [data-icon]")!;
    const content = el.querySelector(":scope > [data-content]")!;
    expect(icon.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("leads a .message toast with the same glyph", async () => {
    mountToaster();
    act(() => {
      toast.message("Draft saved.");
    });
    expect(glyphOf(await rendered("Draft saved."))).toEqual(DEFAULT_GLYPH);
  });

  it("keeps the glyph when a caller passes icon: null, because a toast is icon led", async () => {
    mountToaster();
    act(() => {
      toast("Export queued.", { icon: null });
    });
    expect(glyphOf(await rendered("Export queued."))).toEqual(DEFAULT_GLYPH);
  });

  it.each([
    ["false", false],
    ["0", 0],
    ["an empty string", ""],
  ])("keeps the glyph when a caller passes icon: %s, because a falsy icon is no icon", async (name, icon) => {
    mountToaster();
    const message = `Falsy ${name}.`;
    act(() => {
      toast(message, { icon });
    });
    expect(glyphOf(await rendered(message))).toEqual(DEFAULT_GLYPH);
  });

  it("draws a caller's own icon element instead of the default glyph", async () => {
    mountToaster();
    act(() => {
      toast("Uploaded.", { icon: <svg data-testid="own-icon"><path d="M1 1h2" /></svg> });
    });
    const el = await rendered("Uploaded.");
    expect(el.querySelector(':scope > [data-icon] [data-testid="own-icon"]')).not.toBeNull();
    expect(glyphOf(el)).toEqual(["path M1 1h2"]);
  });

  it("still carries Close beside the glyph", async () => {
    mountToaster();
    act(() => {
      toast("Run #7 started.");
    });
    const el = await rendered("Run #7 started.");
    expect(el.querySelector("[data-close-button]")).not.toBeNull();
  });
});

describe('"an icon on the left identifies the type": the typed toasts', () => {
  it.each(TYPED)("leads a %s toast with its drawn stroked glyph, not the library's disc", async (type, raise, glyph) => {
    mountToaster();
    const message = `A ${type} toast.`;
    act(() => {
      raise(message);
    });
    const el = await rendered(message);
    expect(el.getAttribute("data-type")).toBe(type);
    expect(glyphOf(el)).toEqual(glyph);
    const svg = el.querySelector(":scope > [data-icon] svg")!;
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("stroke-width")).toBe("2.4");
    expect(svg.getAttribute("width")).toBe("14");
  });

  it.each([
    ["null", null],
    ["false", false],
  ])("keeps a typed toast's glyph when a caller passes icon: %s", async (name, icon) => {
    mountToaster();
    const message = `Connector lost, ${name}.`;
    act(() => {
      toast.error(message, { icon });
    });
    expect(glyphOf(await rendered(message))).toEqual(["path M18 6 6 18", "path m6 6 12 12"]);
  });
});

describe("the info toast, whose glyph the drawing does not draw", () => {
  it("keeps the library's own glyph, not one of the drawn family", async () => {
    mountToaster();
    act(() => {
      toast.info("An info toast.");
    });
    const el = await rendered("An info toast.");
    expect(el.getAttribute("data-type")).toBe("info");
    const svg = el.querySelector(":scope > [data-icon] svg");
    expect(svg).not.toBeNull();
    expect(svg!.hasAttribute("data-toast-glyph")).toBe(false);
  });
});

// A SETTLE of the library's own behaviour (the product's Toaster overrides
// none of it): at the top-right position the newest toast is the front one,
// index 0, and the stack's top edge is the screen's top.
describe('"Stack vertically, newest on top"', () => {
  it("puts the newer of two raised toasts in front, at index 0, on a top-anchored stack", async () => {
    mountToaster();
    act(() => {
      toast("The older toast.");
    });
    await rendered("The older toast.");
    act(() => {
      toast("The newer toast.");
    });
    const newer = await rendered("The newer toast.");
    const older = await rendered("The older toast.");
    expect(newer.getAttribute("data-front")).toBe("true");
    expect(newer.getAttribute("data-index")).toBe("0");
    expect(older.getAttribute("data-front")).toBe("false");
    expect(older.getAttribute("data-index")).toBe("1");
    expect(newer.getAttribute("data-y-position")).toBe("top");
  });
});
