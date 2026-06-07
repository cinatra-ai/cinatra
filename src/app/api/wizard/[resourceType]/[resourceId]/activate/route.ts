import { getConfigHandler } from "@/lib/wizard-config-handlers";
import "@/lib/wizard-config-handler-campaign"; // side-effect: registers "campaign" handler
import { getMergedStagedConfig, isStagedResource, removeStagedResource } from "@/lib/wizard-staging-store";

type Params = { params: Promise<{ resourceType: string; resourceId: string }> };

export async function POST(_request: Request, { params }: Params) {
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
