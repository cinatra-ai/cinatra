import { readSkillAutosaveConfig, writeSkillAutosaveConfig } from "@/lib/skill-autosave";

export async function GET() {
  return Response.json(readSkillAutosaveConfig());
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as { enabled?: boolean };
  if (typeof body.enabled === "boolean") {
    writeSkillAutosaveConfig({ enabled: body.enabled });
  }
  return Response.json(readSkillAutosaveConfig());
}
