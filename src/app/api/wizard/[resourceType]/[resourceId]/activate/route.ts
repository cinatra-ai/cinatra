import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import { getConfigHandler } from "@/lib/wizard-config-handlers";
import "@/lib/wizard-config-handler-campaign"; // side-effect: registers "campaign" handler
import { getMergedStagedConfig, isStagedResource, removeStagedResource } from "@/lib/wizard-staging-store";

type Params = { params: Promise<{ resourceType: string; resourceId: string }> };

export async function POST(_request: Request, { params }: Params) {
  // Activation promotes a staged resource into a real, persisted one — a
  // privileged mutation. The route-guard middleware only checks for the
  // presence of a session cookie, so authorization MUST be enforced in-handler:
  // require a validated session and restrict the promotion to a platform admin.
  const session = await getAuthSession();
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isPlatformAdmin(session)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { resourceType, resourceId } = await params;

  if (!isStagedResource(resourceType, resourceId)) {
    return Response.json({ error: "No staged resource found." }, { status: 404 });
  }

  const handler = getConfigHandler(resourceType);
  if (!handler) {
    return Response.json({ error: `Unknown resource type: ${resourceType}` }, { status: 404 });
  }

  const config = getMergedStagedConfig(resourceType, resourceId)!;
  const realId = await handler.activate(resourceId, config);
  removeStagedResource(resourceType, resourceId);

  return Response.json({ ok: true, resourceId: realId });
}
