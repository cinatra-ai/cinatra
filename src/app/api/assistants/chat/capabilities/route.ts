import "server-only";

import { z } from "zod";
import { getAuthSession } from "@/lib/auth-session";
import {
  ASSISTANT_STREAM_AUTH_MODES,
  buildAssistantStreamCapabilities,
  negotiateStreamContract,
} from "@cinatra-ai/agent-ui-protocol/stream";

// ---------------------------------------------------------------------------
// /api/assistants/chat/capabilities — the S1 capability surface for the
// first-party `/chat` chat surface (cinatra#1218, epic #1216 S2; CONTRACT.md
// §5).
//
//   GET  — the server's `AssistantStreamCapabilities` advertisement.
//   POST — the full handshake: the client posts its `StreamClientHello` and
//          receives the `StreamNegotiation`. The PURE negotiation
//          (`negotiateStreamContract`) executes here rather than in the
//          browser bundle: the /chat route graph is a locked dev-perf budget,
//          and for this FIRST-PARTY surface both handshake legs are served by
//          the same deployment, so where the pure function runs changes
//          nothing about the outcome. The client still STATES its own
//          supported contracts / auth mode / requirements and still enforces
//          the result FAIL-CLOSED (it mounts the AG-UI wire only on `ok`).
//          Cross-origin surfaces (the S5 embedded view) negotiate client-side
//          with the same module — their graphs are not /chat's.
//
// Static contract metadata only (nothing instance-specific), same security
// posture as the bespoke `/capabilities` negotiation this contract retires.
// `renderableViews` is empty: the Cinatra assistant runtime emits no
// registered renderable view yet (its DATA_PARTs are the structural
// `agent_run` / `citations` payloads the reducer consumes) — the entry is
// ADVISORY by contract and never gates rendering.
// ---------------------------------------------------------------------------

function chatSurfaceCapabilities() {
  return buildAssistantStreamCapabilities({
    auth: ["session"],
    renderableViews: [],
  });
}

export async function GET() {
  const session = await getAuthSession();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.json(chatSurfaceCapabilities(), {
    headers: { "Cache-Control": "no-store" },
  });
}

const clientHelloSchema = z.object({
  supportedContracts: z.array(z.string().min(1)).min(1).max(32),
  authMode: z.enum(ASSISTANT_STREAM_AUTH_MODES),
  requiredViews: z.array(z.string().min(1)).max(64).optional(),
  requiresResumable: z.boolean().optional(),
});

export async function POST(request: Request) {
  const session = await getAuthSession();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const raw = (await request.json().catch(() => null)) as unknown;
  const parsed = clientHelloSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid stream client hello", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const negotiation = negotiateStreamContract(parsed.data, chatSurfaceCapabilities());
  return Response.json(negotiation, { headers: { "Cache-Control": "no-store" } });
}
