import "server-only";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { verifyLegacyHmac } from "@cinatra-ai/webhooks";
import { requireWordPressWidgetAuth } from "@/lib/widget-auth-provider";

const WordPressWebhookPayloadSchema = z.object({
  event: z.literal("post_published"),
  postId: z.number().int().positive(),
  postType: z.string(),
  title: z.string(),
  url: z.string().url().optional(),
  siteUrl: z.string(),
  issuedAt: z.string(),
});

export async function POST(request: Request) {
  // Read raw body BEFORE parsing — HMAC must be computed over the exact bytes received.
  const rawBody = await request.text();
  const sigHeader = request.headers.get("X-Cinatra-Sig-256");

  // FAIL-LOUD (cinatra#975): the widget-auth store is the connector-registered
  // `@cinatra-ai/host:wordpress-widget-auth` capability, resolved lazily. A
  // missing connector THROWS (a logged 500) rather than silently accepting an
  // unverifiable webhook. A resolved-but-unconfigured store (no creds minted)
  // keeps its historical 400 "not configured" behavior.
  const config = (await requireWordPressWidgetAuth()).read();
  if (!config) {
    return Response.json(
      { error: "WordPress widget integration not configured. Generate credentials at /connectors/cinatra-ai/wordpress-assistant-connector/setup first." },
      { status: 400 },
    );
  }

  // Bespoke legacy `sha256=<hex>` HMAC over the exact raw bytes under the shared
  // secret — the ONE owned constant-time comparison in @cinatra-ai/webhooks
  // (verifyLegacyHmac), identical crypto to the former in-core verify. The body
  // is utf8-encoded to the same bytes createHmac.update(string) produced.
  if (!verifyLegacyHmac(Buffer.from(rawBody), sigHeader, config.webhookSecret)) {
    console.warn("[wordpress-webhook] Invalid signature — rejected request from", request.headers.get("user-agent") ?? "unknown");
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }

  let payload: z.infer<typeof WordPressWebhookPayloadSchema>;
  try {
    payload = WordPressWebhookPayloadSchema.parse(JSON.parse(rawBody));
  } catch (parseError) {
    return Response.json(
      { error: "Invalid payload.", detail: parseError instanceof Error ? parseError.message : "unknown" },
      { status: 400 },
    );
  }

  // Record the event for webhook observability without triggering side effects
  // from this route.
  console.log("[wordpress-webhook] Received event", {
    event: payload.event,
    postId: payload.postId,
    postType: payload.postType,
    title: payload.title,
    url: payload.url,
    siteUrl: payload.siteUrl,
    issuedAt: payload.issuedAt,
  });

  return Response.json({ ok: true });
}
