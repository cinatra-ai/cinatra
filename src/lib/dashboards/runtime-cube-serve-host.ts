import "server-only";

// Host wiring for the CG-5 runtime-cube serve-gate (cinatra#660 / PR-7).
//
// Bridges the pure serve-gate (`runtime-cube-serve-gate.ts`) to the live runtime
// cube registry + the installed-extension read-model. Both transports (the HTTP
// cubejs route + the MCP cube tools) call `assertRuntimeCubeServeable` AFTER
// resolving the cube id, and `filterCubeIdsForActor` for the catalog surfaces
// (HTTP /meta + MCP discover). The drizzle-cube tenant predicate is NEVER
// bypassed — this layer is ADDITIVE.

import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";
import {
  getRuntimeCubeRegistration,
  isRuntimeCube,
} from "@cinatra-ai/dashboards/runtime-cube-registry";
import {
  decideRuntimeCubeServe,
  filterServeableCubeIds,
  type RuntimeCubeInstallFacts,
  type RuntimeCubeServeVerdict,
} from "@cinatra-ai/dashboards/runtime-cube-serve-gate";
import { buildInstalledExtensionReadModel } from "@/lib/installed-extension-read-model.server";

/**
 * Resolve the install-active + trust facts for a RUNTIME cube's source package,
 * for the actor. Returns null when the cube is not a registered runtime cube (no
 * source package to read). The read-model is the source of truth: `actorVisible`
 * + a live (active|locked) status proves install-active for the actor, and the
 * descriptive trust verdict supplies the trust signal (trust==null ⇒ deny).
 */
async function factsForRuntimeCube(
  cubeId: string,
  actor: ActorContext | null | undefined,
): Promise<RuntimeCubeInstallFacts | null> {
  const reg = getRuntimeCubeRegistration(cubeId);
  if (!reg) return null;
  const model = await buildInstalledExtensionReadModel(reg.sourcePackageName, actor ?? null);
  return {
    actorVisible: model.actorVisible,
    status: model.status,
    trust: model.trust ? { trusted: model.trust.trusted } : null,
  };
}

/**
 * Assert a resolved cube may be SERVED for the actor (CG-5). Bundled cubes pass
 * (install-row bypass; the tenant predicate still applies downstream). A runtime
 * cube must be install-active for the actor AND in a trusted state, else fail
 * closed with `cube_not_active` / `cube_untrusted`.
 */
export async function assertRuntimeCubeServeable(
  cubeId: string,
  actor: ActorContext | null | undefined,
): Promise<RuntimeCubeServeVerdict> {
  if (!isRuntimeCube(cubeId)) return { ok: true };
  const facts = await factsForRuntimeCube(cubeId, actor);
  return decideRuntimeCubeServe({ cubeId, isRuntimeCube, facts });
}

/**
 * Filter a catalog cube-id list (HTTP /meta + MCP discover) to the cubes the
 * actor may see: every bundled cube, plus only the runtime cubes that pass the
 * serve-gate for the actor. Prevents the EXISTENCE of another org's runtime cube
 * from leaking through the catalog.
 */
export async function filterCubeIdsForActor(
  cubeIds: readonly string[],
  actor: ActorContext | null | undefined,
): Promise<string[]> {
  return filterServeableCubeIds({
    cubeIds,
    isRuntimeCube,
    factsFor: (cubeId) => factsForRuntimeCube(cubeId, actor),
  });
}

// ─── MCP transport bridge ──────────────────────────────────────────────────
/** The minimal identity the MCP cube transport carries. */
export type McpCubeActor = { userId: string; organizationId: string };

/**
 * Build a minimal kernel ActorContext from the MCP cube identity for the
 * serve-gate read-model lookup. The read-model's addressability check reads
 * `organizationId` / `principalId` / `teamIds` — an MCP cube call carries the
 * acting human's userId + active org, which is exactly the org-scoped
 * addressability the gate needs. (teamIds are unavailable on the MCP path, so a
 * TEAM-scoped runtime install would not be addressable via MCP — fail-closed,
 * the conservative default.)
 */
function mcpActorToContext(actor: McpCubeActor | null | undefined): ActorContext | null {
  if (!actor) return null;
  return {
    principalType: "HumanUser",
    principalId: actor.userId,
    authSource: "mcp",
    policyVersion: POLICY_VERSION,
    organizationId: actor.organizationId,
    teamIds: [],
  };
}

/**
 * MCP-transport CG-5 serve-gate. Same decision as the HTTP path, taking the MCP
 * `{userId, organizationId}` identity. A bundled cube passes; a runtime cube
 * must be install-active for the actor AND trusted.
 */
export async function assertMcpRuntimeCubeServeable(
  cubeId: string,
  actor: McpCubeActor | null | undefined,
): Promise<RuntimeCubeServeVerdict> {
  return assertRuntimeCubeServeable(cubeId, mcpActorToContext(actor));
}

/**
 * MCP catalog filter (the `discover` tool's cube list). Drops any runtime cube
 * the MCP actor cannot serve, mirroring the HTTP `/meta` filter — so `discover`
 * never lists another org's runtime cube.
 */
export async function filterMcpCubeIdsForActor(
  cubeIds: readonly string[],
  actor: McpCubeActor | null | undefined,
): Promise<string[]> {
  return filterCubeIdsForActor(cubeIds, mcpActorToContext(actor));
}
