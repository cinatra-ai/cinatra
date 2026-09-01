// @vitest-environment jsdom
//
// cinatra#2807 (per-scope surfaces S1) — the shared shell's EMPTY STATE reads
// the system's Empty state pattern.
//
// The ratified drawing's Empty state block gives the pattern as "centred /
// dashed circle icon / 14px headline · 12px helper / primary action" and rules:
// "Use whenever a list, table, or section has zero content. Always include a
// single primary action button — never just empty text."
//
// The first proof round measured three departures in this ONE shared shell,
// which renders the body of every scoped tab route: no primary action button,
// no dashed-circle icon, and a full-stage dashed-border container the drawing
// does not give. This file holds the shell to the pattern instead.
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));

import { ScopeSurfacePage } from "@/components/scope-surface-page";
import {
  SCOPE_SURFACE_TABS,
  scopeSurfaceEmptyTestId,
  type ScopeSurfaceRef,
  type ScopeSurfaceTab,
} from "@/lib/scope-surfaces";

const SCOPES: ReadonlyArray<readonly [string, ScopeSurfaceRef]> = [
  ["workspace", { kind: "workspace" }],
  ["personal", { kind: "personal" }],
  ["project", { kind: "project", id: "p1" }],
  ["team", { kind: "team", id: "t1" }],
  ["organization", { kind: "organization", id: "o1" }],
];

/** The one primary action each tab carries, by the href it leads to. */
const ACTION_HREF: Record<ScopeSurfaceTab, string> = {
  assistants: "/assistants",
  agents: "/agents",
  artifacts: "/artifacts",
  skills: "/skills",
};

/** The label that action carries, held here as an independent oracle. */
const ACTION_LABEL: Record<ScopeSurfaceTab, string> = {
  assistants: "Go to Assistants",
  agents: "Go to Agents",
  artifacts: "Go to Artifacts",
  skills: "Go to Skills",
};

// The FOUR scoped tabs only. The drawing names them: "While one of the four
// scoped tabs - Assistants, Agents, Artifacts, Skills - holds nothing to list,
// it reads as the Empty state of Components and nothing else". The Dashboards
// tab is given its own body and its own empty reading by the Dashboards tab
// section, and is asserted in the route-matrix suite.
const TABS = SCOPE_SURFACE_TABS;

afterEach(cleanup);

describe("the shared scope-surface empty state reads the system Empty state pattern (#2807)", () => {
  for (const [scopeName, scope] of SCOPES) {
    for (const tab of TABS) {
      describe(`${scopeName} / ${tab}`, () => {
        const surface = () => {
          render(<ScopeSurfacePage scope={scope} tab={tab} />);
          return screen.getByTestId(scopeSurfaceEmptyTestId(tab));
        };

        it("is the shared Empty component, not a variant of its own", () => {
          expect(surface().getAttribute("data-slot")).toBe("empty");
        });

        it("carries the pattern's dashed-circle icon", () => {
          const icon = surface().querySelector(
            '[data-slot="empty-icon"][data-variant="icon"]',
          );
          expect(icon).toBeTruthy();
          expect(icon!.querySelector("svg")).toBeTruthy();
        });

        it("carries the pattern's headline and helper", () => {
          const el = surface();
          expect(el.querySelector('[data-slot="empty-title"]')).toBeTruthy();
          expect(el.querySelector('[data-slot="empty-description"]')).toBeTruthy();
        });

        it("carries exactly ONE primary action, never just empty text", () => {
          const actions = surface().querySelectorAll("a, button");
          expect(actions.length).toBe(1);
          const action = actions[0]!;
          expect(action.getAttribute("href")).toBe(ACTION_HREF[tab]);
          expect(action.textContent?.trim()).toBe(ACTION_LABEL[tab]);
        });

        // The action must be the system's own primary button, not a bare link
        // and not a quieter variant: the pattern gives ONE primary action
        // button.
        it("renders that action as the shared primary Button", () => {
          const action = surface().querySelector("a, button")!;
          expect(action.getAttribute("data-slot")).toBe("button");
          expect(action.getAttribute("data-variant")).toBe("default");
        });

        // Rejects every border WIDTH utility, not only the bare `border`
        // token, so `border-2` or an arbitrary width cannot bring the
        // unspecified full-stage rectangle back. `border-dashed` is a style,
        // not a width: it belongs to the shared primitive and stays.
        it("draws no dashed-border container around the whole stage", () => {
          const classes = (surface().getAttribute("class") ?? "").split(/\s+/);
          expect(
            classes.filter((c) => /^border(-\d+|-\[[^\]]*\])?$/.test(c)),
          ).toEqual([]);
        });

        // The pattern is "centred"; these are the shared primitive's own
        // centring classes, asserted so a later override cannot quietly
        // left-align the stage.
        it("stays centred, as the pattern gives it", () => {
          const classes = (surface().getAttribute("class") ?? "").split(/\s+/);
          for (const centring of ["items-center", "justify-center", "text-center"]) {
            expect(classes).toContain(centring);
          }
        });
      });
    }
  }
});
