import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth-session";
import { resolveExtensionActorContext } from "@/lib/extension-host-actor";
import {
  resolveExtensionUiAction,
} from "@/lib/extension-ui-registry";
import { dispatchExtensionUiAction } from "@/lib/extension-action-dispatch";
import { readInstalledExtensionById } from "@cinatra-ai/extensions/canonical-store";
import { canExtensionAccess } from "@cinatra-ai/extensions/enforce-extension-access";
// Side-effect import: loads the host extension wiring so `ctx.ui` action
// registrations exist in THIS route's process. Mirrors /api/extensions/purge —
// the route reaches the in-memory registry directly (not via the MCP server),
// so without this import resolveExtensionUiAction would always miss.
import "@/lib/extensions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Host-owned generic action endpoint.
//
// Extensions never define their own Next.js Server Actions. They declare named
// actions at `register(ctx)` via `ctx.ui`; this single host route dispatches
// them by INSTALLED-EXTENSION id (the canonical addressable identity — scoped
// package names contain "/", so we resolve install id → packageName here and
// key the registered-action lookup by (packageName, actionId)).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ installId: string; actionId: string }> },
) {
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const { installId, actionId } = await params;

  let input: unknown = undefined;
  try {
    const text = await req.text();
    input = text ? JSON.parse(text) : undefined;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Resolve the full trusted actor for the handler. `getAuthSession` already
  // proved a session exists (401 above); this returns the kernel ActorContext.
  const actor = await resolveExtensionActorContext();

  // Cache the resolved row so authorize() doesn't re-read it.
  const rowById = new Map<string, Awaited<ReturnType<typeof readInstalledExtensionById>>>();
  const loadRow = async (id: string) => {
    if (!rowById.has(id)) rowById.set(id, await readInstalledExtensionById(id));
    return rowById.get(id) ?? null;
  };

  const dispatch = await dispatchExtensionUiAction(
    { installId, actionId, input, actor },
    {
      resolveInstall: async (id) => {
        const row = await loadRow(id);
        return row ? { packageName: row.packageName, status: row.status } : null;
      },
      // Enforce the uniform extension access policy ("use"-tier) for the actor
      // against the install's owner context — cross-org / no-access → false.
      authorize: async (_install, act) => {
        const row = await loadRow(installId);
        if (!row) return false;
        const decision = await canExtensionAccess(
          {
            kind: row.kind as Parameters<typeof canExtensionAccess>[0]["kind"],
            resourceId: row.id,
            owner: {
              ownerLevel: row.ownerLevel as Parameters<typeof canExtensionAccess>[0]["owner"]["ownerLevel"],
              ownerId: row.ownerId,
              organizationId: row.organizationId,
            },
          },
          act as Parameters<typeof canExtensionAccess>[1],
          "use",
        );
        return decision.allowed;
      },
      resolveAction: (packageName, action) =>
        resolveExtensionUiAction(packageName, action),
    },
  );

  if (dispatch.status === 200) {
    return NextResponse.json({ result: dispatch.result });
  }
  return NextResponse.json(
    { error: dispatch.error ?? "Action failed." },
    { status: dispatch.status },
  );
}
