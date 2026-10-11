// @vitest-environment jsdom
import "@/components/__tests__/access-picker-jsdom-shims";
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";

// Read-only transport boundary, never a component/presentation substitute.
vi.mock("@/lib/marketplace-detail-actions", () => ({
  getAgentMarketplaceDetailAction: () => { throw new Error("Fixture must use its own read-only detail port"); },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/design-fixtures/conformance", useRouter: () => { throw new Error("No navigation expected in static native fixture"); } }));

import type { MissingAgentDependency } from "../../../../../packages/agents/src/runtime-install-gate";
import { scopeSurfaceTabHrefs } from "@/lib/scope-surfaces";
import { AgentAllCard } from "@/components/extensions/agent-all-card";
import { RunStartRefusedPanel } from "../../../../../packages/agents/src/run-start-refused-panel";
import { AgentRunEligibilityFixtures } from "../agent-run-eligibility-fixtures";
import { RUN_ELIGIBILITY_AGENT as agent, RUN_ELIGIBILITY_MISSING as missing, runEligibilityCardRow } from "../agent-run-eligibility-fixture-data";

afterEach(cleanup);
const repo = path.resolve(__dirname, "../../../../..");
const source = (file: string) => readFileSync(path.join(repo, file), "utf8");

function panel(administrator: boolean, dependencies: readonly MissingAgentDependency[] = missing.slice(0, 1)) {
  return render(<RunStartRefusedPanel agentName={agent.name} missing={dependencies} requirementsHref={administrator ? agent.listingHref : null} agentsHref={agent.agentsHref} crumbEntries={[]} />);
}

describe("approved Extensions IV.1–2 real-component fixtures", () => {
  it("uses the actual workspace Agents tab address for the refusal recourse", () => {
    expect(agent.agentsHref).toBe(scopeSurfaceTabHrefs({ kind: "workspace" }).agentsHref);
    expect(agent.agentsHref).toBe("/workspace/agents");
  });
  it("mounts both new surfaces on the existing required harness", () => {
    expect(source("src/app/design-fixtures/conformance/page.tsx")).toContain("<AgentRunEligibilityFixtures");
  });
  it("registers both drivers without buying an allowlist exception", () => {
    const contract = source("tests/e2e/design/conformance/contract.ts");
    expect(contract).toContain('"agent-card-cannot-run": AGENT_CARD_CANNOT_RUN_DRIVER');
    expect(contract).toContain('"agent-start-refused": AGENT_START_REFUSED_DRIVER');
    const allow = JSON.parse(source("tests/e2e/design/conformance/allowlist.json")).allow;
    expect(allow.filter((entry: { surface: string }) => ["agent-card-cannot-run", "agent-start-refused"].includes(entry.surface))).toEqual([]);
  });
  it("actual driver entries cover every declared field, outcome, and state in the approved manifest", async () => {
    const { SURFACE_DRIVERS } = await import("../../../../../tests/e2e/design/conformance/contract");
    const manifest = JSON.parse(source("tests/e2e/design/conformance/manifests/app-extensions.json"));
    for (const id of ["agent-card-cannot-run", "agent-start-refused"]) {
      const surface = manifest.surfaces.find((entry: { id: string }) => entry.id === id);
      expect(surface).toBeDefined();
      const driver = SURFACE_DRIVERS[id];
      expect(driver.path).toBe("/design-fixtures/conformance");
      for (const field of surface.fields) expect(driver.fields[field.field].source).toBe(field.source);
      for (const action of surface.actions) {
        const entries = [driver.actions[action.action]].flat();
        expect(entries.some((entry) => entry.outcome === action.outcome && typeof entry.run === "function")).toBe(true);
      }
      for (const state of surface.states) expect(typeof driver.states[state]).toBe("function");
    }
  });
  it("draws both reader variants from the same real card and refusal panel", () => {
    const { container } = render(<AgentRunEligibilityFixtures />);
    for (const id of ["agent-card-cannot-run", "agent-start-refused"]) {
      const root = container.querySelector(`[data-surface-id="${id}"]`)!;
      expect(root.querySelectorAll("[data-reader]")).toHaveLength(2);
      expect(within(root as HTMLElement).queryByRole("link", { name: /^Run$/ })).toBeNull();
    }
  });
  for (const reader of ["administrator", "member"] as const) {
    it(`${reader} card withholds the run address and play icon, retaining normal card links`, () => {
      const row = runEligibilityCardRow(reader);
      const { container } = render(<AgentAllCard row={row} loadDetail={async () => ({ ok: false, reason: "not_found" })} />);
      expect(container.querySelector(`a[href="${agent.runHref}"]`)).toBeNull();
      expect(container.querySelector('[data-icon="inline-start"]')).toBeNull();
      expect(within(container).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(agent.settingsHref);
      expect(within(container).getByText("More details", { exact: true })).toBeTruthy();
      expect(container.querySelector("[data-archived]")).toBeNull();
      if (reader === "administrator") {
        const requirements = within(container).getByRole("link", { name: row.unavailable!.ctaAriaLabel });
        expect(requirements.getAttribute("href")).toBe(agent.listingHref);
        expect(requirements.getAttribute("title")).toBe(row.unavailable!.reason);
        expect(requirements.className).toContain("border");
      } else {
        expect(within(container).queryByText("View requirements", { exact: true })).toBeNull();
        expect(within(container).getByText("Unavailable").getAttribute("title")).toBe(row.unavailable!.reason);
        expect(container.querySelector('a[href^="/configuration"]')).toBeNull();
      }
    });
    it(`${reader} refusal states the declared dependency and reachable recourse, never a run`, () => {
      const { container } = panel(reader === "administrator");
      const alert = within(container).getByRole("alert");
      expect(alert.textContent).toContain(`${agent.name} can't start`);
      expect(alert.textContent).toContain(missing[0].displayName);
      expect(alert.textContent).toContain(missing[0].packageName);
      expect(alert.querySelector(".font-mono")?.textContent).toBe(missing[0].packageName);
      expect(alert.textContent).not.toContain("not found");
      expect(within(container).queryByRole("link", { name: /^Run$/ })).toBeNull();
      expect(within(container).getByRole("link", { name: "Back to Agents" }).getAttribute("href")).toBe(agent.agentsHref);
      if (reader === "administrator") {
        expect(within(container).getByRole("link", { name: "View requirements" }).getAttribute("href")).toBe(agent.listingHref);
        expect(alert.textContent).toContain("Install it from the marketplace, then start the agent again.");
      } else {
        expect(within(container).queryByRole("link", { name: "View requirements" })).toBeNull();
        expect(alert.textContent).toContain("Ask a platform administrator to install it, then start the agent again.");
      }
    });
  }
  it.each(["agent-card-cannot-run", "agent-start-refused"])("dispatches the real administrator requirements Link on %s to the fixture navigation port", (id) => {
    const { container } = render(<AgentRunEligibilityFixtures />);
    const root = container.querySelector(`[data-surface-id="${id}"] [data-reader="administrator"]`)! as HTMLElement;
    const link = within(root).getByRole("link", { name: /View requirements/ });
    expect(link.getAttribute("href")).toBe(agent.listingHref);
    expect(fireEvent.click(link)).toBe(false); // consumed only at the navigation boundary
    expect(root.dataset.outcome).toBe("agent-listing-open");
    expect(root.dataset.destination).toBe(agent.listingHref);
  });
  it.each(["administrator", "member"])("dispatches %s Back to Agents to the actual scoped tab port", (reader) => {
    const { container } = render(<AgentRunEligibilityFixtures />);
    const root = container.querySelector(`[data-surface-id="agent-start-refused"] [data-reader="${reader}"]`)! as HTMLElement;
    fireEvent.click(within(root).getByRole("link", { name: "Back to Agents" }));
    expect(root.dataset.outcome).toBe("scope-agents-tab");
    expect(root.dataset.destination).toBe(scopeSurfaceTabHrefs({ kind: "workspace" }).agentsHref);
  });
  it("does not invent a member requirements dispatch or admit a different address", () => {
    const { container } = render(<AgentRunEligibilityFixtures />);
    const member = container.querySelector('[data-surface-id="agent-start-refused"] [data-reader="member"]')! as HTMLElement;
    expect(within(member).queryByRole("link", { name: "View requirements" })).toBeNull();
    fireEvent.click(within(member).getByText(missing[0].displayName!));
    expect(member.dataset.outcome).toBe("idle");
    const admin = container.querySelector('[data-surface-id="agent-start-refused"] [data-reader="administrator"]')! as HTMLElement;
    const link = within(admin).getByRole("link", { name: "View requirements" });
    link.setAttribute("href", "#wrong-agent");
    expect(fireEvent.click(link)).toBe(true);
    expect(admin.dataset.outcome).toBe("idle");
    expect(admin.dataset.destination).toBe("");
  });
  it("leaves unrelated Settings and the actual More details modal outside the navigation port", () => {
    const { container } = render(<AgentRunEligibilityFixtures />);
    const member = container.querySelector('[data-surface-id="agent-card-cannot-run"] [data-reader="member"]')! as HTMLElement;
    const settings = within(member).getByRole("link", { name: "Settings" });
    expect(settings.getAttribute("href")).toBe(agent.settingsHref);
    settings.setAttribute("href", "#settings-native-control");
    expect(fireEvent.click(settings)).toBe(true);
    expect(member.dataset.outcome).toBe("idle");
    fireEvent.click(within(member).getByText("More details", { exact: true }));
    expect(container.ownerDocument.querySelector('[role="dialog"]')).not.toBeNull();
    expect(member.dataset.outcome).toBe("idle");
  });
  it("names every missing dependency and uses the plural recourse", () => {
    const { container } = panel(true, missing);
    for (const dependency of missing) {
      expect(container.textContent).toContain(dependency.displayName);
      expect(container.textContent).toContain(dependency.packageName);
    }
    expect(container.textContent).toContain("are not installed");
    expect(container.textContent).toContain("Install them");
  });
  it("falls back to the declared package identifier when no display name exists", () => {
    const dependency = { ...missing[0], displayName: null };
    const { container } = panel(false, [dependency]);
    expect(container.querySelector("b")?.textContent).toBe(dependency.packageName);
  });
  it("returns the actual Run action when all required dependencies are installed", () => {
    const { container } = render(<AgentAllCard row={runEligibilityCardRow("member", [])} />);
    expect(within(container).getByRole("link", { name: /^Run$/ }).getAttribute("href")).toBe(agent.runHref);
    expect(container.querySelector('[data-icon="inline-start"]')).not.toBeNull();
    expect(within(container).queryByText("Unavailable")).toBeNull();
  });
});
