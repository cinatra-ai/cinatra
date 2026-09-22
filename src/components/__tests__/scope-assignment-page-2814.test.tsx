// @vitest-environment jsdom
/**
 * THE PER-SCOPE ASSIGNMENT PAGE'S CONTROLS (cinatra#2814, per-scope
 * assignment S2).
 *
 *   - "UI controls consume S1 resolver decisions without reproducing the
 *     policy matrix; fixtures assert controls match allow/deny decisions per
 *     scope": the page receives each section's decision from the server and
 *     renders a write control exactly where it allows;
 *   - "The Skills pane states the skill limits (5 per package/exact scope and
 *     at most 5 distinct effective assigned skills per run) and that
 *     assignments are per PACKAGE. The Artifacts pane does NOT show those
 *     limits";
 *   - "Artifacts pane fixtures: slots from the manifest; add/remove/reorder
 *     issue the correct tuple calls and SURFACE the typed refusals; empty
 *     state for slot-less agents";
 *   - assistants: no Artifacts trigger and no Artifacts render.
 *
 * Renders the REAL page over the REAL shared typeahead; only the server
 * actions are doubles, so what is asserted is what the page sends.
 */
import "@/components/__tests__/access-picker-jsdom-shims";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const actions = vi.hoisted(() => ({
  searchScopeAssignableSkillsAction: vi.fn(),
  assignScopeSkillAction: vi.fn(),
  removeScopeSkillAction: vi.fn(),
  searchScopeContextArtifactsAction: vi.fn(),
  assignScopeContextArtifactAction: vi.fn(),
  removeScopeContextArtifactAction: vi.fn(),
  reorderScopeContextArtifactsAction: vi.fn(),
}));
vi.mock("@/lib/scope-assignment/scope-assignment-actions", () => actions);

import { ScopeAssignmentPage } from "@/components/scope-assignment/scope-assignment-page";
import type {
  ScopeAssignmentPageModel,
  ScopeAssignmentSectionModel,
} from "@/lib/scope-assignment/scope-assignment-page.server";
import type { ScopeAssignmentSlotGroup } from "@/lib/scope-assignment/scope-assignment-model";

const TEAM = "team_growth";
// The fixture package is invented; its route path is built here so that no literal
// vendor/name pair reads like a repository reference.
const AGENT_VENDOR = "cinatra-ai";
const AGENT_NAME = "scope-fixture-agent";
const AGENT_PATH = `${AGENT_VENDOR}/${AGENT_NAME}`;
const ORG = "org_acme";

const SKILL_ROW = {
  skillId: "sk_blog",
  skillName: "Blog Writing",
  displayName: "Blog Skills",
  vendorName: "Cinatra",
  status: "ok" as const,
};

function section(
  overrides: Partial<ScopeAssignmentSectionModel> & Pick<ScopeAssignmentSectionModel, "scope" | "key">,
): ScopeAssignmentSectionModel {
  return {
    label: "Team · Growth",
    write: { allowed: true, road: "grant" },
    skills: [SKILL_ROW],
    slots: null,
    ...overrides,
  };
}

function model(overrides: Partial<ScopeAssignmentPageModel> = {}): ScopeAssignmentPageModel {
  const scope = overrides.routeScope ?? { kind: "team" as const, id: TEAM };
  return {
    surface: "agent",
    tab: "skills",
    routeScope: scope,
    packageName: "@cinatra-ai/scope-fixture-agent",
    displayName: "Research Agent",
    scopeLabel: "Team · Growth",
    crossScope: scope.kind === "workspace",
    target: { surface: "agent", scope, vendor: "cinatra-ai", name: "scope-fixture-agent" },
    admission: { ok: true },
    manifest: null,
    sections: [section({ scope, key: `team:${TEAM}` })],
    ...overrides,
  };
}

const BRAND: ScopeAssignmentSlotGroup = {
  slotId: "brand-voice",
  title: "Brand voice",
  takesText: "Takes a brand kit · 1 required, at most 2",
  placeholder: "Search brand kits…",
  maxItems: 2,
  rows: [
    { artifactId: "res_a", title: "Tone of Voice 2025", kindLabel: "Brand kit", status: "ok" },
    { artifactId: "res_b", title: "Brand Kit 2026", kindLabel: "Brand kit", status: "ok" },
  ],
};

