// @vitest-environment jsdom
//
// cinatra#2807 (per-scope surfaces S1) — the 5x4 route matrix.
//
// Five scope bases (workspace, personal, project, team, organization) times the
// four new tabs (assistants, agents, artifacts, skills). Route existence alone
// is not the acceptance: every route is RENDERED and must show the shared
// five-tab strip, the correct active tab, the scope-based hrefs, and its own
// named empty-state surface. S1 loads no scope data — the contents of the
// Assistants/Agents tabs (#2808) and of the Artifacts/Skills tabs (#2810) are
// their own slices, so what these shells render is an honest placeholder.
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    // `createElement`, not JSX: the app forbids a raw anchor element in source,
    // and this stand-in is exactly that anchor — the element the real
    // `next/link` renders, kept plain so the tab href is directly readable.
    createElement("a", { href, ...rest }, children),
}));

const auth = vi.hoisted(() => ({
  requireAuthSession: vi.fn(async () => ({
    user: { id: "user_1" },
    session: { activeOrganizationId: "org_1" },
  })),
}));
vi.mock("@/lib/auth-session", () => auth);

const FIVE_TABS = ["Dashboards", "Assistants", "Agents", "Artifacts", "Skills"] as const;
const NEW_TABS = ["assistants", "agents", "artifacts", "skills"] as const;

type Loader = () => Promise<{ default: (props: never) => Promise<unknown> }>;

/** [scope name, scope base, has a Settings tab, params, per-tab page loaders] */
const MATRIX: ReadonlyArray<
  readonly [string, string, boolean, unknown, Record<string, Loader>]
> = [
  [
    "workspace",
    "/workspace",
    false,
    undefined,
    {
      assistants: () => import("../workspace/assistants/page"),
      agents: () => import("../workspace/agents/page"),
      artifacts: () => import("../workspace/artifacts/page"),
      skills: () => import("../workspace/skills/page"),
    },
  ],
  [
    "personal",
    "/personal",
    false,
    undefined,
    {
      assistants: () => import("../personal/assistants/page"),
      agents: () => import("../personal/agents/page"),
      artifacts: () => import("../personal/artifacts/page"),
      skills: () => import("../personal/skills/page"),
    },
  ],
  [
    "project",
    "/projects/p1",
    true,
    { params: Promise.resolve({ projectId: "p1" }) },
    {
      assistants: () => import("../projects/[projectId]/assistants/page"),
      agents: () => import("../projects/[projectId]/agents/page"),
      artifacts: () => import("../projects/[projectId]/artifacts/page"),
      skills: () => import("../projects/[projectId]/skills/page"),
    },
  ],
  [
    "team",
    "/teams/t1",
    true,
    { params: Promise.resolve({ teamId: "t1" }) },
    {
      assistants: () => import("../teams/[teamId]/assistants/page"),
      agents: () => import("../teams/[teamId]/agents/page"),
      artifacts: () => import("../teams/[teamId]/artifacts/page"),
      skills: () => import("../teams/[teamId]/skills/page"),
    },
  ],
  [
    "organization",
    "/organizations/o1",
    true,
    { params: Promise.resolve({ id: "o1" }) },
    {
      assistants: () => import("../organizations/[id]/assistants/page"),
      agents: () => import("../organizations/[id]/agents/page"),
      artifacts: () => import("../organizations/[id]/artifacts/page"),
      skills: () => import("../organizations/[id]/skills/page"),
    },
  ],
];

const tabLabels = () =>
  screen.getAllByRole("tab").map((el) => el.textContent?.trim() ?? "");

const activeLabel = () =>
  screen
    .getAllByRole("tab")
    .find((el) => el.getAttribute("data-state") === "active")
    ?.textContent?.trim() ?? null;

const hrefFor = (label: string) =>
  screen
    .getAllByRole("tab")
    .find((el) => el.textContent?.trim() === label)
    ?.getAttribute("href") ?? null;

async function renderRoute(load: Loader, props: unknown) {
  const mod = await load();
  const tree = await mod.default((props ?? {}) as never);
  render(tree as ReactNode);
}

beforeEach(() => {
  auth.requireAuthSession.mockClear();
});
afterEach(cleanup);

describe("the 5x4 scoped tab routes render the shared strip and their empty state (#2807)", () => {
  for (const [scope, base, hasSettings, props, loaders] of MATRIX) {
    for (const tab of NEW_TABS) {
      const label = tab[0]!.toUpperCase() + tab.slice(1);

      describe(`${base}/${tab}`, () => {
        beforeEach(async () => {
          await renderRoute(loaders[tab]!, props);
        });

        it("renders the shared five-tab strip in order", () => {
          expect(tabLabels().slice(0, 5)).toEqual([...FIVE_TABS]);
        });

        it(`carries Settings only where the ${scope} scope has one`, () => {
          expect(tabLabels().includes("Settings")).toBe(hasSettings);
        });

        it("marks its own tab active", () => {
          expect(activeLabel()).toBe(label);
        });

        it("points every tab at this scope base", () => {
          expect(hrefFor("Dashboards")).toBe(base);
          for (const other of NEW_TABS) {
            const otherLabel = other[0]!.toUpperCase() + other.slice(1);
            expect(hrefFor(otherLabel)).toBe(`${base}/${other}`);
          }
        });

        it(`shows the scope-${tab}-empty surface`, () => {
          expect(screen.getByTestId(`scope-${tab}-empty`)).toBeTruthy();
        });

        it("promises what the tab will hold and never claims the scope is empty", () => {
          // S1 reads nothing, so the surface may state its own condition and
          // name what the tab will list — never that the scope has nothing.
          const copy = screen.getByTestId(`scope-${tab}-empty`).textContent ?? "";
          expect(copy).toMatch(/appear here/);
          expect(copy).not.toMatch(/nothing|\bnone\b|\bempty\b|\bno \w+ (?:yet|here)/i);
        });

        it("requires an authenticated viewer", () => {
          expect(auth.requireAuthSession).toHaveBeenCalled();
        });
      });
    }
  }
});

describe("the /workspace landing opens on Dashboards (#2807)", () => {
  beforeEach(async () => {
    const mod = await import("../workspace/page");
    render((await mod.default()) as ReactNode);
  });

  it("renders the five-tab strip with no Settings tab", () => {
    expect(tabLabels()).toEqual([...FIVE_TABS]);
  });

  it("opens on the Dashboards tab", () => {
    expect(activeLabel()).toBe("Dashboards");
  });

  it("points its tabs at the /workspace base", () => {
    expect(hrefFor("Dashboards")).toBe("/workspace");
    for (const tab of NEW_TABS) {
      const label = tab[0]!.toUpperCase() + tab.slice(1);
      expect(hrefFor(label)).toBe(`/workspace/${tab}`);
    }
  });

  it("shows an honest dashboards placeholder until the workspace dashboards land", () => {
    expect(screen.getByTestId("scope-dashboards-empty")).toBeTruthy();
  });

  it("promises what the tab will hold and never claims the workspace is empty", () => {
    const copy = screen.getByTestId("scope-dashboards-empty").textContent ?? "";
    expect(copy).toMatch(/appear here/);
    expect(copy).not.toMatch(/nothing|\bnone\b|\bempty\b|\bno \w+ (?:yet|here)/i);
  });
});
