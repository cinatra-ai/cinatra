/**
 * @vitest-environment jsdom
 *
 * §V extension settings — the page RENDERS without a Skills section, and the
 * sections that remain keep their order and their bound actions (cinatra#2702).
 *
 * These arms render the REAL presentational view (the same component the route
 * and the design fixture mount) rather than reading its source: the sibling
 * packages/extensions suite pins §V structure against source text, and a
 * source-text assertion cannot tell a section that is gone from a section that
 * merely moved, nor prove which server action a surviving section submits.
 *
 * Two complementary readings of the same render:
 *   1. the jsdom DOM — which section slots exist, in which document order;
 *   2. the element tree the component returns — which injected action function
 *      each surviving section binds (a DOM form carrying a React function
 *      action exposes no attribute to read, so the binding is read from the
 *      tree the view produced).
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// `installed-rows` is the view's only server-side neighbour (it supplies the
// KIND_LABEL map). Importing it for real drags the whole installed-extensions
// discovery chain — DB, registries, the generated renderer map — into a render
// test that needs one lookup table, so it is mocked to that table.
vi.mock("@cinatra-ai/extensions/screens/installed-rows", () => ({
  KIND_LABEL: {
    agent: "Agent",
    connector: "Connector",
    skill: "Skill",
    artifact: "Artifact",
    workflow: "Workflow",
    dashboard: "Dashboard",
  },
  settingsHrefFor: (kind: string, packageName: string) =>
    `/configuration/extensions/settings/${kind}/${packageName}`,
}));

// The next/link component needs an app router to resolve prefetching in jsdom, and this
// suite reads sections and their bound actions, never navigation. The stand-in
// is a plain element host (never an anchor: the design-system gate rejects a
// raw anchor anywhere in the tree) that keeps the destination readable as data.
vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <span data-href={typeof href === "string" ? href : "#"}>{children}</span>
  ),
}));

import {
  ExtensionSettingsView,
  type ExtensionSettingsActions,
  type ExtensionSettingsViewProps,
} from "@cinatra-ai/extensions/screens/extension-settings-view";

const ACTIONS: ExtensionSettingsActions = {
  archive: vi.fn(),
  activate: vi.fn(),
  retryActivation: vi.fn(),
  rollBackToBundled: vi.fn(),
  reinstall: vi.fn(),
  publish: vi.fn(),
  forceDelete: vi.fn(),
};

/**
 * An AGENT settings page with every optional affordance switched ON — the one
 * shape that rendered a Skills section before it was retired, and the shape
 * that binds all seven lifecycle actions at once.
 */
const SKILLS_NODE = <p data-slot="would-be-skills">Injected skills section</p>;

const props = (): ExtensionSettingsViewProps => ({
  kind: "agent",
  packageName: "@acme/research-agent",
  displayName: "Research Agent",
  vendor: "Acme Corp",
  recovery: { showRetryActivation: true, showRollBackToBundled: true },
  updateRow: {
    enabled: false,
    description: "Currently on version 0.5.0 — up to date.",
    disabledReason: "Already on the newest version.",
  },
  archiveDisabled: null,
  activateDisabled: null,
  reinstallDisabled: null,
  forceDeleteDisabled: null,
  isPublic: false,
  isRegisteredVendor: true,
  canPublish: true,
  permissions: <p data-slot="seeded-permissions">Seeded permissions control</p>,
  execution: <p data-slot="seeded-execution">Seeded execution control</p>,
  actions: ACTIONS,
  // The RETIRED slot, still offered by every arm below: a caller that kept
  // passing it must get a page that renders no Skills section regardless.
  skills: SKILLS_NODE,
} as ExtensionSettingsViewProps);

/**
 * Walk the element tree the view returned, recording every `action` function
 * against the `data-slot` section it renders inside. Recurses through props as
 * well as children: §V binds most actions on a nested `action={<Form .../>}`
 * prop, not on a child.
 */
type Walk = { bound: Map<string, Set<unknown>>; slots: string[] };

function walkTree(node: unknown, slot: string | null, out: Walk) {
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, slot, out);
    return;
  }
  if (!isValidElement(node)) return;
  const nodeProps = (node as ReactElement).props as Record<string, unknown>;
  const raw = nodeProps["data-slot"];
  const here = typeof raw === "string" ? raw : slot;
  if (typeof raw === "string") out.slots.push(raw);
  if (typeof nodeProps.action === "function" && here) {
    if (!out.bound.has(here)) out.bound.set(here, new Set());
    out.bound.get(here)!.add(nodeProps.action);
  }
  for (const value of Object.values(nodeProps)) walkTree(value, here, out);
}

afterEach(() => {
  cleanup();
});

describe("§V extension settings — the Skills section is retired (cinatra#2702)", () => {
  it("renders NO Skills section — no slot, no heading, and an injected node lands nowhere", () => {
    const { container } = render(<ExtensionSettingsView {...props()} />);

    expect(container.querySelector('[data-slot="settings-skills"]')).toBeNull();
    const headings = Array.from(container.querySelectorAll("h2")).map((h) => h.textContent?.trim());
    expect(headings).not.toContain("Skills");
    expect(container.querySelector('[data-slot="would-be-skills"]')).toBeNull();
    expect(container.textContent).not.toContain("Injected skills section");
  });

  it("keeps the remaining sections, in order: Permissions, Execution, Marketplace, Maintenance, Danger zone", () => {
    const { container } = render(<ExtensionSettingsView {...props()} />);

    // Every §V section slot the view can emit — the retired one included, so a
    // Skills section that came back would show up here as an extra entry
    // rather than being filtered out of the reading.
    const SECTION_SLOTS = [
      "settings-permissions",
      "settings-execution",
      "settings-skills",
      "settings-marketplace",
      "settings-maintenance",
      "settings-danger-zone",
    ];
    const expected = SECTION_SLOTS.filter((slot) => slot !== "settings-skills");
    const rendered = Array.from(container.querySelectorAll("[data-slot]"))
      .map((el) => el.getAttribute("data-slot"))
      .filter((slot): slot is string => SECTION_SLOTS.includes(slot ?? ""));

    expect(rendered).toEqual(expected);
    // The injected sections still render their own content.
    expect(container.querySelector('[data-slot="seeded-permissions"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="seeded-execution"]')).not.toBeNull();
  });

  it("keeps every surviving section bound to ITS server action", () => {
    const walk: Walk = { bound: new Map(), slots: [] };
    walkTree(ExtensionSettingsView(props()) as ReactElement, null, walk);
    const bound = walk.bound;

    expect(walk.slots).not.toContain("settings-skills");
    expect(walk.slots).not.toContain("would-be-skills");
    expect(Array.from(bound.get("settings-marketplace") ?? [])).toEqual([ACTIONS.publish]);
    expect(bound.get("settings-maintenance")).toEqual(
      new Set([ACTIONS.archive, ACTIONS.activate, ACTIONS.retryActivation, ACTIONS.rollBackToBundled]),
    );
    expect(bound.get("settings-danger-zone")).toEqual(
      new Set([ACTIONS.reinstall, ACTIONS.forceDelete]),
    );
  });
});
