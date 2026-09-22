/**
 * THE ASSIGNMENT PAGE'S MODEL (cinatra#2814, per-scope assignment S2).
 *
 *   - the page carries the resolved package, the default Skills tab, and the
 *     route-derived scope, or nothing at all for a pair the reader does not
 *     reach;
 *   - the Artifacts pane lists "the agent's declared context slots from its
 *     trusted OAS manifest", with an honest empty state when the manifest
 *     declares none, and a separate reading when it cannot be read;
 *   - the rows are exactly what the S1 stores hold at the section's EXACT
 *     scope tuple; a chosen skill that has since degraded stays listed;
 *   - an assistant's `?tab=artifacts` normalizes to Skills and reads no slot.
 */
import { describe, expect, it, vi } from "vitest";

import type { ActorContext } from "@/lib/authz/actor-context";
import { buildWorkspaceVantage } from "@/lib/scope-surface-vantage";
import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";
import type { SkillAssignability } from "@cinatra-ai/skills/agent-skill-assignability";
import type { ScopeAssignmentArtifactAccess } from "@/lib/scope-assignment/scope-assignment-reads.server";
import {
  loadScopeAssignmentPage,
  scopeAssignmentScopeLabel,
  type ScopeAssignmentPageDeps,
} from "@/lib/scope-assignment/scope-assignment-page.server";

const ME = "user_me";
const ORG = "org_acme";
const TEAM = "team_growth";
const PKG = "@cinatra-ai/research-agent";

const BRAND: AgentContextSlot = {
  slotId: "brand-voice",
  acceptedArtifactExtensions: ["@cinatra-ai/brand-kit-artifact"],
  selectionMode: "interactive",
  resolutionMode: "accumulate",
  minItems: 1,
  maxItems: 2,
};

function deps(opts: { slots?: AgentContextSlot[] | "unreadable" } = {}) {
  const base = {
    principalType: "HumanUser",
    principalId: ME,
    authSource: "ui",
    policyVersion: "v2",
    organizationId: ORG,
    platformRole: "member",
    orgRole: "member",
    teamIds: [],
    projectGrants: [],
  } as ActorContext;
  const verdict = (skillId: string, reason: SkillAssignability["reason"]): SkillAssignability => ({
    skillId,
    assignable: reason === null,
    reason,
    ownerPackageName: "@cinatra-ai/blog-skills",
    role: "injectable",
    skill: { id: skillId, name: skillId === "sk_ok" ? "Blog Writing" : "Brand Voice", description: "", level: null },
  });
  const d: ScopeAssignmentPageDeps = {
    target: {
      readSession: async () => ({ userId: ME, activeOrgId: ORG }),
      readBaseActor: async () => base,
      readGrantsInOrg: async () => ({ teamIds: [TEAM], teamRoles: { [TEAM]: "team_admin" }, projectGrants: [] }),
      readMembership: async () => ({
        vantage: buildWorkspaceVantage({ userId: ME, memberships: [{ orgId: ORG }], teamIdsByOrg: { [ORG]: [TEAM] } }),
        scopeNames: { [`organization:${ORG}`]: "Acme", [`team:${TEAM}`]: "Growth" },
      }),
      readAgentRows: async () => [
        { key: PKG, name: "Research Agent", description: "", host: "local", packageName: PKG, detailHref: null, runHref: "", settingsHref: "", version: null, status: "active" },
      ],
      readAssistantRows: async () => [
        { key: "@cinatra-ai/support-assistant", packageName: "@cinatra-ai/support-assistant", vendor: "cinatra-ai", slug: "support", displayName: "Support Assistant", description: null, chatHref: "", settingsHref: "", remoteCapable: false, remoteInstances: [], version: null, status: "active" },
      ],
      assertWriteTarget: async () => ({ ok: true }),
    },
    reads: {
      readAssignedSkills: vi.fn(async (_pkg: string, scope: { scopeKind: string }) =>
        scope.scopeKind === "team" ? [{ skillId: "sk_ok" }, { skillId: "sk_archived" }] : [],
      ),
      resolveAssignability: vi.fn(
        async (ids: string[]) =>
          new Map(ids.map((id) => [id, verdict(id, id === "sk_ok" ? null : "archived")])),
      ),
      listSkillCandidates: vi.fn(async () => [
        {
          skillId: "sk_ok",
          skillName: "Blog Writing",
          skillDescription: "",
          ownerPackageName: "@cinatra-ai/blog-skills",
          ownerPackageCandidates: ["@cinatra-ai/blog-skills"],
          extensionDisplayName: "Blog Skills",
          extensionVendorName: "Cinatra",
          extensionAuthor: null,
          role: "injectable" as const,
        },
      ]),
      readInstallStatuses: vi.fn(async () => new Map()),
      readAssignedContext: vi.fn(async () => [
        { slotId: "brand-voice", artifactId: "res_kit" },
        { slotId: "brand-voice", artifactId: "res_gone" },
        { slotId: "not-declared", artifactId: "res_other" },
      ]),
      readArtifact: vi.fn(async ({ artifactId }: { artifactId: string }): Promise<ScopeAssignmentArtifactAccess> =>
        artifactId === "res_gone"
          ? { kind: "not-found" }
          : {
              kind: "ok",
              artifact: {
                artifactId,
                title: "Brand Kit 2026",
                eligibleExtensions: ["@cinatra-ai/brand-kit-artifact"],
                primaryExtension: null,
                projectId: null,
              },
            },
      ),
      listArtifacts: vi.fn(async () => []),
      expandAcceptedExtensions: vi.fn(async (accepted: readonly string[]) => [...accepted]),
      artifactKindLabel: () => "Brand Kit",
      resolveVendorName: (input) => input.manifestVendorName ?? input.author,
    },
    readSlots: vi.fn(async () =>
      opts.slots === "unreadable"
        ? ({ ok: false, reason: "manifest-unreadable" } as const)
        : { ok: true as const, slots: opts.slots ?? [BRAND] },
    ),
  };
  return d;
}

