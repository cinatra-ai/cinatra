// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// Measure shared component use without replacing its icon or markup.
const sharedSpinner = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/button")>();
  return {
    ...actual,
    Spinner: (props: React.ComponentProps<typeof actual.Spinner>) => {
      sharedSpinner(props);
      return <actual.Spinner {...props} />;
    },
  };
});

import { ReviewGatePlaceholder } from "../review-gate-states";

const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';
const GLOBALS = readFileSync(
  path.resolve(__dirname, "../../../../src/app/globals.css"),
  "utf8",
);

beforeEach(() => {
  sharedSpinner.mockClear();
});
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark", "cinatra");
});

describe("the parked review uses the shared indigo Spinner", () => {
  it.each(["light", "dark"])("renders the real shared arc in its frame (%s)", (palette) => {
    document.documentElement.classList.add(palette === "dark" ? "dark" : "cinatra");
    const { container } = render(<ReviewGatePlaceholder framed runRef="run-3290" />);
    const frame = container.querySelector(PLACEHOLDER)!;
    expect(sharedSpinner).toHaveBeenCalledTimes(1);
    const arcs = frame.querySelectorAll("svg");
    expect(arcs).toHaveLength(1);
    const arc = arcs[0]!;
    expect(arc.querySelectorAll("path")).toHaveLength(1);
    expect(arc.querySelectorAll("circle")).toHaveLength(0);
    expect(arc.getAttribute("class")).toContain("animate-spin");
    expect(arc.getAttribute("class")).toContain("size-[22px]");
    expect(arc.getAttribute("class")).toContain("text-indigo-ink");
    expect(arc.getAttribute("class")).not.toMatch(/\btext-primary\b/);
    expect(arc.getAttribute("stroke-width")).toBe("2.4");
    expect(arc.getAttribute("aria-hidden")).toBe("true");
    expect(frame.getAttribute("aria-busy")).toBe("true");
    expect(frame.getAttribute("aria-label")).toBe("Working on run run-3290");
    expect(frame.textContent).toBe("Agentic Run Progress");
    expect(frame.querySelectorAll("button, [data-action]")).toHaveLength(0);
  });

  it("uses the registered palette-invariant indigo rather than the dark action token", () => {
    // A stylesheet/token invariant, not a jsdom computed-style claim.
    const css = GLOBALS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/--color-indigo-ink\s*:\s*var\(--indigo-ink\)/);
    const values = Array.from(css.matchAll(/--indigo-ink\s*:\s*([^;]+);/g), (m) => m[1]!.trim());
    expect(values).toEqual(["#364e81"]);
    const root = css.match(/:root\s*\{([^}]+)\}/)?.[1];
    expect(root).toMatch(/--indigo-ink\s*:\s*#364e81\s*;/);
  });

  it.each(["light", "dark"])("removes the shared arc when the wait ends (%s)", (palette) => {
    document.documentElement.classList.add(palette === "dark" ? "dark" : "cinatra");
    const { container, rerender } = render(<ReviewGatePlaceholder framed runRef="run-3290" />);
    expect(container.querySelector("svg.animate-spin")).not.toBeNull();
    expect(sharedSpinner).toHaveBeenCalledTimes(1);
    sharedSpinner.mockClear();
    rerender(<ReviewGatePlaceholder framed runRef="run-3290" settled />);
    const frame = container.querySelector(PLACEHOLDER)!;
    expect(sharedSpinner).not.toHaveBeenCalled();
    expect(frame.querySelector("svg")).toBeNull();
    expect(frame.getAttribute("aria-busy")).toBe("false");
    expect(frame.getAttribute("aria-label")).toBe("Waiting finished for run run-3290");
    expect(frame.textContent).toBe("Agentic Run Progress");
    expect(frame.querySelector(".grid")).not.toBeNull();
  });
});
