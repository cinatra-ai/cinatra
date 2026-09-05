import type { Metadata } from "next";

import { ScopedAgentsRoute } from "@/app/scoped-launch-routes";
import { requireAuthSession } from "@/lib/auth-session";

export const metadata: Metadata = { title: "Agent" };

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
