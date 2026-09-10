/**
 * AgentInstanceNav — the single-agent detail view's tab strip (cinatra#2487).
 *
 * Governing spec: Application Design — Agents §I (design spec
 * `specs/app-agents.html` @ c669997bfb335a0db8ff66ba11d4f228825abdf5) — the strip
 * is part of the constant frame: "selecting a different tab changes the body and
 * nothing else … the tab strip keeps its left edge, and the etched rule keeps
 * its right edge." The rule beside the strip is a `1fr` grid track that starts
 * to the RIGHT of the last tab, so a tab appearing or disappearing between
 * routes moves both the remaining triggers and the rule's start point.
 *
 * The invariant this file locks: the strip's contents are a pure function of
 * `showTriggerTab` and are INDEPENDENT of `activeTab`. Regression guarded:
 * an earlier revision of this fix added a `showTriggerTab || activeTab ===
 * "trigger"` fallback, which re-introduced exactly the shift — /trigger showed
 * a tab that /setup and /permissions hid for the same run.
 *
 *   pnpm test:root -- src/components/__tests__/agent-instance-nav.test.tsx
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentInstanceNav } from "../agent-instance-nav";
import type { AgentInstanceNavProps } from "../agent-instance-nav";

type Tab = AgentInstanceNavProps["activeTab"];

/** Every tab a route can mount this strip on. */
const ROUTE_TABS: Tab[] = ["setup", "trigger", "permissions"];

function render(activeTab: Tab, showTriggerTab: boolean): string {
  return renderToStaticMarkup(
    <AgentInstanceNav
      agentId="acme/blog-pipeline-agent"
      instanceId="run-1"
      activeTab={activeTab}
      showTriggerTab={showTriggerTab}
    />,
  );
}

/** The set of trigger labels the strip renders, order preserved. */
function tabLabels(html: string): string[] {
  return ["Setup", "Schedule", "Permissions"].filter((label) =>
    html.includes(`>${label}<`),
  );
}

describe("AgentInstanceNav — the strip is part of the constant frame (§I)", () => {
  for (const showTriggerTab of [true, false]) {
    it(`renders an IDENTICAL tab set on every route when showTriggerTab=${showTriggerTab}`, () => {
      const sets = ROUTE_TABS.map((tab) => tabLabels(render(tab, showTriggerTab)));
      for (const [i, set] of sets.entries()) {
        expect(set, `activeTab=${ROUTE_TABS[i]}`).toEqual(sets[0]);
      }
      expect(new Set(sets.map((s) => s.join("|"))).size).toBe(1);
    });
  }

  // cinatra#3004 renamed the tab to what it shows — the schedule form, in the
  // state this run's schedule is in. The route is unchanged; the word is not.
  it("shows Setup + Schedule + Permissions for a scheduled/recurring run", () => {
    expect(tabLabels(render("setup", true))).toEqual([
      "Setup",
      "Schedule",
      "Permissions",
    ]);
    expect(render("setup", true)).not.toContain(">Trigger<");
  });

  it("shows Setup + Permissions only when there is no persistent trigger", () => {
    expect(tabLabels(render("setup", false))).toEqual(["Setup", "Permissions"]);
  });

  it("does NOT force the schedule tab into the strip just because /trigger is active", () => {
    // The regression this locks: `showTriggerTab || activeTab === "trigger"`.
    expect(tabLabels(render("trigger", false))).toEqual(["Setup", "Permissions"]);
    expect(tabLabels(render("trigger", false))).toEqual(
      tabLabels(render("permissions", false)),
    );
  });

  // A STEP IN THE FRAME LIGHTS NOTHING (cinatra#3182 item 8, cinatra#3168).
  // Application Design — Agents: "A step drawn inside this frame never lights a
  // tab the strip does not carry."
  it("lights no tab at all for the 'none' reading, and keeps the same strip", () => {
    for (const showTriggerTab of [true, false]) {
      const html = render("none", showTriggerTab);
      expect(html).not.toContain('data-state="active"');
      // The strip itself is untouched — the frame is constant either way.
      expect(tabLabels(html)).toEqual(tabLabels(render("setup", showTriggerTab)));
    }
  });

  it("never renders an Overview trigger — the dead tab is gone (#2487)", () => {
    for (const tab of ROUTE_TABS) {
      for (const show of [true, false]) {
        expect(render(tab, show)).not.toContain(">Overview<");
      }
    }
  });

  it("marks the active tab selected and encodes a vendor/package agentId", () => {
    const html = render("permissions", true);
    // The vendor slash stays a PATH SEPARATOR (each segment encoded separately).
    expect(html).toContain("/agents/acme/blog-pipeline-agent/run-1/permissions");

    // Radix marks the matching trigger active from the controlled `value`.
    // `asChild` puts that state on the <a> itself — read each anchor's own tag.
    const stateOf = (label: string): string | undefined => {
      const tag = new RegExp(`<a\\b[^>]*>(?=${label}</a>)`).exec(html)?.[0];
      return /data-state="(\w+)"/.exec(tag ?? "")?.[1];
    };
    expect(stateOf("Permissions")).toBe("active");
    expect(stateOf("Setup")).toBe("inactive");
    expect(stateOf("Schedule")).toBe("inactive");
  });
});