const POSTS: ScopeAssignmentSlotGroup = {
  slotId: "reference-posts",
  title: "Reference posts",
  takesText: "Takes a blog post · optional, at most 3",
  placeholder: "Search blog posts…",
  maxItems: 3,
  rows: [],
};

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  actions.assignScopeSkillAction.mockResolvedValue({ ok: true });
  actions.removeScopeSkillAction.mockResolvedValue({ ok: true });
  actions.assignScopeContextArtifactAction.mockResolvedValue({ ok: true });
  actions.removeScopeContextArtifactAction.mockResolvedValue({ ok: true });
  actions.reorderScopeContextArtifactsAction.mockResolvedValue({ ok: true });
  actions.searchScopeAssignableSkillsAction.mockResolvedValue({
    ok: true,
    results: [
      { skillId: "sk_research", skillName: "Company Research", displayName: "Research Toolkit", vendorName: "Northstar", status: "active" },
    ],
    hasMore: false,
  });
  actions.searchScopeContextArtifactsAction.mockResolvedValue({
    ok: true,
    results: [{ artifactId: "res_post", title: "Launch Announcement", kindLabel: "Blog post" }],
    hasMore: false,
  });
});

afterEach(() => cleanup());

describe("the Skills pane", () => {
  it("renders the named root with the package, the scope and the Skills tab", () => {
    render(<ScopeAssignmentPage model={model()} />);
    const root = screen.getByTestId("scope-assignment-page");
    expect(root.dataset.package).toBe("@cinatra-ai/scope-fixture-agent");
    expect(root.dataset.scopeKind).toBe("team");
    expect(root.dataset.scopeId).toBe(TEAM);
    expect(root.dataset.tab).toBe("skills");
    const tabs = within(root).getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("href"))).toEqual([
      `/teams/${TEAM}/agents/${AGENT_PATH}/settings?tab=skills`,
      `/teams/${TEAM}/agents/${AGENT_PATH}/settings?tab=artifacts`,
    ]);
  });

  it("states both limits and that assignments belong to the package", () => {
    render(<ScopeAssignmentPage model={model()} />);
    const limits = document.querySelector('[data-slot="scope-assignment-skill-limits"]')!.textContent!;
    expect(limits).toContain("5 per scope here, at most 5 effective per run.");
    expect(limits).toContain("assigned to the whole package");
    expect(screen.getByText(/1 of 5 skills chosen\./)).toBeTruthy();
  });

  it("renders the chooser and remove controls where the S1 decision allows", () => {
    render(<ScopeAssignmentPage model={model()} />);
    expect(screen.getByRole("combobox")).toBeTruthy();
    expect(screen.getByLabelText("Which skills should this agent always use?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Blog Writing" })).toBeTruthy();
  });

  it("renders no write control where the S1 decision refuses, and says why", () => {
    render(
      <ScopeAssignmentPage
        model={model({
          sections: [
            section({
              scope: { kind: "team", id: TEAM },
              key: `team:${TEAM}`,
              write: { allowed: false, message: "Only an admin of this team can change these assignments." },
            }),
          ],
        })}
      />,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.getByText("Only an admin of this team can change these assignments.")).toBeTruthy();
    // The rows themselves stay readable.
    expect(screen.getByText("Blog Writing")).toBeTruthy();
  });

  it("renders no write control when S1's admission refuses the package", () => {
    render(
      <ScopeAssignmentPage
        model={model({ admission: { ok: false, message: "This package can't be given assignments." } })}
      />,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("This package can't be given assignments.")).toBeTruthy();
  });

  it("on the workspace editor, gives each scope its own decision and names each write's scope", async () => {
    const ws = { kind: "workspace" as const };
    render(
      <ScopeAssignmentPage
        model={model({
          routeScope: ws,
          crossScope: true,
          scopeLabel: "Workspace",
          target: { surface: "agent", scope: ws, vendor: "cinatra-ai", name: "scope-fixture-agent" },
          sections: [
            section({ scope: ws, key: "workspace", label: "Workspace", write: { allowed: false, message: "Only a platform admin can change the workspace assignments." }, skills: [] }),
            section({ scope: { kind: "personal" }, key: "personal", label: "Personal", skills: [] }),
            section({ scope: { kind: "organization", id: ORG }, key: `organization:${ORG}`, label: "Organization · Acme" }),
          ],
        })}
      />,
    );
    const sections = [...document.querySelectorAll('[data-slot="scope-assignment-section"]')] as HTMLElement[];
    expect(sections.map((s) => [s.dataset.scopeKey, s.querySelector('[data-slot="scope-skills"]')?.getAttribute("data-can-write")])).toEqual([
      ["workspace", "false"],
      ["personal", "true"],
      [`organization:${ORG}`, "true"],
    ]);
    expect(within(sections[0]!).getByText("Workspace", { selector: '[data-slot="scope-assignment-section-label"]' })).toBeTruthy();

    fireEvent.click(within(sections[2]!).getByRole("button", { name: "Remove Blog Writing" }));
    await waitFor(() =>
      expect(actions.removeScopeSkillAction).toHaveBeenCalledWith(
        { surface: "agent", scope: ws, vendor: "cinatra-ai", name: "scope-fixture-agent", section: { kind: "organization", id: ORG } },
        "sk_blog",
      ),
    );
  });

  it("adds a picked skill with the page's target, and rolls it back with the typed refusal", async () => {
    actions.assignScopeSkillAction.mockResolvedValue({ ok: false, reason: "not-a-team-admin" });
    render(<ScopeAssignmentPage model={model()} />);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByText("Company Research"));
    await waitFor(() =>
      expect(actions.assignScopeSkillAction).toHaveBeenCalledWith(
        { surface: "agent", scope: { kind: "team", id: TEAM }, vendor: "cinatra-ai", name: "scope-fixture-agent" },
        "sk_research",
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          "Couldn't add Company Research: only an admin of this team can change these assignments. Nothing was changed.",
        ),
      ).toBeTruthy(),
    );
    expect(document.querySelector('[data-skill-id="sk_research"]')).toBeNull();
  });

  it("is the only pane an assistant renders: no strip, no Artifacts", () => {
    const scope = { kind: "personal" as const };
    render(
      <ScopeAssignmentPage
        model={model({
          surface: "assistant",
          routeScope: scope,
          scopeLabel: "Personal",
          target: { surface: "assistant", scope, vendor: "cinatra-ai", name: "support" },
          sections: [section({ scope, key: "personal", label: "Personal", skills: [] })],
        })}
      />,
    );
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText("Artifacts")).toBeNull();
    expect(screen.queryByText("Context artifacts")).toBeNull();
    expect(screen.getByLabelText("Which skills should this assistant always use?")).toBeTruthy();
    expect(screen.getByText(/0 of 5 skills chosen\. A chosen skill reaches this assistant/)).toBeTruthy();
  });
});

