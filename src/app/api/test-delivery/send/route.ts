/**
 * POST /api/test-delivery/send
 *
 * Thin server-action wrapper invoked by EmailTestDeliveryFormRenderer's Send
 * button. Validates the body with `testSendSchema` (zod) and delegates to the
 * `email_outreach_send_test_start` MCP primitive via an in-process transport.
 *
 * Threat mitigations:
 *   Session gate: require Better Auth session, 401 on missing.
 *   Tamper resistance: strict zod parse drops extras (capped array sizes).
 *   Privilege boundary: actor context is built from session, not request body.
 *     Active-org gate + explicit campaign-ownership lookup run against the
 *     tenant's campaign store before the primitive is invoked.
 *   Error hygiene: 400/500 responses return static messages; full validation
 *     issues + downstream errors are logged server-side.
 *   CSRF protection: origin allowlist gate against BETTER_AUTH_URL.
 *
 * Send is delegated to createTriggerEmailSendUseCases() in
 * @/lib/trigger-email-send-use-cases.
 */
import {
  createInProcessPrimitiveTransport,
  invokePrimitive,
  PrimitiveInvocationError,
  type PrimitiveActorContext,
  type PrimitiveInvocationRequest,
} from "@cinatra-ai/mcp-client";
import {
  createTriggerEmailSendHandlers,
  testSendSchema,
} from "@cinatra-ai/trigger-email-send";
import { z } from "zod";
import { getAuthSession } from "@/lib/auth-session";
import { getCampaignFromDatabase } from "@/lib/database";
import { createTriggerEmailSendUseCases } from "@/lib/trigger-email-send-use-cases";

// Schema is bound at the route level. The package's public schema
// (`testSendSchema` from `@cinatra-ai/trigger-email-send`) is the single source
// of truth for field shape; we extend it with array-length caps so a request
// body cannot blow memory before the primitive runs.
const routeTestSendSchema = testSendSchema.extend({
  specificInitialDraftIds: z.array(z.string()).max(500).optional(),
  specificFollowUpDraftIds: z.array(z.string()).max(500).optional(),
});

function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    // Same-origin POSTs from server-rendered pages may omit Origin in some
    // browsers; fall back to checking the Referer header instead.
    const referer = request.headers.get("referer");
    if (!referer) return true;
    try {
      const refUrl = new URL(referer);
      const allowed = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000");
      return refUrl.origin === allowed.origin;
    } catch {
      return false;
    }
  }
  try {
    const allowed = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000");
    return origin === allowed.origin;
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  // CSRF protection uses the origin allowlist before any request body parsing.
  if (!isAllowedOrigin(request)) {
    return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  const session = await getAuthSession();
  if (!session) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Better Auth sessions always carry a user, but the typesafe access pattern
  // (`session.user?.id`) leaves the door open to forwarding `userId: undefined`
  // to `sendGmailMessage`, which would fall back to an arbitrary OAuth identity.
  // Reject explicitly here so the test send always runs against the
  // authenticated user's mailbox.
  const sessionUserId = session.user?.id;
  if (!sessionUserId) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Require an active organization. The `Campaign` row schema is payload-only
  // and does not carry an explicit `orgId`; tenant isolation is enforced by the
  // per-org Postgres schema (`SUPABASE_SCHEMA`), so a present
  // `activeOrganizationId` plus a successful campaign lookup against the
  // tenant's store is the equivalent ownership check.
  const activeOrgId = session.session?.activeOrganizationId;
  if (!activeOrgId) {
    return Response.json({ ok: false, error: "No active organization" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = routeTestSendSchema.safeParse(raw);
  if (!parsed.success) {
    // Log full zod issues server-side and return a sanitized message.
    console.warn("test-delivery validation failed", parsed.error.issues);
    return Response.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  // Verify the campaign exists in the active tenant's store before invoking the
  // primitive. Return 404, not 403, to avoid leaking the existence of campaigns
  // in other tenants.
  const campaign = await getCampaignFromDatabase(parsed.data.campaignId);
  if (!campaign) {
    return Response.json({ ok: false, error: "Campaign not found" }, { status: 404 });
  }

  const actor: PrimitiveActorContext = {
    actorType: "human",
    source: "route",
    userId: sessionUserId,
    sessionId: session.session?.id,
  };

  try {
    const handlers: Record<
      string,
      (req: PrimitiveInvocationRequest<unknown>) => Promise<unknown>
    > = createTriggerEmailSendHandlers(createTriggerEmailSendUseCases());
    const transport = createInProcessPrimitiveTransport(handlers);
    await invokePrimitive(transport, {
      primitiveName: "email_outreach_send_test_start",
      input: parsed.data,
      actor,
      mode: "deterministic",
    });
    return Response.json({ ok: true, sentTo: parsed.data.recipientEmail });
  } catch (err) {
    // Log the real error server-side and return a sanitized message.
    const realMessage =
      err instanceof PrimitiveInvocationError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Unknown error";
    console.warn("test-delivery send failed", realMessage);
    return Response.json({ ok: false, error: "Send failed" }, { status: 500 });
  }
}
