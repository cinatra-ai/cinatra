import type { Metadata } from "next";

import { ScopedAssistantsRoute } from "@/app/scoped-launch-routes";
import { requireAuthSession } from "@/lib/auth-session";

export const metadata: Metadata = { title: "Assistant" };

// A REQUEST-TIME SURFACE, DECLARED HERE (cinatra#2809 fix leg 3). The root
// layout forces dynamic rendering for everything beneath it and next.config.ts
// records that a page may override that locally with `force-static`. This one
// never may: it reads the caller's session on every request, and a static
// override would move its gated name read into the build's page-data step —
// the step the constrained runner was reclaimed in. Declaring it at the entry
// keeps that decision local to the route it belongs to.
export const dynamic = "force-dynamic";

// The scoped assistants tree of the personal scope (cinatra#2809, per-scope
// surfaces S3). ONE catch-all per scope base, delegating to the same renderers
// the bare global routes use — see `src/app/scoped-launch-routes.tsx` for why
// this is a delegation and not a copy of the route tree.
export default async function PersonalScopedAssistantsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ launch?: string[] }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { launch } = await params;
  await requireAuthSession();
  return ScopedAssistantsRoute({ scope: { kind: "personal" }, segments: launch, searchParams });
}
