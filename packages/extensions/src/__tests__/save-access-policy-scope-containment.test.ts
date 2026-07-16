/**
 * AC5 — server authority is the boundary (cinatra#1607 §5 / spec §6.8).
 *
 * `parentScope` / `allowedScopes` are DISPLAY affordances only; the picker's
 * containment narrowing is never accepted as proof of containment. This is a
 * REQUEST-LEVEL negative test: it drives the actual `saveExtensionAccessPolicy`
 * server action (the write request handler) with a CRAFTED agent_run policy that
 * presents a scope OUTSIDE the parent agent_template's containment set — as a
 * forged/stale client would — and asserts the server INDEPENDENTLY rejects it
 * with `scope_exceeds_parent` and writes NOTHING. A positive control (an
 * in-scope descendant) proves the harness is not simply rejecting everything.
 *
 * The full request path is exercised: zod validation → actor auth → resource
 * existence → edit gate → containment assertion → reject-before-write. No UI is
 * involved — UI screenshots cannot prove server authority (AC5 wording).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";

// Lenient-UUID tails (match AgentAuthPolicyVisibilitySchema's UUID_TAIL) so the
// crafted tokens are zod-VALID and reach the containment check rather than
// bouncing at the schema as "invalid".
const ORG_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const TEAM_T = "cccccccc-0000-4000-8000-0000000000c1";

function policy(v: string): AgentAuthPolicy {
  return {
    runListVisibility: [v as AgentAuthPolicy["runListVisibility"][number]],
    runDataVisibility: [v as AgentAuthPolicy["runDataVisibility"][number]],
    runExecuteVisibility: [v as AgentAuthPolicy["runExecuteVisibility"][number]],
    allowRunSharing: false,
  };
}

// Parent agent_template policy: org:A on every field. The run's policy must be
// ⊆ this. org:B / a foreign team / workspace all sit OUTSIDE it.
const PARENT_POLICY = policy(`org:${ORG_A}`);

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Authenticated human actor who is the run's installer (so the edit gate opens
// via the legacy installer branch — no owner-context evaluator needed).
vi.mock("@/lib/auth-session", () => ({
  getActorContext: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "user-1",
    platformRole: "member",
  })),
  requireAuthSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

// Store spies: the assertion is that on rejection NOTHING is written.
const writeMock = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("../permissions-store", () => ({
  writeExtensionAccessPolicy: (...a: unknown[]) => writeMock(...a),
  readExtensionAccessPolicy: vi.fn(async () => null),
  readExtensionCoOwners: vi.fn(async () => []),
  readExtensionInstalledBy: vi.fn(async () => "user-1"),
  addExtensionCoOwner: vi.fn(),
  removeExtensionCoOwner: vi.fn(),
}));

// agent_run kind hooks: resource exists; no owner anchor (legacy edit gate);
// no post-write projection / write veto.
vi.mock("../permissions-kind-hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../permissions-kind-hooks")>();
  return {
    ...actual,
    getExtensionKindHooks: vi.fn(async () => ({
      resourceExists: vi.fn(async () => true),
      extraEditors: vi.fn(async () => [] as string[]),
    })),
  };
});

// The run + its parent template. The template's agentAuthPolicy is the parent
// scope the write must be contained by.
vi.mock("@cinatra-ai/agents/store", () => ({
  readAgentRunById: vi.fn(async () => ({ id: "run-1", templateId: "tpl-1", orgId: ORG_A })),
  readAgentTemplateById: vi.fn(async () => ({ id: "tpl-1", agentAuthPolicy: PARENT_POLICY, orgId: ORG_A })),
}));

// team → org parentage lookup (only fires for a team child). Configurable per
// test: a team in org B is a foreign descendant (rejected); a team in org A is
// an in-scope descendant (accepted).
const teamOrgResult: { rows: Array<{ organizationId: string }> } = { rows: [] };
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { execute: vi.fn(async () => teamOrgResult) },
  betterAuthUsers: {},
}));

async function save(craftedPolicy: AgentAuthPolicy) {
  const { saveExtensionAccessPolicy } = await import("../permissions-actions");
  return saveExtensionAccessPolicy("agent_run", "run-1", craftedPolicy);
}

beforeEach(() => {
  vi.clearAllMocks();
  teamOrgResult.rows = [];
});

describe("saveExtensionAccessPolicy(agent_run) — server authority rejects an out-of-containment scope", () => {
  it("REJECTS a foreign org (org:B) presented against an org:A parent — scope_exceeds_parent, no write", async () => {
    const result = await save(policy(`org:${ORG_B}`));
    expect(result).toEqual({ ok: false, error: "scope_exceeds_parent" });
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("REJECTS a foreign team (a team in org B) against an org:A parent — strict-descendants boundary", async () => {
    teamOrgResult.rows = [{ organizationId: ORG_B }]; // team T belongs to org B
    const result = await save(policy(`team:${TEAM_T}`));
    expect(result).toEqual({ ok: false, error: "scope_exceeds_parent" });
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("REJECTS a broadening to workspace against an org:A parent — no write", async () => {
    const result = await save(policy("workspace"));
    expect(result).toEqual({ ok: false, error: "scope_exceeds_parent" });
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("REJECTS a mixed policy whose SINGLE out-of-scope field (exec=org:B) exceeds the parent", async () => {
    const result = await save({
      runListVisibility: [`org:${ORG_A}`],
      runDataVisibility: [`org:${ORG_A}`],
      runExecuteVisibility: [`org:${ORG_B}`], // the one forged field
      allowRunSharing: false,
    });
    expect(result).toEqual({ ok: false, error: "scope_exceeds_parent" });
    expect(writeMock).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: an in-scope descendant (a team in org A) is ACCEPTED and written", async () => {
    teamOrgResult.rows = [{ organizationId: ORG_A }]; // team T belongs to org A (the parent)
    const result = await save(policy(`team:${TEAM_T}`));
    expect(result).toEqual({ ok: true });
    expect(writeMock).toHaveBeenCalledTimes(1);
  });
});
