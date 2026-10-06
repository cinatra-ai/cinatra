// @vitest-environment jsdom
import "@/components/__tests__/access-picker-jsdom-shims";
import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// The sole external boundary in these DOM tests: the same server calls the
// production page uses. The fixture supplies its own scoped data boundary.
const realActions = vi.hoisted(() => ({
  searchScopeAssignableSkillsAction: vi.fn(),
  assignScopeSkillAction: vi.fn(),
  removeScopeSkillAction: vi.fn(),
  searchScopeContextArtifactsAction: vi.fn(),
  assignScopeContextArtifactAction: vi.fn(),
  removeScopeContextArtifactAction: vi.fn(),
  reorderScopeContextArtifactsAction: vi.fn(),
}));
vi.mock("@/lib/scope-assignment/scope-assignment-actions", () => realActions);

import { ScopeAssignmentPage } from "@/components/scope-assignment/scope-assignment-page";

const fixture = () => {
  const file = "../scope-assignment-skills-fixture";
  return import(/* @vite-ignore */ file) as Promise<typeof import("../scope-assignment-skills-fixture")>;
};
const provider = () => {
  const file = "@/components/scope-assignment/scope-assignment-skill-actions";
  return import(/* @vite-ignore */ file) as Promise<typeof import("@/components/scope-assignment/scope-assignment-skill-actions")>;
};
const repo = path.resolve(__dirname, "../../../../..");
const source = (file: string) => readFileSync(path.join(repo, file), "utf8");

