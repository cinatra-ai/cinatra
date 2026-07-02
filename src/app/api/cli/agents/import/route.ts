// ---------------------------------------------------------------------------
// POST /api/cli/agents/import — authenticated agent import (authoring).
//
// cinatra#255 (G2). Re-homes `cinatra agent import` onto the API: accepts a
// portable ZIP (the body, `Content-Type: application/zip`) created by
// `cinatra agent export` / `/api/cli/agents/export`, validates the embedded
// `agent.json` (formatVersion 1) + optional `manifest.json` (version 1), and
// INSERTS a NEW draft template (fresh UUID) plus an initial version row.
//
// AUTH: PLATFORM-ADMIN ONLY via `authorizeCliRequest({ minTier })`. Import
// inserts an instance-level template (no org predicate), so org-admins must NOT
// get cross-org write reach.
// AUTHORING, NON-DESTRUCTIVE: only ever creates a new draft — never updates or
// deletes — so it is safe to expose ahead of the G3 remote-operator hardening.
//
// An optional `?name=<override>` query parameter overrides the imported name.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";

import { authorizeCliRequest } from "@/lib/cli-api/route-guard";
import { importAgentTemplate } from "@/lib/cli-api/agent-transfer";
import { readZipFiles } from "@/lib/cli-api/zip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Defensive cap so a hostile/oversized upload cannot exhaust memory before the
// route reads it. Agent archives are tiny (JSON only); 8 MiB is generous.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const guard = await authorizeCliRequest(request, {
    minTier: "platform-admin",
    requiredScope: "cli:agent:write",
  });
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  // Reject before buffering when the declared Content-Length exceeds the cap,
  // so the memory guard protects the read itself — not just a post-hoc size
  // check (codex review). A chunked upload with no Content-Length still gets
  // the post-buffer cap below.
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "Upload too large." }, { status: 413 });
  }

  let zipBuf: Buffer;
  try {
    const ab = await request.arrayBuffer();
    if (ab.byteLength === 0) {
      return NextResponse.json(
        { error: "Empty request body: send the agent ZIP as the request body." },
        { status: 400 },
      );
    }
    if (ab.byteLength > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: "Upload too large." },
        { status: 413 },
      );
    }
    zipBuf = Buffer.from(ab);
  } catch {
    return NextResponse.json(
      { error: "Failed to read request body." },
      { status: 400 },
    );
  }

  // Parsing a hostile/truncated ZIP must not 500 — the reader does raw
  // Buffer.read* at offsets, so wrap it and return a clean 400 (codex review).
  let files: Map<string, string>;
  try {
    files = readZipFiles(zipBuf);
  } catch {
    return NextResponse.json(
      { error: "Invalid archive: could not be parsed as a ZIP." },
      { status: 400 },
    );
  }

  const agentRaw = files.get("agent.json");
  if (!agentRaw) {
    return NextResponse.json(
      { error: "Invalid archive: agent.json not found." },
      { status: 400 },
    );
  }

  const manifestRaw = files.get("manifest.json");
  if (manifestRaw) {
    let manifest: { version?: number };
    try {
      manifest = JSON.parse(manifestRaw) as { version?: number };
    } catch {
      return NextResponse.json(
        { error: "Invalid archive: manifest.json is not valid JSON." },
        { status: 400 },
      );
    }
    if (manifest.version !== 1) {
      return NextResponse.json(
        { error: `Unsupported manifest version: ${String(manifest.version)}` },
        { status: 400 },
      );
    }
  }

  let document: unknown;
  try {
    document = JSON.parse(agentRaw);
  } catch {
    return NextResponse.json(
      { error: "Invalid archive: agent.json is not valid JSON." },
      { status: 400 },
    );
  }

  const nameOverride = new URL(request.url).searchParams.get("name");

  try {
    const result = await importAgentTemplate(document, {
      nameOverride: nameOverride ?? null,
    });
    return NextResponse.json(
      {
        id: result.id,
        name: result.name,
        viewInApp: `/agents/builder/${result.id}`,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Format errors are the caller's fault (400); anything else is a 500.
    const message =
      error instanceof Error ? error.message : "Failed to import agent template.";
    const isFormatError = message.startsWith("Unsupported agent.json formatVersion");
    if (isFormatError) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    console.error("[cli-api/agents/import] failed", error);
    return NextResponse.json(
      { error: "Failed to import agent template." },
      { status: 500 },
    );
  }
}
