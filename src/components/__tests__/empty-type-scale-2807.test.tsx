// @vitest-environment jsdom
//
// The system Empty state's OWN type scale (cinatra#2807, fix leg 2).
//
// The ratified drawing fixes the pattern in one line — "centred dashed circle
// icon / 14px headline · 12px helper / primary action" — and the Workspace
// section binds every scoped tab to it: the tab "reads as the Empty state of
// Components and nothing else — that pattern at its own values".
//
// The second proof round measured headline and helper at the SAME size on
// every scoped tab empty state. The size lives in the shared component, not in
// any one page, so it is fixed here once, at its source, and asserted here:
// the headline carries the 14px step and the helper the 12px step, and the two
// are never the same step.
import { createElement } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

afterEach(cleanup);

/**
 * The app's own text scale, read out of the stylesheets that DEFINE it — so the
 * assertions below are tied to real pixel values, not to a class name whose
 * meaning could drift underneath them.
 *
 * Two sheets, read in the order the app cascades them: the app's own `@theme`
 * block overrides some steps, and the framework theme it imports supplies the
 * rest. A step declared in NEITHER is a failure here rather than a hard-coded
 * guess — a guessed value would let the step move underneath this test while it
 * still went green, which is exactly what it exists to prevent.
 */
const STYLESHEETS = [
  "src/app/globals.css",
  "node_modules/tailwindcss/theme.css",
].map((rel) => readFileSync(path.join(process.cwd(), rel), "utf8"));

function stepPx(token: string): number {
  for (const sheet of STYLESHEETS) {
    const declared = new RegExp(`--${token}:\\s*([0-9.]+)rem`).exec(sheet);
    if (declared) return Number(declared[1]) * 16;
  }
  throw new Error(
    `no --${token} step is declared in any stylesheet this app loads`,
  );
}

function classesOf(slot: string): string[] {
  const el = document.querySelector(`[data-slot="${slot}"]`)!;
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** The step a class list carries, e.g. `text-sm` out of `text-sm/relaxed`. */
function stepOf(classes: string[]): string | null {
  for (const c of classes) {
    const m = /^text-(xs|sm|base|lg|xl)(\/[\w.-]+)?$/.exec(c);
    if (m) return `text-${m[1]}`;
  }
  return null;
}

describe("the shared Empty state carries the drawing's own two type steps (#2807)", () => {
  const mount = () =>
    render(
      createElement(
        Empty,
        null,
        createElement(
          EmptyHeader,
          null,
          createElement(EmptyTitle, null, "No runs yet."),
          createElement(
            EmptyDescription,
            null,
            "Roll a campaign to see runs here.",
          ),
        ),
      ),
    );

  it("sets the headline at the drawing's 14px step", () => {
    mount();
    expect(screen.getByText("No runs yet.")).toBeTruthy();
    const step = stepOf(classesOf("empty-title"));
    expect(step).not.toBeNull();
    expect(stepPx(step!)).toBe(14);
  });

  it("sets the helper at the drawing's 12px step", () => {
    mount();
    const step = stepOf(classesOf("empty-description"));
    expect(step).not.toBeNull();
    expect(stepPx(step!)).toBe(12);
  });

  it("never renders the headline and the helper at the same step", () => {
    mount();
    const headline = stepOf(classesOf("empty-title"));
    const helper = stepOf(classesOf("empty-description"));
    expect(headline).not.toBe(helper);
    expect(stepPx(headline!) - stepPx(helper!)).toBe(2);
  });
});
