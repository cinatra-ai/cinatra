import type { Metadata } from "next";

import { ScopedAssistantsRoute } from "@/app/scoped-launch-routes";
import { requireAuthSession } from "@/lib/auth-session";

export const metadata: Metadata = { title: "Assistant" };

// The scoped assistants tree of the workspace scope (cinatra#2809, per-scope
// surfaces S3). ONE catch-all per scope base, delegating to the same renderers
// the bare global routes use — see `src/app/scoped-launch-routes.tsx` for why
// this is a delegation and not a copy of the route tree.
export default async function WorkspaceScopedAssistantsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ launch?: string[] }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { launch } = await params;
  await requireAuthSession();
  return ScopedAssistantsRoute({ scope: { kind: "workspace" }, segments: launch, searchParams });
}
