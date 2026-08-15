/**
 * `/configuration` segment gate (cinatra#2700, epic #2699).
 *
 * The whole of `/configuration` is the platform-admin area. This layout gate is
 * DEFENSE IN DEPTH ONLY — it is deliberately NOT the authorization boundary:
 *
 *   - App Router layouts do not re-render on a soft (client-side) navigation,
 *     so a layout gate is not consulted again once the segment is mounted;
 *   - server actions and route handlers never pass through a layout at all.
 *
 * Every page under this segment therefore carries its OWN `requireAdminSession`
 * gate (directly, or in the screen/mount it renders), every server action
 * serving these surfaces gates itself, and the MCP route handlers under
 * `mcp/*` keep their own method-appropriate denials. The enumerated route
 * table that pins all of that lives in
 * `src/app/configuration/__tests__/configuration-admin-gate.test.ts`.
 */
import type { ReactNode } from "react";

import { requireAdminSession } from "@/lib/auth-session";

export default async function ConfigurationLayout({ children }: { children: ReactNode }) {
  await requireAdminSession();
  return <>{children}</>;
}
