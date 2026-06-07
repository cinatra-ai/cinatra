import { NextResponse } from "next/server";
import {
  purgeExtension,
  ExtensionPurgeRefused,
} from "@cinatra-ai/extensions/purge";
import { defaultPurgeDeps } from "@cinatra-ai/extensions/purge-deps";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
// Side-effect import: wires the in-memory capability teardown hook
// (src/lib/extensions.ts → removeExtensionMcpToolsForPackage). This route imports
// purgeExtension directly rather than via the MCP server, so without this import
// the teardown hook would be unset in the route's process and the fired teardown
// would be a no-op. (It also registers the extension handlers, as on the MCP path.)
import "@/lib/extensions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Destructive extension-purge path.
//
// extensions_purge is intentionally DRY-RUN-ONLY as an MCP tool (an MCP
// primitive is model-reachable; a model-set confirm flag is theater). The
// actual irreversible purge (Verdaccio all versions + DB + disk) runs ONLY
// here, reached by the human-origin `cinatra extensions purge` CLI loopback
// POST — the same defense pattern as /api/skills/reset-repo:
//   1. NODE_ENV must NOT be production.
//   2. CINATRA_RUNTIME_MODE === 'development' (primary gate).
//   3. Loopback origin only, no x-forwarded-* chain (blocks a request
//      proxied through a stale tunnel that still trusts a dev box).
// purgeExtension() additionally fail-closed-refuses on CINATRA_DB_PROD_HOSTS,
// active dependents, and digest mismatch.
function isLoopback(req: Request): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (req.headers.get("x-forwarded-for")) return false;
  if (req.headers.get("x-forwarded-host")) return false;
  try {
    const url = new URL(req.url);
    const h = url.hostname;
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h === "host.docker.internal"
    );
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  if (process.env.CINATRA_RUNTIME_MODE !== "development") {
    return NextResponse.json(
      { error: "Only available in development mode." },
      { status: 403 },
    );
  }
  if (!isLoopback(req)) {
    return NextResponse.json(
      {
        error:
          "/api/extensions/purge refuses non-loopback origins. Run `cinatra extensions purge` from the host shell.",
      },
      { status: 403 },
    );
  }

  let body: {
    packageName?: string;
    expectedDigest?: string;
    reason?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const packageName = body.packageName?.trim();
  if (!packageName) {
    return NextResponse.json(
      { error: "packageName is required." },
      { status: 400 },
    );
  }
  // The dry-run plan/digest handshake is mandatory.
  if (!body.expectedDigest) {
    return NextResponse.json(
      {
        error:
          "expectedDigest is required — run the extensions_purge dry-run first and pass its digest.",
      },
      { status: 400 },
    );
  }

  const actor: PrimitiveActorContext = {
    actorType: "human",
    source: "route",
  };

  try {
    const result = await purgeExtension(
      {
        packageName,
        ...(body.expectedDigest ? { expectedDigest: body.expectedDigest } : {}),
        ...(body.reason ? { reason: body.reason } : {}),
        actor,
      },
      await defaultPurgeDeps(),
    );
    return NextResponse.json({ success: true, result });
  } catch (error) {
    if (error instanceof ExtensionPurgeRefused) {
      return NextResponse.json(
        { error: error.message, refused: true },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error." },
      { status: 500 },
    );
  }
}
