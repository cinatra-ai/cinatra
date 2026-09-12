// @vitest-environment jsdom
//
// cinatra#2807 (per-scope surfaces S1) — the 5x4 route matrix.
//
// Five scope bases (workspace, personal, project, team, organization) times the
// four new tabs (assistants, agents, artifacts, skills). Route existence alone
// is not the acceptance: every route is RENDERED and must show the shared
// five-tab strip, the correct active tab, the scope-based hrefs, and its own
// named empty-state surface. S1 loads no scope data — the contents of the
// Assistants/Agents tabs (#2808) are their own slice, so what those two shells
// render is an honest placeholder. The Artifacts and Skills tabs DO read as of
// #2810: their bodies are stood in for below and the shell's honest EMPTY
// reading is what this suite pins for them.
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

// The gated per-scope name read the tab routes perform so the page keeps
// naming its entity. Mocked here: this suite is about what the header RENDERS,
// and the gate itself is proven in the reader's own suite.
// Keyed on the WHOLE reference, kind and id, never the kind alone: a route
// that handed the reader some other entity's id would then read no name, fall
// back to the kind noun, and fail the header assertion below — which is the
// point. A kind-only stand-in would answer "Apollo" for any project id at all.
const names = vi.hoisted(() => {
  const BY_REF: Record<string, string> = {
    "project:p1": "Apollo",
    "team:t1": "Growth",
    "organization:o1": "Acme Corp",
  };
  return {
    readScopeSurfaceEntityName: vi.fn(
      async (scope: { kind: string; id?: string }) =>
        BY_REF[`${scope.kind}:${scope.id ?? ""}`] ?? null,
    ),
  };
});
vi.mock("@/lib/scope-surface-entity-name", () => names);

// The Artifacts and Skills tab BODIES (cinatra#2810) are stood in for here: the
// subject of this suite is the shell those tabs are tabs OF, and each body's
// own read is proven in its own suite. They render nothing, so the shell falls
// to its empty state — which is exactly where the two tabs' honest EMPTY
// reading is asserted below.
vi.mock("@/components/scope/scope-surface-artifacts-tab", () => ({
  ScopeSurfaceArtifactsTab: () =>
    createElement("div", { "data-testid": "scope-artifacts-body" }),
}));
vi.mock("@/components/scope/scope-surface-skills-tab", () => ({
  ScopeSurfaceSkillsTab: () =>
    createElement("div", { "data-testid": "scope-skills-body" }),
}));

const FIVE_TABS = ["Dashboards", "Assistants", "Agents", "Artifacts", "Skills"] as const;
const NEW_TABS = ["assistants", "agents", "artifacts", "skills"] as const;

type Loader = () => Promise<{ default: (props: never) => Promise<unknown> }>;

/**
 * [scope name, scope base, has a Settings tab, the ENTITY NAME the page header
 * must keep reading on every one of its tabs, params, per-tab page loaders]
 */
const MATRIX: ReadonlyArray<
  readonly [string, string, boolean, string, unknown, Record<string, Loader>]
> = [
  [
    "workspace",
    "/workspace",
    false,
    "Workspace",
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
    "Personal",
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
    "Apollo",
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
    "Growth",
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
    "Acme Corp",
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
  for (const [scope, base, hasSettings, entityName, props, loaders] of MATRIX) {
    for (const tab of NEW_TABS) {
      const label = tab[0]!.toUpperCase() + tab.slice(1);

      describe(`${base}/${tab}`, () => {
        // The two truths the shell must keep apart. A tab whose rows were
        // never read may state its OWN condition and name what it will list —
        // never that the scope has nothing. A tab whose rows WERE read says
        // what the read found. Artifacts and Skills read as of cinatra#2810;
        // Assistants and Agents still carry the S1 placeholder here.
        const READS = tab === "artifacts" || tab === "skills";

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

        it(
          READS
            ? `mounts the scope-${tab}-body its slice wired onto this route`
            : `shows the scope-${tab}-empty surface`,
          () => {
            expect(
              screen.getByTestId(READS ? `scope-${tab}-body` : `scope-${tab}-empty`),
            ).toBeTruthy();
          },
        );

        if (!READS) {
          it("promises what the tab will hold and never claims the scope is empty", () => {
            // A tab whose rows were never read may state its OWN condition and
            // name what it will list — never that the scope has nothing.
            const copy = screen.getByTestId(`scope-${tab}-empty`).textContent ?? "";
            expect(copy).toMatch(/appear here/);
            expect(copy).not.toMatch(
              /nothing|\bnone\b|\bempty\b|\bno \w+ (?:yet|here)/i,
            );
          });
        }

        it("requires an authenticated viewer", () => {
          expect(auth.requireAuthSession).toHaveBeenCalled();
        });

        // The ratified drawing: "The page's heading reads Workspace, and the
        // page is an entity page" - and the four scoped tabs are tabs OF that
        // page. A tab is not a page of its own, so the heading keeps naming the
        // entity; the tab's own name is carried by the active tab in the strip.
        it("keeps the entity's name as the page heading, never the tab name", () => {
          const heading = document.querySelector("h1")!;
          expect(heading.textContent?.trim()).toBe(entityName);
        });

        it("does not put the tab name in the heading", () => {
          expect(document.querySelector("h1")!.textContent?.trim()).not.toBe(
            label,
          );
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

  it("reads Workspace as its heading", () => {
    expect(document.querySelector("h1")!.textContent?.trim()).toBe("Workspace");
  });

  it("points its tabs at the /workspace base", () => {
    expect(hrefFor("Dashboards")).toBe("/workspace");
    for (const tab of NEW_TABS) {
      const label = tab[0]!.toUpperCase() + tab.slice(1);
      expect(hrefFor(label)).toBe(`/workspace/${tab}`);
    }
  });

  // The Workspace section sends this tab's body to the Dashboards tab section:
  // "The body below the strip is the ordinary entity-page body of that same
  // section" - so the tab reads that section's own panel, not the shared Empty
  // pattern the four scoped tabs read.
  it("draws the Dashboards tab's own panel, not the scoped-tab placeholder", () => {
    const panel = document.querySelector(
      '[data-conformance-id="scope-dashboards-tab"]',
    );
    expect(panel).toBeTruthy();
    expect(panel!.querySelector('[data-slot="empty"]')).toBeNull();
    expect(screen.getByTestId("scope-dashboards-empty")).toBeTruthy();
  });

  it("reads the drawn empty wording for the Dashboards tab", () => {
    const copy = screen.getByTestId("scope-dashboards-empty").textContent ?? "";
    expect(copy).toContain("No dashboards in this scope yet");
  });

  // "a personal user scope and the whole-workspace scope are not add-to-scope
  // targets - they carry no Add". So no Add affordance is drawn, and the helper
  // never promises the manager recourse the drawing words for the three shared
  // scopes.
  it("carries no Add affordance and never names the manager recourse", () => {
    const panel = document.querySelector(
      '[data-conformance-id="scope-dashboards-tab"]',
    )!;
    expect(panel.querySelectorAll("a, button").length).toBe(0);
    expect(panel.textContent ?? "").not.toMatch(/\bAdd\b/);
  });

  // "the tab points, it never renders a dashboard inline".
  it("renders no dashboard inline", () => {
    expect(document.querySelector("[data-cinatra-dashboard-empty]")).toBeNull();
    expect(document.querySelector(".react-grid-layout")).toBeNull();
  });
});