beforeEach(() => {
  vi.resetAllMocks();
  realActions.searchScopeAssignableSkillsAction.mockResolvedValue({
    ok: true,
    results: [{ skillId: "sk_default", skillName: "Default server skill", displayName: "Server package", vendorName: null, status: "active" }],
    hasMore: false,
  });
  realActions.assignScopeSkillAction.mockResolvedValue({ ok: true });
  realActions.removeScopeSkillAction.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("agent-assignment-skills conformance", () => {
  it("registers the driver and real-page fixture on the existing harness", () => {
    expect(source("tests/e2e/design/conformance/contract.ts")).toContain('"agent-assignment-skills": AGENT_ASSIGNMENT_SKILLS_DRIVER');
    expect(source("src/app/design-fixtures/conformance/page.tsx")).toContain("<ScopeAssignmentSkillsConformanceFixture");
    // Adding coverage must never buy a new exemption.
    const allowlist = JSON.parse(source("tests/e2e/design/conformance/allowlist.json"));
    expect(allowlist.allow.filter((entry: { surface: string }) => entry.surface === "agent-assignment-skills")).toEqual([]);
  });

  it("answers every field/action/state declared by Extensions 0.15.5", async () => {
    const file = "../../../../../tests/e2e/design/conformance/scope-assignment-skills-driver";
    const { AGENT_ASSIGNMENT_SKILLS_DRIVER: driver } = await import(/* @vite-ignore */ file) as typeof import("../../../../../tests/e2e/design/conformance/scope-assignment-skills-driver");
    expect(driver.path).toBe("/design-fixtures/conformance");
    expect(Object.entries(driver.fields).map(([field, value]) => [field, value.source])).toEqual([["scope-label", "scope.label"]]);
    expect(Object.entries(driver.actions).map(([action, value]) => [action, Array.isArray(value) ? value.map((entry) => entry.outcome) : value.outcome])).toEqual([
      ["search-skills", "matching-skills-shown"],
      ["remove-skill", "skill-unassigned"],
    ]);
    expect(Object.keys(driver.states)).toEqual(["kind:agent"]);
  });

  it("mounts the real page with the resolved scope and chosen rows", async () => {
    const { ScopeAssignmentSkillsConformanceFixture, SCOPE_SKILLS_MODEL } = await fixture();
    const { container } = render(<ScopeAssignmentSkillsConformanceFixture />);
    const mount = container.querySelector('[data-surface-id="agent-assignment-skills"]')!;
    const page = within(mount as HTMLElement).getByTestId("scope-assignment-page");
    expect(page.getAttribute("data-surface")).toBe("agent");
    expect(page.querySelector('[data-slot="scope-assignment-scope"]')?.textContent).toBe(SCOPE_SKILLS_MODEL.scopeLabel);
    expect(within(page).getByRole("heading", { name: SCOPE_SKILLS_MODEL.displayName })).toBeTruthy();
    expect(page.querySelectorAll('[data-slot="scope-skills-row"]')).toHaveLength(2);
    expect(within(page).getByRole("tab", { name: "Skills" }).getAttribute("aria-selected")).toBe("true");
    expect(source("src/app/design-fixtures/conformance/scope-assignment-skills-fixture.tsx")).toContain("<ScopeAssignmentPage");
    expect(realActions.searchScopeAssignableSkillsAction).not.toHaveBeenCalled();
  });

  it("searches through the shipped typeahead, excludes chosen skills and narrows real options", async () => {
    const { ScopeAssignmentSkillsConformanceFixture } = await fixture();
    render(<ScopeAssignmentSkillsConformanceFixture />);
    const input = screen.getByRole("combobox");
    fireEvent.click(input);
    await screen.findByRole("option", { name: /Market Analysis/ });
    expect(screen.queryByRole("option", { name: /Blog Writing/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Company Research/ })).toBeNull();
    fireEvent.change(input, { target: { value: "market" } });
    await waitFor(() => expect(screen.queryByRole("option", { name: /Budget Planning/ })).toBeNull());
    const match = screen.getByRole("option", { name: /Market Analysis/ });
    expect(match.textContent).toContain("Market Toolkit · by Northstar");
    fireEvent.click(match);
    await waitFor(() => expect(document.querySelectorAll('[data-slot="scope-skills-row"]')).toHaveLength(3));
    expect(document.querySelector('[data-slot="scope-skills-count"]')?.textContent).toContain("3 of 5 skills chosen");
    expect(document.querySelector('[data-skill-id="sk_market"]')?.getAttribute("data-status")).toBe("ok");
    expect(realActions.assignScopeSkillAction).not.toHaveBeenCalled();
  });

  it("unassigns only the clicked skill through the product's remove control", async () => {
    const { ScopeAssignmentSkillsConformanceFixture } = await fixture();
    render(<ScopeAssignmentSkillsConformanceFixture />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Blog Writing" }));
    await waitFor(() => expect(document.querySelector('[data-skill-id="sk_blog"]')).toBeNull());
    expect(document.querySelector('[data-skill-id="sk_research"]')?.textContent).toContain("Company Research");
    expect(document.querySelector('[data-slot="scope-skills-count"]')?.textContent).toContain("1 of 5 skills chosen");
    expect(realActions.removeScopeSkillAction).not.toHaveBeenCalled();
  });

  it("the fixture boundary refuses a different scope/package and searches with pagination", async () => {
    const { createScopeSkillsFixtureActions, SCOPE_SKILLS_MODEL } = await fixture();
    const actions = createScopeSkillsFixtureActions();
    const target = SCOPE_SKILLS_MODEL.target;
    const page = { offset: 0, limit: 1 };
    expect(await actions.searchScopeAssignableSkillsAction({ ...target, scope: { kind: "team", id: "another-team" } }, "", page)).toEqual({ ok: false, reason: "scope-not-on-this-page" });
    expect(await actions.removeScopeSkillAction({ ...target, name: "another-agent" }, "sk_blog")).toEqual({ ok: false, reason: "scope-not-on-this-page" });
    expect(await actions.assignScopeSkillAction({ ...target, section: { kind: "workspace" } }, "sk_market")).toEqual({ ok: false, reason: "scope-not-on-this-page" });
    expect(await actions.searchScopeAssignableSkillsAction(target, "", page)).toMatchObject({ ok: true, hasMore: true, results: [{ skillId: "sk_market" }] });
    expect(await actions.searchScopeAssignableSkillsAction(target, "", { offset: 1, limit: 1 })).toMatchObject({ ok: true, hasMore: false, results: [{ skillId: "sk_budget" }] });
    expect(await actions.removeScopeSkillAction(target, "sk_blog")).toEqual({ ok: true });
    expect(await actions.searchScopeAssignableSkillsAction(target, "blog", { offset: 0, limit: 20 })).toMatchObject({ ok: true, results: [{ skillId: "sk_blog" }] });
  });

  it("preserves the production server-action default for search, assignment and removal", async () => {
    const { SCOPE_SKILLS_MODEL } = await fixture();
    render(<ScopeAssignmentPage model={SCOPE_SKILLS_MODEL} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "default" } });
    fireEvent.click(await screen.findByRole("option", { name: /Default server skill/ }));
    await waitFor(() => expect(realActions.assignScopeSkillAction).toHaveBeenCalledWith(SCOPE_SKILLS_MODEL.target, "sk_default"));
    expect(realActions.searchScopeAssignableSkillsAction).toHaveBeenCalledWith(SCOPE_SKILLS_MODEL.target, "default", { offset: 0, limit: 20 });
    fireEvent.click(screen.getByRole("button", { name: "Remove Blog Writing" }));
    await waitFor(() => expect(realActions.removeScopeSkillAction).toHaveBeenCalledWith(SCOPE_SKILLS_MODEL.target, "sk_blog"));
    await waitFor(() => expect(document.querySelector('[data-skill-id="sk_blog"]')).toBeNull());
  });

  it("retains the chosen row and the product's refusal when the boundary rejects removal", async () => {
    const { SCOPE_SKILLS_MODEL, createScopeSkillsFixtureActions } = await fixture();
    const { ScopeAssignmentSkillActionsProvider } = await provider();
    const actions = { ...createScopeSkillsFixtureActions(), removeScopeSkillAction: vi.fn().mockResolvedValue({ ok: false, reason: "not-a-team-admin" }) };
    render(<ScopeAssignmentSkillActionsProvider actions={actions}><ScopeAssignmentPage model={SCOPE_SKILLS_MODEL} /></ScopeAssignmentSkillActionsProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Remove Blog Writing" }));
    const error = await screen.findByRole("alert");
    expect(error.textContent).toContain("Couldn't remove Blog Writing");
    expect(error.textContent).toContain("Nothing was changed");
    expect(document.querySelectorAll('[data-slot="scope-skills-row"]')).toHaveLength(2);
    expect(actions.removeScopeSkillAction).toHaveBeenCalledWith(SCOPE_SKILLS_MODEL.target, "sk_blog");
  });
});
