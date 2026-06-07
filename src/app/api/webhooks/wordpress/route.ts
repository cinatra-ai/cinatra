import "server-only";
import { z } from "zod";
import {
  readWidgetAuthConfig,
  verifyWebhookSignature,
} from "@/lib/wordpress-widget-auth";

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
  const sigHeader = request.headers.get("X-Cinatra-Sig-256") ?? "";

  const config = readWidgetAuthConfig();
  if (!config) {
    return Response.json(
      { error: "WordPress widget integration not configured. Generate credentials at /connectors/cinatra-ai/wordpress-assistant-connector/setup first." },
      { status: 400 },
    );
  }

  if (!verifyWebhookSignature(rawBody, sigHeader, config.webhookSecret)) {
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
