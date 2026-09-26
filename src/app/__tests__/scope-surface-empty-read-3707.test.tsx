// @vitest-environment jsdom
//
// cinatra#3707: an EMPTY READ on the per-scope Assistants and Agents tabs
// draws the tab's own empty reading, not "This tab is not ready yet".
//
// The maintainer's decision of 2026-09-26: a wired tab whose read answered with
// no rows draws its own empty-state sentence; the placeholder stays for a tab
// that has no route. These two routes are wired, so the two truths must reach
// the screen apart from each other:
//
//   the read HAPPENED and found nothing  -> "No agents here yet"
//   the read could NOT be taken          -> "This tab is not ready yet"
//
// The second case is what keeps the first honest. A scope whose membership or
// permission read failed knows nothing about the scope, so it may not say the
// scope reaches no agent.
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn(async () => ({
    user: { id: "user_1" },
    session: { activeOrganizationId: "org_1" },
  })),
}));

vi.mock("@/lib/scope-surface-entity-name", () => ({
  readScopeSurfaceEntityName: vi.fn(async () => "Acme Corp"),
}));

// The generated extension manifest is a SERVER registry whose entries import
// the connector packages themselves; a jsdom render of these shells needs none
// of it, and the repository's other jsdom suites stand it in exactly this way.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {},
  GENERATED_CONNECTOR_ENTRY_MODULES: {},
  GENERATED_CONNECTOR_MCP_MODULES: {},
  GENERATED_WIDGET_STREAM_AGENTS: {},
}));

/**
 * The loader, stood in for so each case can state WHICH of the two answers it
 * gives. Both the plain row readers and the tab readers are served, so this
 * suite renders the routes through whichever one they call.
 */
const loader = vi.hoisted(() => {
  const state = {
    agents: { rows: [] as unknown[], read: true },
    assistants: { rows: [] as unknown[], read: true },
  };
  return {
    state,
    readScopeSurfaceAgentRows: vi.fn(async () => state.agents.rows),
    readScopeSurfaceAssistantRows: vi.fn(async () => state.assistants.rows),
    readScopeSurfaceAgentTab: vi.fn(async () => state.agents),
    readScopeSurfaceAssistantTab: vi.fn(async () => state.assistants),
  };
});
vi.mock("@/lib/scope-surface-eligibility.server", () => loader);

const PLACEHOLDER = "This tab is not ready yet";

/** The honest empty reading of each wired tab, held here as its own oracle. */
const EMPTY_READING = {
  agents: {
    title: "No agents here yet",
    body: "No agent is reachable in this scope for you.",
  },
  assistants: {
    title: "No assistants here yet",
    body: "No assistant is reachable in this scope for you.",
  },
} as const;

const ROUTES = [
  ["agents", () => import("../organizations/[id]/agents/page")],
  ["assistants", () => import("../organizations/[id]/assistants/page")],
] as const;

async function renderRoute(load: () => Promise<{ default: (props: never) => Promise<unknown> }>) {
  const mod = await load();
  render((await mod.default({ params: Promise.resolve({ id: "o1" }) } as never)) as ReactNode);
}

beforeEach(() => {
  loader.state.agents = { rows: [], read: true };
  loader.state.assistants = { rows: [], read: true };
});
afterEach(cleanup);

describe("an empty read draws the tab's own empty reading (#3707)", () => {
  for (const [tab, load] of ROUTES) {
    const reading = EMPTY_READING[tab];

    describe(`the organization ${tab} tab`, () => {
      it("reads the scope's own emptiness when the read found no rows", async () => {
        await renderRoute(load);
        const surface = screen.getByTestId(`scope-${tab}-empty`);
        expect(surface.querySelector('[data-slot="empty-title"]')?.textContent).toBe(
          reading.title,
        );
        expect(surface.querySelector('[data-slot="empty-description"]')?.textContent).toBe(
          reading.body,
        );
      });

      it("never says the tab is unbuilt on a read that answered", async () => {
        await renderRoute(load);
        expect(screen.getByTestId(`scope-${tab}-empty`).textContent).not.toContain(PLACEHOLDER);
      });

      it("keeps the placeholder where the read could not be taken", async () => {
        loader.state[tab] = { rows: [], read: false };
        await renderRoute(load);
        const surface = screen.getByTestId(`scope-${tab}-empty`);
        expect(surface.querySelector('[data-slot="empty-title"]')?.textContent).toBe(PLACEHOLDER);
      });

      it("claims no emptiness of the scope on a read that could not be taken", async () => {
        loader.state[tab] = { rows: [], read: false };
        await renderRoute(load);
        const copy = screen.getByTestId(`scope-${tab}-empty`).textContent ?? "";
        expect(copy).not.toContain(reading.title);
        expect(copy).not.toContain(reading.body);
      });
    });
  }
});
