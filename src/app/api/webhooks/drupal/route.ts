import "server-only";
import { z } from "zod";
import {
  readDrupalWidgetAuthConfig,
  verifyDrupalWebhookSignature,
} from "@/lib/drupal-widget-auth";

// Host contract for the Drupal module's node-publish notification path
// (drupal-module#72 routing step 1). The byte-for-byte twin of
// src/app/api/webhooks/wordpress/route.ts: a console-only receiver (no side
// effects) that authenticates the sender by the bespoke legacy
// `X-Cinatra-Sig-256: sha256=<hmac>` HMAC over the raw body under the single
// shared drupal_widget_auth.webhookSecret. The drupal-module emitter
// (hook_ENTITY_TYPE_insert/update, a later step) pins to THIS payload + signature.
//
// WIRE CONTRACT (what the Drupal emitter POSTs to {cinatra_url}/api/webhooks/drupal):
//   headers: X-Cinatra-Sig-256: sha256=<hmac-sha256(rawBody, webhookSecret)>
//   body: { event:"node_published", nodeId:int>0, nodeType:string, title:string,
//           url?:string, siteUrl:string, issuedAt:string }
// nodeId is an integer: the emitter casts Drupal's numeric-string $node->id()
// exactly as the WordPress plugin casts (int) $post->ID.

const DrupalWebhookPayloadSchema = z.object({
  event: z.literal("node_published"),
  nodeId: z.number().int().positive(),
  nodeType: z.string(),
  title: z.string(),
  url: z.string().url().optional(),
  siteUrl: z.string(),
  issuedAt: z.string(),
});

export async function POST(request: Request) {
  // Read raw body BEFORE parsing — HMAC must be computed over the exact bytes received.
  const rawBody = await request.text();
  const sigHeader = request.headers.get("X-Cinatra-Sig-256") ?? "";

  const config = readDrupalWidgetAuthConfig();
  if (!config?.webhookSecret) {
    return Response.json(
      { error: "Drupal widget integration not configured. Generate credentials at /connectors/cinatra-ai/drupal-assistant-connector/setup first." },
      { status: 400 },
    );
  }

  if (!verifyDrupalWebhookSignature(rawBody, sigHeader, config.webhookSecret)) {
    console.warn("[drupal-webhook] Invalid signature — rejected request from", request.headers.get("user-agent") ?? "unknown");
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }

  let payload: z.infer<typeof DrupalWebhookPayloadSchema>;
  try {
    payload = DrupalWebhookPayloadSchema.parse(JSON.parse(rawBody));
  } catch (parseError) {
    return Response.json(
      { error: "Invalid payload.", detail: parseError instanceof Error ? parseError.message : "unknown" },
      { status: 400 },
    );
  }

  // Record the event for webhook observability without triggering side effects
  // from this route.
  console.log("[drupal-webhook] Received event", {
    event: payload.event,
    nodeId: payload.nodeId,
    nodeType: payload.nodeType,
    title: payload.title,
    url: payload.url,
    siteUrl: payload.siteUrl,
    issuedAt: payload.issuedAt,
  });

  return Response.json({ ok: true });
}