describe("the Artifacts pane", () => {
  const artifacts = (overrides: Partial<ScopeAssignmentPageModel> = {}) =>
    model({
      tab: "artifacts",
      manifest: "ok",
      sections: [section({ scope: { kind: "team", id: TEAM }, key: `team:${TEAM}`, skills: null, slots: [BRAND, POSTS] })],
      ...overrides,
    });

  it("draws one group per declared slot, in the words of the context artifacts pane, with no cap line", () => {
    render(<ScopeAssignmentPage model={artifacts()} />);
    expect(screen.getByText("Context artifacts")).toBeTruthy();
    const groups = [...document.querySelectorAll('[data-slot="scope-context-slot"]')] as HTMLElement[];
    expect(groups.map((g) => g.dataset.slotId)).toEqual(["brand-voice", "reference-posts"]);
    expect(within(groups[0]!).getByText("Takes a brand kit · 1 required, at most 2")).toBeTruthy();
    expect(within(groups[0]!).getByText("2 of 2 artifacts chosen. Remove one to choose another.")).toBeTruthy();
    expect(within(groups[1]!).getByText("No artifact chosen. The run uses what it finds in its own context.")).toBeTruthy();
    expect(document.querySelector('[data-slot="scope-assignment-skill-limits"]')).toBeNull();
    expect(screen.queryByText(/effective per run/)).toBeNull();
    const [tabSkills, tabArtifacts] = screen.getAllByRole("tab");
    expect(tabSkills!.getAttribute("aria-selected")).toBe("false");
    expect(tabArtifacts!.getAttribute("aria-selected")).toBe("true");
  });

  it("closes a slot's field at its bound", () => {
    render(<ScopeAssignmentPage model={artifacts()} />);
    const [brandField, postsField] = screen.getAllByRole("combobox") as HTMLInputElement[];
    expect(brandField!.disabled).toBe(true);
    expect(postsField!.disabled).toBe(false);
  });

  it("adds a picked artifact to its slot with the page's target", async () => {
    render(<ScopeAssignmentPage model={artifacts()} />);
    const posts = document.querySelector('[data-slot-id="reference-posts"]') as HTMLElement;
    fireEvent.click(within(posts).getByRole("combobox"));
    fireEvent.click(await screen.findByText("Launch Announcement"));
    await waitFor(() =>
      expect(actions.assignScopeContextArtifactAction).toHaveBeenCalledWith(
        { surface: "agent", scope: { kind: "team", id: TEAM }, vendor: "cinatra-ai", name: "scope-fixture-agent" },
        "reference-posts",
        "res_post",
      ),
    );
    expect(actions.searchScopeContextArtifactsAction).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "team", id: TEAM } }),
      "reference-posts",
      "",
      expect.anything(),
    );
  });

  it("surfaces the store's typed refusals and takes the row back out", async () => {
    for (const [reason, words] of [
      ["artifact-not-visible", "you can't see that artifact here"],
      ["incompatible-artifact", "that artifact is not the kind this slot takes"],
      ["unknown-slot", "the agent no longer declares that slot"],
    ] as const) {
      actions.assignScopeContextArtifactAction.mockResolvedValue({ ok: false, reason });
      render(<ScopeAssignmentPage model={artifacts()} />);
      const posts = document.querySelector('[data-slot-id="reference-posts"]') as HTMLElement;
      fireEvent.click(within(posts).getByRole("combobox"));
      fireEvent.click(await screen.findByText("Launch Announcement"));
      await waitFor(() =>
        expect(screen.getByText(`Couldn't add Launch Announcement: ${words}. Nothing was changed.`)).toBeTruthy(),
      );
      expect(document.querySelector('[data-artifact-id="res_post"]')).toBeNull();
      cleanup();
    }
  });

  it("removes a row with the slot and the page's target", async () => {
    render(<ScopeAssignmentPage model={artifacts()} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Brand Kit 2026" }));
    await waitFor(() =>
      expect(actions.removeScopeContextArtifactAction).toHaveBeenCalledWith(
        expect.objectContaining({ scope: { kind: "team", id: TEAM } }),
        "brand-voice",
        "res_b",
      ),
    );
    await waitFor(() => expect(document.querySelector('[data-artifact-id="res_b"]')).toBeNull());
  });

  it("reorders a slot's rows for this scope, and restores the order on a refusal", async () => {
    render(<ScopeAssignmentPage model={artifacts()} />);
    fireEvent.click(screen.getByRole("button", { name: "Move Brand Kit 2026 up" }));
    await waitFor(() =>
      expect(actions.reorderScopeContextArtifactsAction).toHaveBeenCalledWith(
        expect.objectContaining({ scope: { kind: "team", id: TEAM } }),
        "brand-voice",
        ["res_b", "res_a"],
      ),
    );
    const order = () =>
      [...document.querySelectorAll('[data-slot-id="brand-voice"] [data-slot="scope-context-row"]')].map((r) =>
        r.getAttribute("data-artifact-id"),
      );
    await waitFor(() => expect(order()).toEqual(["res_b", "res_a"]));

    actions.reorderScopeContextArtifactsAction.mockResolvedValue({ ok: false, reason: "stale-order" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move Tone of Voice 2025 up" }));
    });
    await waitFor(() => expect(order()).toEqual(["res_b", "res_a"]));
    expect(
      screen.getByText(
        "Couldn't reorder Brand voice: the list changed since this page loaded; reload it and try again. Nothing was changed.",
      ),
    ).toBeTruthy();
  });

  it("takes no other edit on a slot while its reorder is in flight", async () => {
    let settle: ((v: { ok: false; reason: "stale-order" }) => void) | null = null;
    actions.reorderScopeContextArtifactsAction.mockImplementation(
      () => new Promise((resolve) => {
        settle = resolve;
      }),
    );
    render(<ScopeAssignmentPage model={artifacts({ sections: [section({ scope: { kind: "team", id: TEAM }, key: `team:${TEAM}`, skills: null, slots: [{ ...BRAND, maxItems: 5 }] })] })} />);
    const slot = document.querySelector('[data-slot-id="brand-voice"]') as HTMLElement;
    fireEvent.click(within(slot).getByRole("button", { name: "Move Brand Kit 2026 up" }));
    await waitFor(() => expect(actions.reorderScopeContextArtifactsAction).toHaveBeenCalled());
    expect((within(slot).getByRole("combobox") as HTMLInputElement).disabled).toBe(true);
    for (const button of within(slot).getAllByRole("button", { name: /^Remove / })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    await act(async () => {
      settle?.({ ok: false, reason: "stale-order" });
    });
    await waitFor(() => expect((within(slot).getByRole("combobox") as HTMLInputElement).disabled).toBe(false));
  });

  it("never names an artifact the reader can't see, and keeps its remove control", () => {
    render(
      <ScopeAssignmentPage
        model={artifacts({
          sections: [
            section({
              scope: { kind: "team", id: TEAM },
              key: `team:${TEAM}`,
              skills: null,
              slots: [
                {
                  ...POSTS,
                  rows: [
                    { artifactId: "res_x", title: null, kindLabel: null, status: "not-visible" },
                    { artifactId: "res_y", title: null, kindLabel: null, status: "deleted" },
                  ],
                },
              ],
            }),
          ],
        })}
      />,
    );
    expect(screen.getByText("An artifact you can't see")).toBeTruthy();
    expect(screen.getByText("Not visible here")).toBeTruthy();
    expect(screen.getByText("Deleted")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove An artifact you can't see" })).toBeTruthy();
  });

  it("renders no write control on a scope whose S1 decision refuses", () => {
    render(
      <ScopeAssignmentPage
        model={artifacts({
          sections: [
            section({
              scope: { kind: "team", id: TEAM },
              key: `team:${TEAM}`,
              skills: null,
              slots: [BRAND],
              write: { allowed: false, message: "Only an admin of this team can change these assignments." },
            }),
          ],
        })}
      />,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove|Move/ })).toBeNull();
    expect(screen.getByText("Only an admin of this team can change these assignments.")).toBeTruthy();
    expect(screen.getByText("Tone of Voice 2025")).toBeTruthy();
  });

  it("shows an honest empty state for an agent whose manifest declares no slots", () => {
    render(<ScopeAssignmentPage model={artifacts({ manifest: "no-slots", sections: [section({ scope: { kind: "team", id: TEAM }, key: `team:${TEAM}`, skills: null, slots: null })] })} />);
    const empty = screen.getByTestId("scope-assignment-artifacts-empty");
    expect(within(empty).getByText("No context slots")).toBeTruthy();
    expect(within(empty).getByText(/declares no context slots/)).toBeTruthy();
    expect(within(empty).getByRole("link", { name: "Go to Skills" }).getAttribute("href")).toBe(
      `/teams/${TEAM}/agents/${AGENT_PATH}/settings?tab=skills`,
    );
    expect(document.querySelector('[data-slot="scope-context-slot"]')).toBeNull();
  });

  it("says so when the manifest cannot be read, never that it declares nothing", () => {
    render(<ScopeAssignmentPage model={artifacts({ manifest: "unreadable", sections: [section({ scope: { kind: "team", id: TEAM }, key: `team:${TEAM}`, skills: null, slots: null })] })} />);
    expect(screen.getByText("The manifest couldn’t be read")).toBeTruthy();
    expect(screen.queryByText("No context slots")).toBeNull();
  });
});
