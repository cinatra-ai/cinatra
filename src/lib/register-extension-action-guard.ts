import "server-only";

// Wire the host enforcement behind the SDK's `requireExtensionAction(...)` guard.
//
// Extension server actions call `requireExtensionAction(packageId, mode)` from
// `@cinatra-ai/sdk-extensions` (a leaf contract) instead of importing host auth
// modules directly. This module supplies the ONE host implementation: resolve
// the actor from the request session and enforce the per-install connector
// access policy, failing closed (redirect) on no-session / denial — matching the
// prior `requireAuthSession()` / `requireAdminSession()` behavior the connector
// actions used before decoupling.
//
// Auto-registers on import; `src/instrumentation.node.ts` imports it at boot.

import { redirect } from "next/navigation";
import { setExtensionActionGuard } from "@cinatra-ai/sdk-extensions";
import { getActorContext } from "@/lib/auth-session";
import { enforceConnectorActionPolicy } from "@/lib/connector-policy";

setExtensionActionGuard(async (packageId, mode) => {
  const actor = await getActorContext();
  if (!actor) {
    // No authenticated session — same destination as the old requireAuthSession().
    redirect("/sign-in");
  }
  const decision = enforceConnectorActionPolicy(packageId, actor, mode);
  if (!decision.allowed) {
    // Denied by the per-install connector policy (admin-only connector, a
    // non-admin attempting `manage`, or a non-admin `manage` on an
    // infrastructure connector that has no catalog descriptor) — same
    // destination as requireAdminSession().
    redirect("/not-authorized");
  }
});
