// ---------------------------------------------------------------------------
// GET /api/cli/agents/export?query=<id-or-name> — authenticated agent export.
//
// cinatra#255 (G2). Re-homes `cinatra agent export` onto the API: resolves an
// agent template by id or (case-insensitive) name and returns a portable ZIP
// (`agent.json` formatVersion 1 + `manifest.json`) byte-compatible with the
// CLI's own export, so a remote-exported archive imports identically.
//
// AUTH: PLATFORM-ADMIN ONLY via `authorizeCliRequest({ minTier })`. Export
// resolves a template by id/name across the whole instance (no org predicate),
// so org-admins must NOT get cross-org reach. READ-ONLY.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";

import { authorizeCliRequest } from "@/lib/cli-api/route-guard";
import { exportAgentTemplate } from "@/lib/cli-api/agent-transfer";
import { createZipBuffer } from "@/lib/cli-api/zip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const guard = await authorizeCliRequest(request, {
    minTier: "platform-admin",
    requiredScope: "cli:agent:read",
  });
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const query = new URL(request.url).searchParams.get("query")?.trim();
  if (!query) {
    return NextResponse.json(
      { error: "Missing required `query` parameter (agent id or name)." },
      { status: 400 },
    );
  }

  try {
    const result = await exportAgentTemplate(query);
    if (!result) {
      return NextResponse.json(
        { error: `Agent template not found: ${query}` },
        { status: 404 },
      );
    }

    const { document, manifest } = result;
    const zip = createZipBuffer([
      { name: "agent.json", content: JSON.stringify(document, null, 2) },
      { name: "manifest.json", content: JSON.stringify(manifest, null, 2) },
    ]);

    const slug = document.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const dateStr = document.exportedAt.slice(0, 10).replace(/-/g, "");
    const filename = `cinatra-agent-${slug}-${dateStr}.zip`;

    return new NextResponse(new Uint8Array(zip), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(zip.length),
        // Echo the resolved identity so the CLI can print "Exported … (id)".
        "X-Cinatra-Agent-Id": document.id,
        "X-Cinatra-Agent-Name": encodeURIComponent(document.name),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[cli-api/agents/export] failed", error);
    return NextResponse.json(
      { error: "Failed to export agent template." },
      { status: 500 },
    );
  }
}
