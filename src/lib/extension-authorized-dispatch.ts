import "server-only";

import type { PrimitiveDispatchTarget } from "@cinatra-ai/mcp-server/capability-plan";
import {
  listExtensionMcpTools,
  UNRESOLVED_EXTENSION_VERSION,
  type RegisteredExtensionMcpTool,
} from "@/lib/extension-mcp-registry";
import type { RetainedVersionKeyedMcpTool } from "@/lib/extension-version-keyed-serving";
import { dispatchPlannedExtensionMcpTool, wrapExtensionToolResult } from "@/lib/extension-edge-bound-serving";

// ---------------------------------------------------------------------------
// THE PINNED DISPATCH FOR A DELEGATED-RESTRICTED SELF-INVOCATION (cinatra#2817
// slice 3, codex round-1 #1).
//
// THE HOLE THIS CLOSES. The self-invoker authorizes against the version the
// caller's edge resolves to, and then hands the call to the captured wrapper —
// which resolves the edge AGAIN. Between those two resolutions an activation,
// a hot update or a rollback can land, and the captured wrapper is deliberately
// drift-TOLERANT (`dispatchExtensionMcpToolEdgeBound` serves whatever the edge
// now says). So an admission reviewed for version A could authorize a call that
// executes version B of the same primitive — precisely the "never applies to
// another version" rule this issue exists to enforce.
//
// So a delegated-restricted call does not use the captured wrapper. It goes
// through `dispatchPlannedExtensionMcpTool`, which resolves the edge ONCE and
// REFUSES (`EDGE_BOUND_PLAN_DRIFT`) when the result does not match the identity
// that was authorized. The authorized version is carried in, not re-derived, so
// the check is against the decision that was actually made.
//
// UNRESTRICTED callers keep the captured wrapper untouched: their reach is not
// version-bound in the first place, so re-pointing them at a stricter dispatch
// would refuse calls that are legitimately served across an edge change.
// ---------------------------------------------------------------------------

/**
 * Dispatch ONE extension primitive at the EXACT identity that was authorized,
 * refusing rather than crossing versions. Returns the same MCP envelope the
 * captured wrapper returns, so the caller's result handling is unchanged.
 */
export async function dispatchAuthorizedExtensionPrimitive(
  target: PrimitiveDispatchTarget,
  input: unknown,
): Promise<unknown> {
  // cinatra#3745: WHAT IS AUTHORIZED IS WHAT RUNS. The target carries the
  // registration object whose declaration was planned (and, for an extension,
  // whose loaded identity rides beside its handler). That object's handler is
  // the one that may run; it is never looked up again by name and version, so a
  // same-version replacement (a hot update, which may change the declaration)
  // between the authorization and this call can never run instead. A target
  // without its registration is refused.
  const registration = target.registration as
    | (RegisteredExtensionMcpTool | RetainedVersionKeyedMcpTool) | undefined;
  if (!registration || typeof registration.handler !== "function" ||
      registration.packageName !== target.packageName || registration.name.toLowerCase() !== target.name) {
    throw new Error(
      `[mcp] "${target.name}" of ${target.packageName} carries no authorized registration; refusing ` +
        "rather than dispatching a registration looked up again",
    );
  }
  if (target.kind === "extension-versioned") {
    // No global handler to fall back to and none wanted: the point lookup is
    // keyed on the authorized version, a drifted edge throws, and the retained
    // entry served must be the authorized object itself.
    const raw = await dispatchPlannedExtensionMcpTool(
      {
        expected: "versioned",
        packageName: target.packageName,
        name: registration.name,
        version: target.version,
        registration: registration as RetainedVersionKeyedMcpTool,
      },
      input,
    );
    return wrapExtensionToolResult(raw);
  }
  // `extension-default`: the authorized identity is the DEFAULT registration, so
  // the raw default handler of THAT registration is the one that may run (the
  // captured map holds the drift-tolerant wrapper, not the handler underneath).
  const tool = registration as RegisteredExtensionMcpTool;
  // It must still be the LIVE default registration: a teardown (uninstall,
  // archive, a failed reload) or a replacement between the authorization and
  // this call removed it from the registry, and its code must not run then.
  // Compared by object, never by name and version, and nothing else is run.
  if (!listExtensionMcpTools().includes(tool)) {
    throw new Error(
      `[mcp] "${target.name}" of ${target.packageName}@${target.version} is no longer the registered ` +
        "default; refusing rather than running a registration that was torn down or replaced",
    );
  }
  // THE DEFAULT CAN MOVE UNDER ITS OWN NAME (codex round-2 #1). The authorized
  // registration's own resolved version must still be the authorized version
  // (a defensive check: the target was stamped from this object).
  const servingVersion = tool.resolvedVersion ?? UNRESOLVED_EXTENSION_VERSION;
  if (servingVersion !== target.version) {
    throw new Error(
      `[mcp] "${target.name}" was admitted at ${target.packageName}@${target.version} but the ` +
        `default registration now resolves to ${servingVersion}; refusing rather than dispatching ` +
        "across versions",
    );
  }
  const raw = await dispatchPlannedExtensionMcpTool({ expected: "default", tool }, input);
  return wrapExtensionToolResult(raw);
}

