/**
 * Unit tests for `listBindableAgentTemplatesAction` (cinatra#1503, design
 * cinatra#1509 §4.4) — the bind picker's candidate enumeration.
 *
 * Proven here:
 *  - AUTHORITY: the action is gated on the SAME authority as the bind
 *    (create) action — a write-rank project grant (or platform_admin). A
 *    read-rank viewer gets `forbidden` and the catalog is NEVER enumerated
 *    for them.
 *  - EXCLUSION: templates the project already binds (per the authoritative
 *    `project_agent_template_bindings_list` handler result) are excluded.
 *  - ENUMERATION SOURCE: candidates come from the canonical
 *    `readAgentsForSkillMatching` reader — the installed-agents union whose
 *    provider-declared walk honors the operator's own vendor dir
 *    (cinatra#538; agents-store.ts `safeProviderVendorSegments`). Delegating
 *    to that single reader IS the vendor-dir guarantee; its enumeration
 *    behavior stays covered by the agents-store tests.
 *  - ERRORS: an AuthzError from the list handler surfaces as its reason
 *    (e.g. `hidden` for a nonexistent project), never as a throw.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { AuthzError } from "@/lib/authz/errors";
import type { ProjectGrant } from "@/lib/authz/actor-context";

import { listBindableAgentTemplatesAction } from "../actions";

// --- mocks -----------------------------------------------------------------

let platformAdmin = false;
let grants: ProjectGrant[] = [];
let boundItems: Array<{ agentTemplateId: string }> = [];
let listHandlerError: unknown = null;
const listHandlerCalls: unknown[] = [];

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn(async () => ({
    user: { id: "u1" },
    session: { activeOrganizationId: "org1" },
  })),
  isPlatformAdmin: vi.fn(() => platformAdmin),
  resolveOrgRoleForSession: vi.fn(async () => "member"),
}));

vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectGrantsForUser: vi.fn(async () => grants),
}));

vi.mock("@cinatra-ai/projects", () => ({
  handlers: {
    project_agent_template_bindings_list: vi.fn(async (req: unknown) => {
      listHandlerCalls.push(req);
      if (listHandlerError) throw listHandlerError;
      return { items: boundItems };
    }),
  },
}));

const readAgentsForSkillMatching = vi.fn(async () => [
  {
    packageId: "@cinatra-ai/agent-scrape",
    humanReadableName: "Web Scrape Agent",
    description: "Scrapes the web.",
  },
  {
    packageId: "@marcus-local/custom-agent",
    humanReadableName: "Custom Agent",
    description: "Operator-vendor authored agent.",
  },
  {
    packageId: "@cinatra-ai/agent-email",
    humanReadableName: "Email Drafting Agent",
    description: "Drafts emails.",
  },
]);
vi.mock("@/lib/agents-store", () => ({
  readAgentsForSkillMatching: (...args: unknown[]) =>
    readAgentsForSkillMatching(...(args as [])),
}));

beforeEach(() => {
  platformAdmin = false;
  grants = [];
  boundItems = [];
  listHandlerError = null;
  listHandlerCalls.length = 0;
  readAgentsForSkillMatching.mockClear();
});

const writeGrant: ProjectGrant = {
  projectId: "p1",
  effectiveRole: "write",
  accessSource: "user",
};

describe("listBindableAgentTemplatesAction", () => {
  it("returns the installed catalog minus already-bound ids, name-sorted", async () => {
    grants = [writeGrant];
    boundItems = [{ agentTemplateId: "@cinatra-ai/agent-scrape" }];

    const r = await listBindableAgentTemplatesAction("p1");

    expect(r).toEqual({
      ok: true,
      items: [
        {
          agentTemplateId: "@marcus-local/custom-agent",
          humanReadableName: "Custom Agent",
          description: "Operator-vendor authored agent.",
        },
        {
          agentTemplateId: "@cinatra-ai/agent-email",
          humanReadableName: "Email Drafting Agent",
          description: "Drafts emails.",
        },
      ],
    });
    // Candidates come from the canonical installed-agents reader (the union
    // whose provider walk honors operator-vendor dirs — cinatra#538).
    expect(readAgentsForSkillMatching).toHaveBeenCalledTimes(1);
    // The bound-id set comes from the authoritative list handler.
    expect(listHandlerCalls).toHaveLength(1);
  });

  it("denies a read-rank grant with `forbidden` and never enumerates the catalog", async () => {
    grants = [{ ...writeGrant, effectiveRole: "read" }];

    const r = await listBindableAgentTemplatesAction("p1");

    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(readAgentsForSkillMatching).not.toHaveBeenCalled();
  });

  it("denies with `forbidden` when the actor has no grant for the project", async () => {
    grants = [];

    const r = await listBindableAgentTemplatesAction("p1");

    expect(r).toEqual({ ok: false, error: "forbidden" });
    expect(readAgentsForSkillMatching).not.toHaveBeenCalled();
  });

  it("passes a platform admin without any project grant", async () => {
    platformAdmin = true;

    const r = await listBindableAgentTemplatesAction("p1");

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items.map((t) => t.agentTemplateId)).toEqual([
        "@marcus-local/custom-agent",
        "@cinatra-ai/agent-email",
        "@cinatra-ai/agent-scrape",
      ]);
    }
  });

  it("surfaces an AuthzError from the list handler as its reason (hidden project)", async () => {
    grants = [writeGrant];
    listHandlerError = new AuthzError({
      statusCode: 404,
      reason: "hidden",
      message: "Not found.",
    });

    const r = await listBindableAgentTemplatesAction("p1");

    expect(r).toEqual({ ok: false, error: "hidden" });
    expect(readAgentsForSkillMatching).not.toHaveBeenCalled();
  });
});
