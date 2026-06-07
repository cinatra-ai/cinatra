import { appRouter } from "@queuedash/api";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { getQueueDashContext } from "@/lib/background-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handler(req: Request) {
  return fetchRequestHandler({
    endpoint: "/api/admin/operations/jobs",
    req,
    router: appRouter,
    allowBatching: true,
    createContext: async () => getQueueDashContext(),
  });
}

export async function GET(request: Request) {
  return handler(request);
}

export async function POST(request: Request) {
  return handler(request);
}
