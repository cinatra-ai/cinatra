// ---------------------------------------------------------------------------
// THE EDITOR'S SAVE ENDPOINT (enabler 0.20 of `PLAN: Agents Lifecycle (C)`,
// cinatra#3026) — the address a host-minted edit capability carries, and the
// only way a change set reaches the save road.
//
// A DISPLAY NEVER COMPOSES THIS ADDRESS. The host puts it on the capability it
// mints for the artifact page; the SDK's `saveArtifactEdit` posts to whatever
// the capability says and nothing else. So an extension that was never granted
// an edit has no address to post to, and one that was cannot reach another
// artifact: the artifact is in the path and the organization comes from the
// session, never from the body.
//
// EVERY ANSWER IS AN OUTCOME, at HTTP 200 wherever the road reached a decision.
// A refusal is a fact about the save, not a transport failure: the display draws
// its indicator from `outcome`, and turning a stale base into a 409 would make
// two vocabularies for one thing. The status codes that remain are the ones
// where there is no decision to report: no session, no organization, no such
// artifact, a body that is not a change set.
// ---------------------------------------------------------------------------
import "server-only";

import { getAuthSession, requireActorContext } from "@/lib/auth-session";
import { readArtifactForDetail } from "@/lib/artifacts/artifact-service";
import { saveArtifactMarkdownEdit } from "@/lib/artifacts/artifact-edit-save";
import { artifactEditSavePorts } from "@/lib/artifacts/artifact-edit-save-ports";
import { ARTIFACT_EDIT_CHANNEL_VERSION } from "@cinatra-ai/sdk-extensions/artifact-edit-channel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ artifactId: string }> };

/** The change set, validated before it is believed. */
function readChangeSet(
  body: unknown,
): { baseRevisionId: string; text: string } | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.channelVersion !== ARTIFACT_EDIT_CHANNEL_VERSION) return null;
  if (typeof b.baseRevisionId !== "string" || b.baseRevisionId.length === 0) return null;
  if (typeof b.text !== "string") return null;
  return { baseRevisionId: b.baseRevisionId, text: b.text };
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const session = await getAuthSession();
  if (!session) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const orgId = session.session?.activeOrganizationId;
  if (!orgId) return Response.json({ ok: false, error: "No active organization" }, { status: 400 });

  const { artifactId } = await params;
  const actor = await requireActorContext();

  // The READ gate first, with the page's own reading: a row the caller may not
  // see 404s, and a row they may list but not read is not-authorized. The write
  // right is a separate question the save road asks next.
  const access = readArtifactForDetail({ artifactId, orgId, actor });
  if (access.kind === "not-found") {
    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  if (access.kind === "denied") {
    return Response.json(
      { outcome: "refused", reason: "no-write-rights" },
      { status: 200 },
    );
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return Response.json({ outcome: "refused", reason: "malformed" }, { status: 200 });
  }
  const changeSet = readChangeSet(parsed);
  if (!changeSet) {
    return Response.json({ outcome: "refused", reason: "malformed" }, { status: 200 });
  }

  const outcome = await saveArtifactMarkdownEdit(
    {
      orgId,
      artifactId,
      baseRevisionId: changeSet.baseRevisionId,
      text: changeSet.text,
      actor: session.user?.id ?? null,
    },
    artifactEditSavePorts({ actor, orgId, artifactId }),
  );

  return Response.json(outcome, {
    status: 200,
    headers: { "Cache-Control": "private, no-store" },
  });
}
