// The skills pane names its run in the trail (cinatra#4453).
//
// The components drawing, Breadcrumb section: "under an agent instance the trail
// names the agent's display name". The pane opens only for a reader the run's
// access check allowed, but it published no name, so that reader saw "Agent run",
// the label the drawing keeps for a refused or missing run.
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  AuthzError: class AuthzErrorStub extends Error {},
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/authz", () => ({ AuthzError: mocks.AuthzError }));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => ({
    user: { id: "u1" },
    session: { activeOrganizationId: "org-1" },
  })),
  isPlatformAdmin: () => false,
  resolveOrgRoleForSession: vi.fn(async () => "member"),
  signInRedirectTarget: vi.fn(async () => "/sign-in"),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentRunById: mocks.readAgentRunById,
  readAgentTemplateById: mocks.readAgentTemplateById,
}));
vi.mock("@/lib/agent-run-skills-used", () => ({ listSkillsUsedForRun: vi.fn(() => []) }));
vi.mock("@/lib/run-selected-skill-revisions", () => ({
  readRunSelectedSkillRevisions: vi.fn(() => []),
}));
vi.mock("@/lib/agent-instance-tab-title", () => ({
  resolveAgentInstanceMetadata: vi.fn(async () => ({})),
  agentInstancePathname: ({
    vendor,
    packageName,
    instanceId,
  }: {
    vendor: string;
    packageName: string;
    instanceId: string;
  }) => `/agents/${vendor}/${packageName}/${instanceId}`,
}));
vi.mock("@/components/layout/main", () => ({
  Main: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/page-content", () => ({
  PageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/page-header", () => ({
  PageHeader: ({ title }: { title?: string }) => <header data-title={title} />,
}));
vi.mock("@/components/crumb-contributions", () => ({
  CrumbContributions: ({ entries }: { entries: unknown }) => (
    <span data-testid="crumbs">{JSON.stringify(entries)}</span>
  ),
}));

import AgentPackageInstanceSkillsPage from "@/app/agents/[vendor]/[packageName]/[instanceId]/skills/page";

const RUN_ID = "9c0dfce6-b2cb-4dab-8a01-661ca3288b9a";
const PERSONAL_ANCHOR = { v: 1, kind: "user", id: "u1" };
const BARE_PATH = `/agents/cinatra-ai/author-agent/${RUN_ID}`;
const params = () =>
  Promise.resolve({ vendor: "cinatra-ai", packageName: "author-agent", instanceId: RUN_ID });

function crumbsIn(tree: unknown): { prefix: string; label: string }[] {
  const html = renderToStaticMarkup(tree as React.ReactElement);
  const m = /data-testid="crumbs">([^<]*)</.exec(html);
  if (!m) throw new Error("no crumbs published");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readAgentRunById.mockResolvedValue({
    id: RUN_ID,
    title: "Blog Draft Writer Agent (1)",
    templateId: "tpl-1",
    launchScopeAnchor: null,
  });
  mocks.readAgentTemplateById.mockResolvedValue({ name: "Blog Draft Writer Agent" });
});

describe("the skills pane's run crumb", () => {
  it("publishes the run's title at the run's own path", async () => {
    const tree = await AgentPackageInstanceSkillsPage({ params: params() });
    expect(crumbsIn(tree)).toEqual([{ prefix: BARE_PATH, label: "Blog Draft Writer Agent (1)" }]);
  });

  it("falls back to the template's name when the run has no title", async () => {
    mocks.readAgentRunById.mockResolvedValue({ id: RUN_ID, title: null, templateId: "tpl-1" });
    const tree = await AgentPackageInstanceSkillsPage({ params: params() });
    expect(crumbsIn(tree)).toEqual([{ prefix: BARE_PATH, label: "Blog Draft Writer Agent" }]);
  });

  it("shows the id's first eight characters when no name can be read", async () => {
    mocks.readAgentRunById.mockResolvedValue({ id: RUN_ID, title: null, templateId: "tpl-1" });
    mocks.readAgentTemplateById.mockRejectedValue(new Error("database down"));
    const tree = await AgentPackageInstanceSkillsPage({ params: params() });
    expect(crumbsIn(tree)).toEqual([{ prefix: BARE_PATH, label: `${RUN_ID.slice(0, 8)}…` }]);
  });

  it("names the owner beside a personal run's name", async () => {
    mocks.readAgentRunById.mockResolvedValue({
      id: RUN_ID,
      title: "Blog Draft Writer Agent (1)",
      launchScopeAnchor: PERSONAL_ANCHOR,
    });
    const tree = await AgentPackageInstanceSkillsPage({ params: params() });
    expect(crumbsIn(tree)[0]!.label).toBe("Blog Draft Writer Agent (1) · Personal (owner)");
  });

  it("publishes the scope's crumbs and the run's at the scoped path under a scope", async () => {
    const tree = await AgentPackageInstanceSkillsPage({
      params: params(),
      scopeBase: "/organizations/o1",
      launchScope: { kind: "organization", id: "o1" },
      scopeTitle: "Acme",
    });
    expect(crumbsIn(tree)).toEqual([
      { prefix: "/organizations/o1", label: "Acme" },
      { prefix: "/organizations/o1/agents", label: "Agents" },
      { prefix: `/organizations/o1${BARE_PATH}`, label: "Blog Draft Writer Agent (1)" },
    ]);
  });

  it("reads no template and publishes nothing for a run the access check refuses", async () => {
    mocks.readAgentRunById.mockRejectedValue(new mocks.AuthzError("refused"));
    await expect(AgentPackageInstanceSkillsPage({ params: params() })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(mocks.readAgentTemplateById).not.toHaveBeenCalled();
  });
});
