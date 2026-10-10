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
 * A2 — the trail of each scope's Executions tab ends at Executions: the scope's
 *      name, then Agents, then the strip's own Executions tab, built the way the
 *      shell builds it from what the page publishes.
 *
 * The bare strip stays exactly what it was for a reader with no scope.
 */
import { createElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));

// What the page publishes to the crumb bus, recorded per render: the shell
// builds the trail from exactly these entries (cinatra#3693).
const published = vi.hoisted(
  () => [] as Array<ReadonlyArray<{ readonly prefix: string; readonly label: string }>>,
);

vi.mock("@/components/crumb-contributions", () => ({
  CrumbContributions: ({
    entries,
  }: {
    entries: ReadonlyArray<{ readonly prefix: string; readonly label: string }>;
  }) => {
    published.push(entries);
    return null;
  },
  CrumbContributionsClear: () => null,
  PageNotFoundCrumb: () => null,
}));

import { ScopeSurfacePage } from "@/components/scope-surface-page";
import { AgentsTabNav } from "@/components/agents-tab-nav";
import { buildBreadcrumbTrail } from "@/lib/breadcrumb-trail";
import { agentsNavFor } from "@/lib/agents-nav";
import {
  scopeSurfaceBase,
  scopeSurfaceCrumbEntries,
  type ScopeSurfaceRef,
} from "@/lib/scope-surfaces";

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
  published.length = 0;
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

/**
 * The trail the shell draws for `path`: the page is rendered once, its one
 * publish is the crumb contributions, and the leaf's page title is the one the
 * PageHeader broadcasts — the rendered h1's text.
 */
function trailOf(path: string, element: ReactElement) {
  const before = published.length;
  const { container } = render(element);
  expect(published.length - before, "the page publishes its crumbs once").toBe(1);
  const entries = published[published.length - 1];
  const heading = container.querySelector("h1");
  expect(heading, "the page draws its heading").not.toBeNull();
  return buildBreadcrumbTrail(path, {
    pageTitle: { title: heading?.textContent ?? "", pathname: path },
    contributions: entries,
  });
}

const ORG_ID = "88c63f08-4d2e-4c7a-9f1b-2a0d6e5c4b31";

/** The five scopes with the name each route hands its page, and the trail's
 *  head before "Agents": the container crumb first on an id-bearing scope. */
const NAMED_SCOPES: ReadonlyArray<{
  scope: ScopeSurfaceRef;
  title: string | undefined;
  head: string[];
}> = [
  { scope: { kind: "workspace" }, title: undefined, head: ["Workspace"] },
  { scope: { kind: "personal" }, title: undefined, head: ["Personal"] },
  {
    scope: { kind: "organization", id: ORG_ID },
    title: "Northwind Analytics",
    head: ["Organizations", "Northwind Analytics"],
  },
  {
    scope: { kind: "team", id: "t-1234-5678-9abc" },
    title: "Growth",
    head: ["Teams", "Growth"],
  },
  {
    scope: { kind: "project", id: "p-1234-5678-9abc" },
    title: "Q3 Outbound",
    head: ["Projects", "Q3 Outbound"],
  },
];

describe("A2: the trail of each scope's Executions tab ends at Executions (cinatra#3693)", () => {
  it("the All Agents tab still ends at Agents, and the three-argument reading is unchanged", () => {
    for (const { scope, title, head } of NAMED_SCOPES) {
      const path = `${scopeSurfaceBase(scope)}/agents`;
      const labels = trailOf(
        path,
        <ScopeSurfacePage scope={scope} tab="agents" title={title} body={<div />} />,
      ).map((crumb) => crumb.label);
      expect(labels, path).toEqual([...head, "Agents"]);
      expect(scopeSurfaceCrumbEntries(scope, "agents", title)).toHaveLength(2);
      cleanup();
    }
  });

  const EXECUTIONS_CASES: ReadonlyArray<{
    name: string;
    scope: ScopeSurfaceRef;
    title: string | undefined;
    expected: string[];
  }> = [
    ...NAMED_SCOPES.map(({ scope, title, head }, i) => ({
      name: `E${i + 1} ${scopeSurfaceBase(scope)}/agents/executions`,
      scope,
      title,
      expected: [...head, "Agents", "Executions"],
    })),
    {
      name: `E6 /organizations/${ORG_ID}/agents/executions with the name withheld`,
      scope: { kind: "organization", id: ORG_ID },
      title: undefined,
      expected: ["Organizations", `${ORG_ID.slice(0, 8)}…`, "Agents", "Executions"],
    },
  ];

  for (const { name, scope, title, expected } of EXECUTIONS_CASES) {
    it(`${name} — the last crumb is the strip's own Executions tab`, () => {
      const base = scopeSurfaceBase(scope);
      const path = `${base}/agents/executions`;
      const trail = trailOf(
        path,
        <ScopeSurfacePage
          scope={scope}
          tab="agents"
          agentsTab="executions"
          title={title}
          body={<div />}
        />,
      );
      const labels = trail.map((crumb) => crumb.label);
      expect(
        labels,
        "the trail's last crumb names the route's Executions tab, never the scope again",
      ).toEqual(expected);
      const stripTab = agentsNavFor(base).find((item) => item.value === "executions");
      const last = trail[trail.length - 1];
      expect([last.label, last.href]).toEqual([stripTab?.label, stripTab?.href]);
    });
  }
});
