/**
 * BEHAVIORAL end-to-end coverage for the /assistants toolbar (cinatra#2688):
 * executes the REAL server component (auth / DB / registry boundaries mocked)
 * so the whole scope pipeline — the canonical parser, the audience→scope fold,
 * the OR-predicate — is the REAL production code, then asserts which rows reach
 * <AssistantsDirectoryClient> and how the add-affordance flags are resolved.
 *
 * Mirrors packages/connectors/src/__tests__/pages-multiscope-behavior.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";

const ACTOR = "user-actor";
const ORG = "o1";
const TEAM = "t1";
const PROJECT = "p1";

let isAdmin = false;

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn(async () => ({
    user: { id: ACTOR },
    session: { activeOrganizationId: ORG },
  })),
  getAuthSession: vi.fn(async () => ({
    user: { id: ACTOR },
    session: { activeOrganizationId: ORG },
  })),
  isPlatformAdmin: vi.fn(() => isAdmin),
}));
vi.mock("@/lib/better-auth-db", () => ({
  // A UI scope picker calls the active-only sibling (cinatra#1942 Decision 4).
  readOrgsWithTeamsForUserActiveOnly: vi.fn(async () => [
    { id: ORG, name: "Org One", teams: [{ id: TEAM, name: "Team One" }] },
  ]),
  readProjectsForUser: vi.fn(async () => [{ id: PROJECT, name: "Project One" }]),
}));

// The registry read is mocked; the DIRECTORY BUILD (fold + scope filter) is the
// real production code under test.
const REGISTRY = [
  {
    packageName: "@cinatra-ai/cinatra-assistant",
    templateId: "t-builtin",
    assistantUserId: "au-builtin",
    handle: "cinatra",
    displayName: "Cinatra",
    origin: "extension" as const,
    aliases: [],
    isBuiltin: true,
    delivery: "host-runtime" as const,
    launch: { kind: "local" as const, targetProvider: null },
    audience: [],
  },
  {
    packageName: "@cinatra-ai/team-assistant",
    templateId: "t-team",
    assistantUserId: "au-team",
    handle: "teamly",
    displayName: "Team Assistant",
    origin: "extension" as const,
    aliases: [],
    isBuiltin: false,
    delivery: "host-runtime" as const,
    launch: { kind: "local" as const, targetProvider: null },
    audience: [{ subjectKind: "team", subjectId: TEAM }],
  },
  {
    packageName: "@cinatra-ai/project-assistant",
    templateId: "t-proj",
    assistantUserId: "au-proj",
    handle: "projectly",
    displayName: "Project Assistant",
    origin: "extension" as const,
    aliases: [],
    isBuiltin: false,
    delivery: "host-runtime" as const,
    launch: { kind: "local" as const, targetProvider: null },
    audience: [{ subjectKind: "project", subjectId: PROJECT }],
  },
];

vi.mock("@/lib/assistant-registry-reader", () => ({
  resolveAssistantAudienceContext: vi.fn(async () => ({
    userId: ACTOR,
    isPlatformAdmin: false,
    orgIds: new Set([ORG]),
    teamIds: new Set([TEAM]),
    projectIds: new Set([PROJECT]),
  })),
  readAssistantRegistryForActor: vi.fn(async () => REGISTRY),
}));

vi.mock("@/components/assistants/assistants-directory-client", () => ({
  // Stub client component — the page test reads its props off the returned
  // element tree (never DOM-rendered; the vitest env is node).
  AssistantsDirectoryClient: vi.fn(() => null),
}));

import AssistantsDirectoryPage from "../page";
import { AssistantsDirectoryClient } from "@/components/assistants/assistants-directory-client";

type ClientProps = {
  rows: Array<{ handle: string; scopeEntries: unknown[] }>;
  scopeValue: string[];
  scopes: { orgs: Array<{ id: string }>; projects: Array<{ id: string }> };
  canReachMarketplace: boolean;
  canUploadExtension: boolean;
};

/** Walk the rendered element tree for the stubbed client component. */
function findClientElement(node: ReactNode): ReactElement<ClientProps> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findClientElement(child);
      if (found) return found;
    }
    return null;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.type === AssistantsDirectoryClient) return el as unknown as ReactElement<ClientProps>;
  const children = (el.props as { children?: ReactNode } | undefined)?.children;
  return children ? findClientElement(children) : null;
}

