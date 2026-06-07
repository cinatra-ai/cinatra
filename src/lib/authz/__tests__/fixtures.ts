import { expect } from "vitest";
import {
  POLICY_VERSION,
  can,
  type ActorContext,
  type ResourceRef,
  type Permission,
} from "@/lib/authz";

export const ORG_A = "org-a";
export const ORG_B = "org-b";

export const FIXT_ADMIN: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-admin",
  organizationId: ORG_A,
  platformRole: "platform_admin",
  orgRole: "member",
  authSource: "ui",
  policyVersion: POLICY_VERSION,
};

export const FIXT_MEMBER_A: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-1",
  organizationId: ORG_A,
  platformRole: "member",
  orgRole: "member",
  authSource: "ui",
  policyVersion: POLICY_VERSION,
};

export const FIXT_MEMBER_B: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-2",
  organizationId: ORG_B,
  platformRole: "member",
  orgRole: "member",
  authSource: "ui",
  policyVersion: POLICY_VERSION,
};

export const FIXT_SERVICE_ACCOUNT: ActorContext = {
  principalType: "ServiceAccount",
  principalId: "svc-1",
  organizationId: ORG_A,
  authSource: "agent",
  policyVersion: POLICY_VERSION,
};

export const RES_AGENT_ORG_A: ResourceRef = {
  resourceType: "agent",
  resourceId: "agent-1",
  organizationId: ORG_A,
};

export const RES_AGENT_ORG_B: ResourceRef = {
  resourceType: "agent",
  resourceId: "agent-2",
  organizationId: ORG_B,
};

export function expectPermission(
  actor: ActorContext,
  action: Permission,
  resource: ResourceRef,
  expected: boolean,
): void {
  const got = can(actor, action, resource);
  expect(
    got,
    `${actor.principalId} ${action} ${resource.resourceId} expected ${expected} got ${got}`,
  ).toBe(expected);
}
