import type { Metadata } from "next";

import { ScopedAgentsRoute, scopedSurfaceMetadata } from "@/app/scoped-launch-routes";
import { requireAuthSession } from "@/lib/auth-session";

// Gate-repeating metadata (cinatra#1737, the dashboards pattern; cinatra#2809
// fix leg 2): the tab title mirrors the resolved trail — it names the scope
// the trail's first crumb names, behind that scope's own read gate, and never
// the id in any form. The instance's own label takes the tab over from the
// shell once the trail resolves.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ teamId: string }>;
}): Promise<Metadata> {
  const { teamId } = await params;
  return scopedSurfaceMetadata({ kind: "team", id: teamId }, "Agents");
}

// The scoped agents tree of the team scope (cinatra#2809, per-scope
// surfaces S3). ONE catch-all per scope base, delegating to the same renderers
// the bare global routes use — see `src/app/scoped-launch-routes.tsx` for why
// this is a delegation and not a copy of the route tree.
export default async function TeamScopedAgentsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ teamId: string; launch?: string[] }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { teamId, launch } = await params;
  await requireAuthSession();
  return ScopedAgentsRoute({
    scope: { kind: "team", id: teamId },
    segments: launch,
    searchParams,
  });
}
