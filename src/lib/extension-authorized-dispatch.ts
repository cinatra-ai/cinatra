import "server-only";

import type { PrimitiveDispatchTarget } from "@cinatra-ai/mcp-server/capability-plan";
import { listExtensionMcpTools, UNRESOLVED_EXTENSION_VERSION } from "@/lib/extension-mcp-registry";
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
  if (target.kind === "extension-versioned") {
    // No global handler to fall back to and none wanted: the point lookup is
    // keyed on the authorized version, and a drifted edge throws.
    const raw = await dispatchPlannedExtensionMcpTool(
      {
        expected: "versioned",
        packageName: target.packageName,
        name: target.name,
        version: target.version,
      },
      input,
    );
    return wrapExtensionToolResult(raw);
  }
  // `extension-default`: the authorized identity is the DEFAULT registration, so
  // the raw default handler is the one that may run. It is read from the
  // registry here rather than taken from the captured map, because the captured
  // entry holds the drift-tolerant WRAPPER, not the handler underneath it.
  const tool = listExtensionMcpTools().find(
    (t) => t.packageName === target.packageName && t.name.toLowerCase() === target.name,
  );
  if (!tool) {
    // The default registration disappeared between capture and dispatch (a
    // teardown landed). Refuse — never fall back to another version.
    throw new Error(
      `[mcp] "${target.name}" is no longer registered by ${target.packageName}; refusing rather ` +
        "than dispatching across versions",
    );
  }
  // THE DEFAULT CAN MOVE UNDER ITS OWN NAME (codex round-2 #1). A hot update
  // replaces the default registration in place, so the entry found above may be
  // a DIFFERENT version than the one that was authorized — and the edge is still
  // unpinned, so the drift check inside `dispatchPlannedExtensionMcpTool` (which
  // only compares pinned-vs-unpinned) would not catch it. The authorized version
  // is therefore compared here, against the registry's own resolution.
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

