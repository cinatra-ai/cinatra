/**
 * JWT scope claim to Permission[] mapping.
 *
 * Tier-agnostic pure data transform reused by token scope hydration,
 * enforce-time permission intersection, and unit tests.
 *
 * Unknown scope strings are silently dropped; the authorization kernel's
 * can() checks still gate access via role-based grants if a scope is missing.
 */
import type { Permission } from "./permissions";

const PERMISSION_SET = new Set<string>([
  "agent.read", "agent.list", "agent.execute", "agent.update", "agent.delete",
  "agent.share", "agent.managePermissions",
  "run.read", "run.list", "run.readData", "run.cancel", "run.share",
  "run.approveHitl", "run.respondToHitl", "run.resume", "run.editOutput",
  "object.read", "object.list", "object.search", "object.create", "object.update",
  "object.delete", "object.promoteScope",
  "project.read", "project.list", "project.create", "project.update",
  "project.delete", "project.manageMembers",
  "team.read", "team.list", "team.create", "team.update", "team.delete",
  "team.manageMembers",
  "organization.read", "organization.list", "organization.create",
  "organization.update", "organization.delete", "organization.manageMembers",
  "skill.read", "skill.list", "skill.assign", "skill.create", "skill.update",
  "skill.delete", "skill.install", "skill.manageVisibility",
  "connector.read", "connector.use", "connector.create", "connector.update",
  "connector.delete",
  "registry.read", "registry.install", "registry.update", "registry.uninstall",
  "settings.read", "settings.update", "audit.read",
]);

export function parseTokenScopes(scopeString: string | undefined): Permission[] {
  if (!scopeString) return [];
  return scopeString.trim().split(/\s+/).filter((s) => PERMISSION_SET.has(s)) as Permission[];
}
