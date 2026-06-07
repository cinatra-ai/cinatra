/**
 * DelegatedAgentRun snapshot tests.
 *
 * Covers: snapshot capture, reconstruct, revocation detection.
 */
import "server-only";
import { describe, expect, it } from "vitest";
import { POLICY_VERSION, type ActorContext, type ProjectGrant } from "../actor-context";
import {
  captureDelegatedActorSnapshot,
  reconstructActorFromSnapshot,
  detectRevokedGrants,
} from "../delegated-agent-run";

const grants: ProjectGrant[] = [
  { projectId: "proj-a", effectiveRole: "write", accessSource: "user" },
  { projectId: "proj-b", effectiveRole: "read",  accessSource: "team" },
];

function humanActor(over: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    authSource: "mcp",
    policyVersion: POLICY_VERSION,
    organizationId: "org-1",
    orgRole: "member",
    teamIds: ["team-1"],
    projectGrants: grants,
    projectIds: ["proj-a", "proj-b"],
    ...over,
  } as ActorContext;
}

describe("delegated-agent-run snapshot", () => {
  it("captures the salient identity bits from a HumanUser actor", () => {
    const snap = captureDelegatedActorSnapshot(humanActor());
    expect(snap).toBeDefined();
    expect(snap?.ownerUserId).toBe("user-1");
    expect(snap?.organizationId).toBe("org-1");
    expect(snap?.projectGrants).toEqual(grants);
    expect(snap?.teamIds).toEqual(["team-1"]);
    expect(snap?.ownerScope).toEqual({ level: "team", recordId: "team-1" });
    expect(snap?.orgRole).toBe("member");
  });

  it("returns undefined for non-Human principal types", () => {
    const sa = humanActor({ principalType: "ServiceAccount" });
    expect(captureDelegatedActorSnapshot(sa)).toBeUndefined();
  });

  it("returns undefined when the actor has no organization", () => {
    const orgless = humanActor({ organizationId: undefined });
    expect(captureDelegatedActorSnapshot(orgless)).toBeUndefined();
  });

  it("reconstructs an ActorContext-shaped envelope", () => {
    const snap = captureDelegatedActorSnapshot(humanActor())!;
    const a = reconstructActorFromSnapshot(snap);
    expect(a.principalType).toBe("HumanUser");
    expect(a.principalId).toBe("user-1");
    expect(a.organizationId).toBe("org-1");
    expect(a.projectGrants).toEqual(grants);
    expect(a.projectIds).toEqual(["proj-a", "proj-b"]);
    expect(a.policyVersion).toBe("v2");
    expect(a.authSource).toBe("worker");
  });

  it("reconstructs with live grants overriding the snapshot (mid-run revocation)", () => {
    const snap = captureDelegatedActorSnapshot(humanActor())!;
    const live: ProjectGrant[] = [{ projectId: "proj-a", effectiveRole: "write", accessSource: "user" }];
    const a = reconstructActorFromSnapshot(snap, { liveGrants: live });
    expect(a.projectGrants).toEqual(live);
    expect(a.projectIds).toEqual(["proj-a"]);
  });

  it("detects revoked grants between snapshot and live", () => {
    const snap = captureDelegatedActorSnapshot(humanActor())!;
    const live: ProjectGrant[] = [{ projectId: "proj-a", effectiveRole: "read", accessSource: "user" }];
    expect(detectRevokedGrants(snap, live)).toEqual(["proj-b"]);
  });

  it("returns [] when no grants were revoked", () => {
    const snap = captureDelegatedActorSnapshot(humanActor())!;
    expect(detectRevokedGrants(snap, grants)).toEqual([]);
  });

  it("preserves the `roles[]` axis when present", () => {
    const a = humanActor({ ...({ roles: ["developer"] } as Partial<ActorContext>) });
    const snap = captureDelegatedActorSnapshot(a);
    expect(snap?.roles).toEqual(["developer"]);
    const round = reconstructActorFromSnapshot(snap!);
    expect((round as ActorContext & { roles?: string[] }).roles).toEqual(["developer"]);
  });
});
