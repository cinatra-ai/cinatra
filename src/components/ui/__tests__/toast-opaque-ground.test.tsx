// @vitest-environment jsdom
/**
 * THE REFUSAL TOAST SITS ON THE DRAWN OPAQUE POPOVER GROUND (cinatra#3358).
 *
 * THE GRADE, verbatim:
 *
 *   "DRAWN SURFACE: the refusal toast is not on the drawn opaque popover
 *    ground — verified on a magnified crop, the topbar wrench, '+', theme and
 *    bell icons read through the toast body, the message text is overprinted by
 *    them, and the Close X sits on top of the bell and its badge (Components §
 *    Toast/Sonner: 'popover bg, status-coloured text + border')."
 *
 * TWO THINGS ARE PINNED, because the reading had two causes and either alone
 * brings it back:
 *
 *   1. THE GROUND IS CARRIED, not merely asked for. The wrapper routes every
 *      variant's ground to `var(--popover)` through the library's custom
 *      properties (its own suite grades that), but the library paints them from
 *      an unlayered stylesheet a variant rule can reach past. So the ground is
 *      also asserted on the toast itself.
 *   2. THE ISLAND CLEARS THE APPLICATION HEADER. The toast opens top-right on
 *      the library's own small offset, and the application header is a 64px
 *      sticky band across that same corner — which is how the header's controls
 *      and the toast came to occupy the same pixels at all. The island's offset
 *      is the header's height plus its gutter, so the toast's ground is its own.
 *
 *   pnpm vitest run src/components/ui/__tests__/toast-opaque-ground.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import {
  Toaster,
  TOASTER_MOBILE_OFFSET,
  TOASTER_OFFSET,
  TOAST_OPAQUE_GROUND_CLASS,
} from "../sonner";
import { toast } from "@/lib/cinatra-toast";

// The library asks the environment for its reduced-motion preference on mount,
// and this environment has no media-query implementation. Stubbed for this file
// only, and PUT BACK afterwards so the wider suite runs in the environment it
// expects.
const NO_MATCH_MEDIA = Symbol("absent");
let previousMatchMedia: unknown = NO_MATCH_MEDIA;

beforeEach(() => {
  previousMatchMedia = "matchMedia" in window ? window.matchMedia : NO_MATCH_MEDIA;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  toast.dismiss();
  cleanup();
  if (previousMatchMedia === NO_MATCH_MEDIA) {
    delete (window as unknown as Record<string, unknown>).matchMedia;
  } else {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: previousMatchMedia,
    });
  }
  vi.restoreAllMocks();
});

describe("the raised toast carries the drawn ground", () => {
  it("puts the opaque popover ground on the refusal toast itself", async () => {
    render(<Toaster richColors position="top-right" closeButton />);
    toast.error("Choose a list before continuing — or build one first.");

    const raised = await waitFor(() => {
      const el = document.querySelector("[data-sonner-toast]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    // THE GROUND IS NAMED HERE AS A LITERAL as well as through the constant.
    // Reading only the constant would make this pin agree with the wrapper
    // whatever the wrapper said — a ground of `bg-transparent` would pass it.
    // The drawn ground is `popover`, so that is what this file spells out.
    expect(TOAST_OPAQUE_GROUND_CLASS).toBe("!bg-popover");
    expect(
      raised.className.split(/\s+/),
      "the toast does not carry the drawn popover ground",
    ).toContain("!bg-popover");
    expect(
      raised.className.split(/\s+/),
      "the toast does not carry the drawn popover ground",
    ).toContain(TOAST_OPAQUE_GROUND_CLASS);
    expect(document.body.textContent).toContain(
      "Choose a list before continuing",
    );
  });

  it("puts the same ground on the Close control, which was read on top of the bell", async () => {
    render(<Toaster richColors position="top-right" closeButton />);
    toast.error("Choose a list before continuing — or build one first.");

    const close = await waitFor(() => {
      const el = document.querySelector("[data-close-button]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(close.className.split(/\s+/)).toContain("!bg-popover");
    expect(close.className.split(/\s+/)).toContain(TOAST_OPAQUE_GROUND_CLASS);
  });
});

describe("the toast island clears the application header", () => {
  it("opens the island below the header band rather than across it", async () => {
    render(<Toaster richColors position="top-right" closeButton />);
    // The island itself mounts with the first toast — with none raised the
    // library emits a bare section and no positioned container at all.
    toast.error("Choose a list before continuing — or build one first.");

    const island = await waitFor(() => {
      const el = document.querySelector("[data-sonner-toaster]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // The library writes the offset onto the island as its own custom
    // properties; the header is `h-16`, so the top offset clears it.
    expect(island.style.getPropertyValue("--offset-top")).toBe(
      TOASTER_OFFSET.top,
    );
    expect(TOASTER_OFFSET.top).toContain("4rem");
    // AND THE NARROW VIEWPORT, which the library positions from its OWN
    // property: under 600px its stylesheet reads `--mobile-offset-top` and
    // ignores `--offset-top` entirely, so an island that cleared the header
    // band on a wide viewport opened back inside it on a narrow one until this
    // second offset was handed over too.
    expect(island.style.getPropertyValue("--mobile-offset-top")).toBe(
      TOASTER_MOBILE_OFFSET.top,
    );
    expect(TOASTER_MOBILE_OFFSET.top).toContain("4rem");
  });
});
