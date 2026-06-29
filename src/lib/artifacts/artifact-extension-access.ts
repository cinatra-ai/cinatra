import "server-only";

// ---------------------------------------------------------------------------
// Artifact-extension access gate.
//
// Bridges the artifact-authoring surfaces to the uniform polymorphic access
// model. An artifact extension's npm package name (the object-type id minus the
// `:artifact` suffix) IS its `installed_extension.package_name`, so we resolve
// the canonical install row and delegate to `canExtensionAccess`.
//
// Governance scope: ONLY install-tracked artifact extensions are governed. A
// disk-registered dev artifact with no `installed_extension` row is treated as
// ungoverned (allowed) — the access model governs INSTALLED extensions, and
// failing closed there would block every disk-registered dev artifact. A DB
// read error fails CLOSED (deny). The sealed-room project gate
// (assertProjectReadAccess) is orthogonal and unchanged.
// ---------------------------------------------------------------------------

import type { ActorContext } from "@/lib/authz/actor-context";
import {
  canExtensionAccess,
  type ExtensionAccessOp,
} from "@cinatra-ai/extensions/enforce-extension-access";
import { readInstalledExtensionsByPackageName } from "@cinatra-ai/extensions/canonical-store";
import { resolveOrgRoleForUser } from "@/lib/auth-session";

/**
 * MCP-path actors carry platformRole but not orgRole. Resolve it from
 * (orgId, userId) so the owner-aware "admin" tier recognizes org admins/owners.
 * No-op when orgRole is already present (session path) or there's no human
 * user / org to resolve against.
 */
async function withResolvedOrgRole(
  actor: ActorContext | undefined | null,
): Promise<ActorContext | undefined | null> {
  if (!actor || actor.orgRole || actor.principalType !== "HumanUser" || !actor.organizationId) {
    return actor;
  }
  const orgRole = await resolveOrgRoleForUser(actor.organizationId, actor.principalId);
  return orgRole ? { ...actor, orgRole } : actor;
}

/**
 * STATUS-ONLY artifact-extension write gate (cinatra#661, CG-4).
 *
 * The DURABLE, ACTOR-LESS authz half of `canAccessArtifactExtension`: a write
 * to a `<pkg>:artifact` semantic type is allowed iff the package is NOT a
 * deliberately-archived install for the WRITING ORG's scope. Used by the
 * ACTOR-LESS assert paths that cannot run the polymorphic actor-access check —
 * the background LLM matcher (`matcher-runtime.ts`, `assertedBy:"matcher"`) and
 * the deterministic agent-`produces` splice (`producer-assertions.ts`,
 * `assertedBy:"agent"`). Both carry the artifact's org (`payload.orgId` /
 * `input.orgId`), so the gate is org-scoped to avoid a cross-org status bleed.
 *
 * This gate is DB-STATUS-DRIVEN, never registry-membership-driven, so it holds
 * in EVERY process regardless of whether that process received the in-memory
 * capability teardown: a stale worker still refuses a write to an archived type
 * because the canonical `installed_extension` row is archived. The in-memory
 * `removeByPackage` teardown is the de-listing CONVENIENCE; this is the
 * authoritative write authz that closes the "the in-memory registry is the only
 * authz" hole.
 *
 * ORG SCOPING (mirrors `canAccessArtifactExtension` EXACTLY — same gate, two
 * entry points): consider only LIVE (`active|locked`) rows, then pick the one
 * that governs the writing org — the org-owned LIVE row if present, else an
 * ambient (platform/workspace, `organizationId == null`) LIVE install. A package
 * archived for THIS org but kept active platform-wide stays writable (the
 * platform install governs, matching the actor-path access decision); a package
 * whose only live rows belong to OTHER orgs is NOT writable here (no cross-org
 * status bleed). This keeps the two gates' verdicts identical for the same scope.
 *
 *   - NO `kind:"artifact"` install rows                  → true  (ungoverned
 *     bundled/disk artifact; CG-1 — built-in/bundled types never blanked).
 *   - a LIVE row governs the writing org's scope          → true.
 *   - rows exist but NONE are live for this scope          → false (DENY).
 *   - DB read error                                        → false (fail-closed).
 *
 * When `orgId` is omitted (the host-process-global RESCAN caller), falls back to
 * the package-global "any live row" check (the rescan registers a process-global
 * descriptor; per-org write authz is then enforced at each write site). The two
 * actor-less WRITE callers (matcher / producer) ALWAYS pass the artifact's org.
 */
export async function isArtifactExtensionWriteAllowed(
  packageName: string,
  orgId?: string | null,
): Promise<boolean> {
  try {
    const artifactRows = (await readInstalledExtensionsByPackageName(packageName)).filter(
      (r) => r.kind === "artifact",
    );
    if (artifactRows.length === 0) return true; // ungoverned (bundled/disk artifact, no install row).

    // Only LIVE installs govern (same as canAccessArtifactExtension). If a row
    // exists but none are live, the extension was deliberately taken down → DENY.
    const live = artifactRows.filter((r) => r.status === "active" || r.status === "locked");
    if (live.length === 0) return false;

    // No org context (rescan): any live row suffices for a process-global
    // registration. Per-org write authz is enforced at each write site.
    if (orgId === undefined) return true;

    // ORG-SCOPED (matcher/producer): a LIVE row must govern the writing org —
    // org-owned first, then an ambient platform/workspace install. If the only
    // live rows belong to OTHER orgs, there is no governing live install for
    // this scope → DENY (no cross-org status bleed). Mirrors the access function's
    // row pick (over LIVE rows), so both gates agree for the same scope.
    const governing =
      (orgId != null && live.find((r) => r.organizationId === orgId)) ||
      live.find((r) => r.organizationId == null) ||
      null;
    return governing != null;
  } catch {
    return false; // fail-closed on any canonical-store read error.
  }
}

export async function canAccessArtifactExtension(
  packageName: string,
  actor: ActorContext | undefined | null,
  op: ExtensionAccessOp,
): Promise<boolean> {
  // Whole decision path is fail-closed: ANY access-store read error (the
  // install rows, the policy, or the co-owners) returns false rather than
  // throwing (which would 500 a sync-ish search/get path).
  try {
    const artifactRows = (await readInstalledExtensionsByPackageName(packageName)).filter(
      (r) => r.kind === "artifact",
    );
    if (artifactRows.length === 0) return true; // ungoverned (disk-registered dev artifact, no install row).

    // Only LIVE installs (active|locked) govern access. If an install row
    // exists but none are live (e.g. archived/removed), DENY — the extension
    // was deliberately taken down, even if a disk descriptor still lingers.
    const live = artifactRows.filter((r) => r.status === "active" || r.status === "locked");
    if (live.length === 0) return false;

    // Pick the row that governs this actor: org-owned for the actor's org,
    // then an ambient (platform/workspace) install, else the first live row.
    const orgId = actor?.organizationId;
    const row =
      (orgId && live.find((r) => r.organizationId === orgId)) ||
      live.find((r) => r.organizationId == null) ||
      live[0];

    const effectiveActor = await withResolvedOrgRole(actor);
    const decision = await canExtensionAccess(
      {
        kind: "artifact",
        resourceId: row.id,
        owner: {
          ownerLevel: row.ownerLevel,
          ownerId: row.ownerId,
          organizationId: row.organizationId,
        },
      },
      effectiveActor ?? null,
      op,
    );
    return decision.allowed;
  } catch {
    return false;
  }
}
