import "server-only";
import { Buffer } from "node:buffer";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  readConnectorConfigFromDatabase,
  writeConnectorConfigToDatabase,
} from "@/lib/database";

// Widget AUTH-CONFIG storage + webhook HMAC only. The request-time
// origin/token/CORS validation that used to live here moved to the generic,
// declaration-driven src/lib/widget-stream-auth.ts (consumed by the agent
// stream route via the extension's cinatra.widgetStream.auth manifest entry).

const WIDGET_AUTH_CONFIG_KEY = "drupal_widget_auth";

export type DrupalWidgetAuthConfig = {
  apiKey: string;
  // Single shared HMAC secret the host /api/webhooks/drupal receiver verifies
  // inbound `node_published` notifications against (mirrors the WordPress twin's
  // wordpress_widget_auth.webhookSecret). Typed required — but a config persisted
  // before this field existed lacks it at runtime (the DB read is a JSON cast),
  // so the receiver treats it as possibly-absent and fails closed.
  webhookSecret: string;
  generatedAt: string;
};

export function readDrupalWidgetAuthConfig(): DrupalWidgetAuthConfig | null {
  return readConnectorConfigFromDatabase<DrupalWidgetAuthConfig | null>(
    WIDGET_AUTH_CONFIG_KEY,
    null,
  );
}

export function generateDrupalWidgetAuthConfig(): DrupalWidgetAuthConfig {
  const config: DrupalWidgetAuthConfig = {
    apiKey: `${randomUUID()}-${randomUUID()}`,
    webhookSecret: randomBytes(32).toString("hex"),
    generatedAt: new Date().toISOString(),
  };
  writeConnectorConfigToDatabase(WIDGET_AUTH_CONFIG_KEY, config);
  return config;
}

/**
 * Verifies an HMAC-SHA256 signature from the Drupal module's node-publish
 * emitter. Uses timingSafeEqual to prevent timing attacks. The byte-for-byte
 * mirror of the WordPress twin (@/lib/wordpress-widget-auth.verifyWebhookSignature):
 * both are the bespoke legacy `X-Cinatra-Sig-256: sha256=<hex>` scheme the
 * locally-shipped CMS integrations sign with.
 *
 * sigHeader format: "sha256=<hex>"
 */
export function verifyDrupalWebhookSignature(
  rawBody: string,
  sigHeader: string,
  secret: string,
): boolean {
  if (!sigHeader.startsWith("sha256=")) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const sigBuf = Buffer.from(sigHeader);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(sigBuf, expectedBuf);
  } catch {
    return false;
  }
}
