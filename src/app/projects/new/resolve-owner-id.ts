// Pure helper extracted for unit testability — no Next.js / Drizzle / network deps.
// Security: owner_id is resolved server-side
// from session + ownerLevel + the appropriate picker field. The function NEVER
// trusts a client-supplied `ownerId` value (mass-assignment defense — V5).

export type OwnerLevel = "user" | "team" | "organization";

export type ResolveOwnerIdInput = {
  sessionUserId: string;
  ownerLevel: OwnerLevel;
  teamId?: string;
  organizationId?: string;
};

export type ResolveOwnerIdResult =
  | { ownerId: string }
  | { error: "team-required" | "org-required" | "invalid-owner-level" };

export function resolveOwnerId(input: ResolveOwnerIdInput): ResolveOwnerIdResult {
  const { sessionUserId, ownerLevel } = input;

  if (ownerLevel === "user") {
    return { ownerId: sessionUserId };
  }

  if (ownerLevel === "team") {
    const t = input.teamId?.trim() ?? "";
    if (!t) return { error: "team-required" };
    return { ownerId: t };
  }

  if (ownerLevel === "organization") {
    const o = input.organizationId?.trim() ?? "";
    if (!o) return { error: "org-required" };
    return { ownerId: o };
  }

  return { error: "invalid-owner-level" };
}
