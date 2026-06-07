// Canonical manifest gate.
//
// `enforceCanonicalManifest` is the entry point invoked by every code path
// that wants to mutate an extension's lifecycle state. It validates the
// caller's intent against the canonical manifest, then dispatches to the
// lifecycle primitive (which is the only function permitted to write
// `installed_extension.status`).
//
// Per-kind activation adapters (createAgentExtensionHandler, etc.) STILL
// exist and are correct — they own the kind-specific install/uninstall
// mechanics. The gate sits UPSTREAM of those adapters.
import "server-only";

import { readInstalledExtensionByIdentity } from "./canonical-store";
import {
  type CanonicalIdentity,
} from "./canonical-store";
import {
  LOCKED_REJECTED_OPS,
  type InstalledExtension,
  type LifecycleTransitionOp,
} from "./canonical-types";

export type CanonicalGateActor = {
  source: "ui" | "route" | "worker" | "scheduler" | "agent" | "mcp" | "cli";
  orgId?: string;
  userId?: string;
  roles?: string[];
};

export class CanonicalGateError extends Error {
  constructor(
    public readonly code:
      | "LOCKED_REJECTS_OP"
      | "EXT_NOT_FOUND"
      | "INVALID_OP_FOR_KIND"
      | "INVALID_IDENTITY",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CanonicalGateError";
  }
}

/**
 * Pre-flight check: the gate refuses destructive ops against locked rows
 * BEFORE dispatching to the per-kind activation adapter. This catches the
 * surface (UI action / MCP / CLI) at the earliest possible point so the
 * adapter never has to enforce lock semantics itself.
 *
 * Returns the resolved canonical row when the op is permitted; throws
 * CanonicalGateError otherwise.
 */
export async function enforceCanonicalManifest(
  actor: CanonicalGateActor,
  identity: CanonicalIdentity,
  op: LifecycleTransitionOp,
): Promise<InstalledExtension> {
  if (!identity.packageName) {
    throw new CanonicalGateError("INVALID_IDENTITY", "identity.packageName is required");
  }
  const ext = await readInstalledExtensionByIdentity(identity);
  if (!ext) {
    throw new CanonicalGateError(
      "EXT_NOT_FOUND",
      `No installed_extension found for package='${identity.packageName}' org='${identity.organizationId ?? ""}' owner='${identity.ownerLevel}/${identity.ownerId ?? ""}'`,
      { identity, op },
    );
  }

  if (ext.status === "locked" && LOCKED_REJECTED_OPS.has(op)) {
    throw new CanonicalGateError(
      "LOCKED_REJECTS_OP",
      `Cannot ${op} — '${ext.packageName}' is locked. Update is permitted; archive/uninstall is not.${
        ext.requiredInProd ? " (required-in-prod)" : ""
      }`,
      { extensionId: ext.id, status: ext.status, op, requiredInProd: ext.requiredInProd },
    );
  }

  return ext;
}
