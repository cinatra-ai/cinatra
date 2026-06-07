import { getAuthSession } from "@/lib/auth-session";
import { getConfigHandler } from "@/lib/wizard-config-handlers";
import "@/lib/wizard-config-handler-campaign"; // side-effect: registers "campaign" handler
import {
  isStagedResource,
  getMergedStagedConfig,
  updateStagedResource,
} from "@/lib/wizard-staging-store";

type Params = { params: Promise<{ resourceType: string; resourceId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { resourceType, resourceId } = await params;
  const session = await getAuthSession();
  const userId = session?.user?.id;

  const handler = getConfigHandler(resourceType);
  if (!handler) {
    return Response.json({ error: `Unknown resource type: ${resourceType}` }, { status: 404 });
  }

  // Staged resource (in-memory).
  if (isStagedResource(resourceType, resourceId)) {
    const config = getMergedStagedConfig(resourceType, resourceId)!;
    const response = await handler.buildStagedResponse(resourceId, config, userId);
    return Response.json(response);
  }

  // Real resource (DB).
  const response = await handler.buildRealResponse(resourceId, userId);
  if (!response) {
    return Response.json({ error: "Resource not found." }, { status: 404 });
  }
  return Response.json(response);
}

export async function PATCH(request: Request, { params }: Params) {
  const { resourceType, resourceId } = await params;
  const session = await getAuthSession();
  const userId = session?.user?.id;
  const body = (await request.json()) as Record<string, unknown>;

  const handler = getConfigHandler(resourceType);
  if (!handler) {
    return Response.json({ error: `Unknown resource type: ${resourceType}` }, { status: 404 });
  }

  // Staged resource (in-memory).
  if (isStagedResource(resourceType, resourceId)) {
    updateStagedResource(resourceType, resourceId, body);
    const config = getMergedStagedConfig(resourceType, resourceId)!;
    const response = await handler.buildStagedResponse(resourceId, config, userId);
    return Response.json(response);
  }

  // Real resource (DB).
  const response = await handler.applyRealPatch(resourceId, body, userId);
  if (!response) {
    return Response.json({ error: "Resource not found." }, { status: 404 });
  }
  return Response.json(response);
}
