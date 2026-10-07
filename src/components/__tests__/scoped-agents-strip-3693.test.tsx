// @vitest-environment jsdom
/**
 * THE AGENTS TAB OF EVERY SCOPE CARRIES ITS OWN STRIP (cinatra#3693).
 *
 * The owner's decision on cinatra#3693: "Each scope carries an **Executions**
 * tab that lists that scope's runs. There is **no dedicated Reviews page**
 * anywhere", and "the product legs of this issue then implement the scoped
 * Executions tab". The ratified drawing, the entity page's tablist: "The Agents
 * tab of every scope carries its own strip, All Agents | Executions".
 *
 * A1 — the Agents tab of each of the five scopes draws All Agents and
 *      Executions, each href under that scope base, All Agents selected, in the
 *      rows and in the empty state alike.
 *
 * The bare strip stays exactly what it was for a reader with no scope.
 */
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));

import { ScopeSurfacePage } from "@/components/scope-surface-page";
import { AgentsTabNav } from "@/components/agents-tab-nav";
import { scopeSurfaceBase, type ScopeSurfaceRef } from "@/lib/scope-surfaces";

const SCOPES: ReadonlyArray<ScopeSurfaceRef> = [
  { kind: "workspace" },
  { kind: "personal" },
  { kind: "organization", id: "o1" },
  { kind: "team", id: "t1" },
  { kind: "project", id: "p1" },
];

const STRIP = '[data-slot="agents-tab-nav"]';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The strip's tabs, as the reader meets them: label, address, selection. */
function stripTabs(container: Element): Array<[string, string | null, string | null]> {
  const strip = container.querySelector(STRIP);
  if (!strip) return [];
  return Array.from(strip.querySelectorAll("a")).map((a) => [
    a.textContent ?? "",
    a.getAttribute("href"),
    a.getAttribute("data-state"),
  ]);
}

describe("A1: the scope's Agents tab draws All Agents | Executions under its own base (cinatra#3693)", () => {
  for (const scope of SCOPES) {
    const base = scopeSurfaceBase(scope);
    for (const [reading, body] of [
      ["the rows", createElement("section", { "data-testid": "rows-stub" })],
      ["the empty state", undefined],
    ] as const) {
      it(`${base}/agents — in ${reading}, All Agents selected`, () => {
        const { container } = render(<ScopeSurfacePage scope={scope} tab="agents" body={body} />);
        expect(container.querySelectorAll(STRIP)).toHaveLength(1);
        expect(stripTabs(container)).toEqual([
          ["All Agents", `${base}/agents`, "active"],
          ["Executions", `${base}/agents/executions`, "inactive"],
        ]);
      });
    }

    it(`${base}/agents/executions — the same strip with Executions selected`, () => {
      const { container } = render(
        <ScopeSurfacePage scope={scope} tab="agents" agentsTab="executions" body={<div />} />,
      );
      expect(stripTabs(container)).toEqual([
        ["All Agents", `${base}/agents`, "inactive"],
        ["Executions", `${base}/agents/executions`, "active"],
      ]);
    });
  }

  it("draws the strip on the Agents tab only — the scope's other tabs carry none", () => {
    for (const tab of ["assistants", "artifacts", "skills"] as const) {
      const { container } = render(<ScopeSurfacePage scope={{ kind: "workspace" }} tab={tab} />);
      expect(container.querySelector(STRIP)).toBeNull();
      cleanup();
    }
  });

  it("the bare strip draws the same two tabs at the root, and no Reviews", () => {
    const { container } = render(<AgentsTabNav activeTab="all" />);
    expect(stripTabs(container)).toEqual([
      ["All Agents", "/agents", "active"],
      ["Executions", "/agents/executions", "inactive"],
    ]);
  });

  it("a strip handed no base is byte for byte the bare strip", () => {
    expect(renderToStaticMarkup(<AgentsTabNav activeTab="executions" scopeBase={null} />)).toBe(
      renderToStaticMarkup(<AgentsTabNav activeTab="executions" />),
    );
  });
});
