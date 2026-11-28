// ---------------------------------------------------------------------------
// POST /api/cli/extensions/install — authenticated extension package install
// for the `cinatra` CLI (cinatra#4920).
//
// Body: `{ packageName: "@scope/name", version?: "<exact | range | dist-tag>" }`.
// An absent version lets the install batch resolve `latest`.
//
// The route adds NO install logic of its own: it hands the request to the same
// dependency install batch the marketplace UI and the `extensions_install` MCP
// tool use (`installExtensionWithDependencies`), which authorizes the root on
// the gatekept path, installs missing dependencies first, dispatches each
// member to its kind's handler (an agent compiles from `cinatra/oas.json`,
// writes its rows and materializes to the runtime mount) and fires the single
// agent-runtime reload at the batch success boundary.
//
// AUTH: PLATFORM-ADMIN ONLY via `authorizeCliRequest` — the exact mirror of
// `/api/cli/extensions/reconcile/apply`: cookie session, a verified remote
// Bearer carrying `cli:extensions:write`, or the dev-admin loopback bypass.
//
// ACTOR: the standing-free install envelope, the same shape the UI install
// wrapper hands the batch (`buildActorEnvelope`). No `platformRole`: the
// batch's compensation uninstalls with this actor, and platform standing there
// would take the package-global teardown branch for a dependency other orgs
// use.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";

import type { Actor } from "@cinatra-ai/extension-types";
import { authorizeCliRequest } from "@/lib/cli-api/route-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The scoped package name the install surfaces accept (the
// `extensions_install` MCP schema's pattern).
const PACKAGE_NAME_RE = /^@[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
// An exact version, a semver range or a dist-tag. Characters only; the batch's
// registry resolution decides whether the value resolves.
const VERSION_RE = /^[0-9A-Za-z.+\-^~<>=*|x ]{1,128}$/;

function badRequest(error: string): Response {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(request: Request): Promise<Response> {
  const guard = await authorizeCliRequest(request, {
    minTier: "platform-admin",
    requiredScope: "cli:extensions:write",
  });
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await request.text());
  } catch {
    return badRequest("Invalid JSON body.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return badRequest("Request body must be a JSON object.");
  }
  const { packageName, version } = parsed as { packageName?: unknown; version?: unknown };
  if (typeof packageName !== "string" || !PACKAGE_NAME_RE.test(packageName)) {
    return badRequest(
      "`packageName` must be a scoped package name (@scope/name, lowercase letters, digits and hyphens).",
    );
  }
  if (
    version !== undefined &&
    (typeof version !== "string" || version.trim() === "" || !VERSION_RE.test(version))
  ) {
    return badRequest(
      "`version` must be an exact version, a semver range or a dist-tag when supplied.",
    );
  }

  const actor: Actor = {
    actorType: "human",
    source: "route",
    ...(guard.actor.userId ? { userId: guard.actor.userId } : {}),
    ...(guard.actor.organizationId ? { orgId: guard.actor.organizationId } : {}),
  };

  try {
    const { installExtensionWithDependencies } = await import(
      "@/lib/extension-install-batch"
    );
    const result = await installExtensionWithDependencies({
      packageName,
      ...(version !== undefined ? { version } : {}),
      actor,
    });
    return NextResponse.json(
      {
        packageName: result.rootPackage,
        version: result.rootVersion,
        installed: result.installed,
        updated: result.updated,
        installedSideBySide: result.installedSideBySide,
        alreadyInstalled: result.alreadyInstalled,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[cli-api/extensions/install] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