describe("loadScopeAssignmentPage", () => {
  it("carries the resolved package, the Skills default and the route-derived scope", async () => {
    const page = await loadScopeAssignmentPage(
      { surface: "agent", scope: { kind: "team", id: TEAM }, vendor: "cinatra-ai", name: "research-agent", tab: undefined },
      deps(),
    );
    expect(page).toMatchObject({
      surface: "agent",
      tab: "skills",
      routeScope: { kind: "team", id: TEAM },
      packageName: PKG,
      displayName: "Research Agent",
      scopeLabel: "Team · Growth",
      crossScope: false,
      manifest: null,
      target: { surface: "agent", scope: { kind: "team", id: TEAM }, vendor: "cinatra-ai", name: "research-agent" },
    });
    expect(page!.sections).toHaveLength(1);
    expect(page!.sections[0]!.write).toEqual({ allowed: true, road: "grant" });
  });

  it("lists exactly the section's rows, a degraded skill included, and reads no slot on the Skills pane", async () => {
    const d = deps();
    const page = await loadScopeAssignmentPage(
      { surface: "agent", scope: { kind: "team", id: TEAM }, vendor: "cinatra-ai", name: "research-agent", tab: "skills" },
      d,
    );
    expect(d.reads.readAssignedSkills).toHaveBeenCalledWith(PKG, { scopeKind: "team", scopeId: TEAM });
    expect(page!.sections[0]!.skills).toEqual([
      { skillId: "sk_ok", skillName: "Blog Writing", displayName: "Blog Skills", vendorName: "Cinatra", status: "ok" },
      { skillId: "sk_archived", skillName: "Brand Voice", displayName: "@cinatra-ai/blog-skills", vendorName: null, status: "archived" },
    ]);
    expect(page!.sections[0]!.slots).toBeNull();
    expect(d.readSlots).not.toHaveBeenCalled();
  });

  it("draws the manifest's declared slots on the Artifacts pane, with the rows this scope chose", async () => {
    const d = deps();
    const page = await loadScopeAssignmentPage(
      { surface: "agent", scope: { kind: "team", id: TEAM }, vendor: "cinatra-ai", name: "research-agent", tab: "artifacts" },
      d,
    );
    expect(page!.tab).toBe("artifacts");
    expect(page!.manifest).toBe("ok");
    expect(d.readSlots).toHaveBeenCalledWith(PKG);
    expect(d.reads.readAssignedContext).toHaveBeenCalledWith(PKG, { scopeKind: "team", scopeId: TEAM });
    expect(page!.sections[0]!.skills).toBeNull();
    expect(page!.sections[0]!.slots).toEqual([
      {
        slotId: "brand-voice",
        title: "Brand voice",
        takesText: "Takes a brand kit · 1 required, at most 2",
        placeholder: "Search brand kits…",
        maxItems: 2,
        rows: [
          { artifactId: "res_kit", title: "Brand Kit 2026", kindLabel: "Brand Kit", status: "ok" },
          { artifactId: "res_gone", title: null, kindLabel: null, status: "deleted" },
        ],
      },
    ]);
  });

  it("reads a slot-less manifest as the honest empty state, and an unreadable one as unreadable", async () => {
    const empty = await loadScopeAssignmentPage(
      { surface: "agent", scope: { kind: "personal" }, vendor: "cinatra-ai", name: "research-agent", tab: "artifacts" },
      deps({ slots: [] }),
    );
    expect(empty!.manifest).toBe("no-slots");
    expect(empty!.sections[0]!.slots).toBeNull();
    const unreadable = await loadScopeAssignmentPage(
      { surface: "agent", scope: { kind: "personal" }, vendor: "cinatra-ai", name: "research-agent", tab: "artifacts" },
      deps({ slots: "unreadable" }),
    );
    expect(unreadable!.manifest).toBe("unreadable");
  });

  it("normalizes an assistant's ?tab=artifacts to Skills and reads no manifest", async () => {
    const d = deps();
    const page = await loadScopeAssignmentPage(
      { surface: "assistant", scope: { kind: "personal" }, vendor: "cinatra-ai", name: "support", tab: "artifacts" },
      d,
    );
    expect(page).toMatchObject({ surface: "assistant", tab: "skills", packageName: "@cinatra-ai/support-assistant", manifest: null });
    expect(d.readSlots).not.toHaveBeenCalled();
    expect(page!.sections[0]!.slots).toBeNull();
  });

  it("is nothing for a pair the reader does not reach", async () => {
    expect(
      await loadScopeAssignmentPage(
        { surface: "agent", scope: { kind: "team", id: TEAM }, vendor: "cinatra-ai", name: "forged", tab: undefined },
        deps(),
      ),
    ).toBeNull();
  });

  it("puts a refused section's reason into words", async () => {
    const d = deps();
    d.target.readGrantsInOrg = async () => ({ teamIds: [TEAM], teamRoles: { [TEAM]: "member" }, projectGrants: [] });
    const page = await loadScopeAssignmentPage(
      { surface: "agent", scope: { kind: "team", id: TEAM }, vendor: "cinatra-ai", name: "research-agent", tab: undefined },
      d,
    );
    expect(page!.sections[0]!.write).toEqual({
      allowed: false,
      message: "Only an admin of this team can change these assignments.",
    });
  });
});

describe("scopeAssignmentScopeLabel", () => {
  it("names the workspace and the personal scope by their own word, the others by kind and name", () => {
    expect(scopeAssignmentScopeLabel({ kind: "workspace" }, {})).toBe("Workspace");
    expect(scopeAssignmentScopeLabel({ kind: "personal" }, {})).toBe("Personal");
    expect(scopeAssignmentScopeLabel({ kind: "team", id: TEAM }, { [`team:${TEAM}`]: "Growth" })).toBe("Team · Growth");
  });

  it("never shows a whole raw id when the name is unavailable", () => {
    expect(scopeAssignmentScopeLabel({ kind: "project", id: "9c0dfce6-1b7a-4a51" }, {})).toBe("Project · 9c0dfce6…");
  });
});
