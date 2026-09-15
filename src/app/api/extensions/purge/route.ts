import { NextResponse } from "next/server";
import {
  purgeExtension,
  ExtensionPurgeRefused,
} from "@cinatra-ai/extensions/purge";
import { defaultPurgeDeps } from "@cinatra-ai/extensions/purge-deps";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import {
  localCallerRefusalMessage,
  localCallerVerdict,
} from "@/lib/local-caller-gate";
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
// here, reached by the human-origin `cinatra extensions purge` CLI local
// POST — the same defense pattern as /api/skills/reset-repo.
//
// This route is EXEMPT from the sign-in middleware (src/lib/auth-route-guard.ts)
// because its caller is a cookieless local shell, so the gate below is the whole
// of its authorization — which is why it is the shared one rather than a
// hand-rolled copy:
//   1. NODE_ENV must NOT be production.
//   2. CINATRA_RUNTIME_MODE === 'development' (primary gate).
//   3. The connecting SOCKET's peer address is loopback and the caller sent no
//      forwarded header of its own.
//   4. The caller presents this boot's 0600 local credential.
// Fences 3 and 4 replace a `Host`-header check that admitted any caller willing
// to write `Host: localhost` from anywhere on the network — see
// @/lib/local-caller-gate and @/lib/request-peer.
//
// The dry-run plan/digest handshake below is UNCHANGED and still mandatory, and
// purgeExtension() still fail-closed-refuses on CINATRA_DB_PROD_HOSTS, active
// dependents, and digest mismatch. What changed is that a digest — which a
// caller can compute offline — is no longer enough on its own to reach any of
// that. Deliberately NO session requirement: this route has no session to read.
export async function POST(req: Request) {
  const local = localCallerVerdict(req);
  if (!local.ok) {
    return NextResponse.json(
      { error: localCallerRefusalMessage("/api/extensions/purge") },
      { status: local.status },
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