async function renderPage(scope?: string): Promise<ClientProps> {
  const tree = await AssistantsDirectoryPage({
    searchParams: Promise.resolve(scope === undefined ? {} : { scope }),
  });
  const el = findClientElement(tree);
  if (!el) throw new Error("AssistantsDirectoryClient was not rendered");
  return el.props;
}

async function handlesForScope(scope?: string): Promise<string[]> {
  const props = await renderPage(scope);
  return props.rows.map((r) => r.handle).sort();
}

describe("/assistants toolbar — scope pipeline (cinatra#2688)", () => {
  beforeEach(() => {
    isAdmin = false;
  });

  it("no ?scope= shows every audience-admitted assistant", async () => {
    expect(await handlesForScope()).toEqual(["cinatra", "projectly", "teamly"]);
  });

  it("a team selection narrows the list to that team's assistant", async () => {
    expect(await handlesForScope(`team:${TEAM}`)).toEqual(["teamly"]);
  });

  it("a project selection narrows the list to that project's assistant", async () => {
    expect(await handlesForScope(`project:${PROJECT}`)).toEqual(["projectly"]);
  });

  it("OR-unions a multi-token selection", async () => {
    expect(await handlesForScope(`team:${TEAM},project:${PROJECT}`)).toEqual([
      "projectly",
      "teamly",
    ]);
  });

  it("drops an INACCESSIBLE token and falls back to the broadest view", async () => {
    // team:t9 is not in the actor's accessible set, so the parser drops it and
    // the empty remainder collapses to the default — never a silent narrowing
    // to a scope the actor cannot see, and never an error.
    expect(await handlesForScope("team:t9")).toEqual(["cinatra", "projectly", "teamly"]);
  });

  it("a workspace token collapses the whole selection to the default", async () => {
    expect(await handlesForScope(`workspace,team:${TEAM}`)).toEqual([
      "cinatra",
      "projectly",
      "teamly",
    ]);
  });

  it("hands the picker the resolved selection and the actor's accessible scopes", async () => {
    const props = await renderPage(`team:${TEAM}`);
    expect(props.scopeValue).toEqual([`team:${TEAM}`]);
    expect(props.scopes.orgs.map((o) => o.id)).toEqual([ORG]);
    expect(props.scopes.projects.map((p) => p.id)).toEqual([PROJECT]);
  });

  it("the builtin folds to the workspace locus, so it survives no selection but not an org one", async () => {
    const props = await renderPage();
    const builtin = props.rows.find((r) => r.handle === "cinatra");
    expect(builtin?.scopeEntries).toEqual([{ locus: "workspace" }]);
    expect(await handlesForScope(`org:${ORG}`)).toEqual([]);
  });
});

describe("/assistants toolbar — + Assistant gating (cinatra#2688)", () => {
  it("a non-admin gets NEITHER acquisition entry (no control that leads nowhere)", async () => {
    isAdmin = false;
    const props = await renderPage();
    expect(props.canReachMarketplace).toBe(false);
    expect(props.canUploadExtension).toBe(false);
  });

  it("a platform admin gets both acquisition entries", async () => {
    isAdmin = true;
    const props = await renderPage();
    expect(props.canReachMarketplace).toBe(true);
    expect(props.canUploadExtension).toBe(true);
  });

  it("the scope filter does not depend on the add-affordance flags", async () => {
    isAdmin = true;
    expect(await handlesForScope(`team:${TEAM}`)).toEqual(["teamly"]);
  });
});
