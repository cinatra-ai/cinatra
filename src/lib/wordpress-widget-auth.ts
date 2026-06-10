import "server-only";
import { Buffer } from "node:buffer";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import {
  readConnectorConfigFromDatabase,
  writeConnectorConfigToDatabase,
} from "@/lib/database";

// Widget AUTH-CONFIG storage + webhook HMAC only. The request-time
// origin/token/CORS validation that used to live here moved to the generic,
// declaration-driven src/lib/widget-stream-auth.ts (consumed by the agent
// stream route via the extension's cinatra.widgetStream.auth manifest entry).

const WIDGET_AUTH_CONFIG_KEY = "wordpress_widget_auth";

export type WidgetAuthConfig = {
  apiKey: string;
  webhookSecret: string;
  generatedAt: string;
};

export function readWidgetAuthConfig(): WidgetAuthConfig | null {
  return readConnectorConfigFromDatabase<WidgetAuthConfig | null>(
    WIDGET_AUTH_CONFIG_KEY,
    null,
  );
}

export function generateWidgetAuthConfig(): WidgetAuthConfig {
  const config: WidgetAuthConfig = {
    apiKey: `${randomUUID()}-${randomUUID()}`,
    webhookSecret: randomBytes(32).toString("hex"),
    generatedAt: new Date().toISOString(),
  };
  writeConnectorConfigToDatabase(WIDGET_AUTH_CONFIG_KEY, config);
  return config;
}

/**
 * Verifies an HMAC-SHA256 signature from the WordPress plugin.
 * Uses timingSafeEqual to prevent timing attacks.
 * sigHeader format: "sha256=<hex>"
 */
export function verifyWebhookSignature(
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
