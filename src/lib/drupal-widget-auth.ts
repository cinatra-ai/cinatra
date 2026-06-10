import "server-only";
import { randomUUID } from "node:crypto";

import {
  readConnectorConfigFromDatabase,
  writeConnectorConfigToDatabase,
} from "@/lib/database";

// Widget AUTH-CONFIG storage only. The request-time origin/token/CORS
// validation that used to live here moved to the generic, declaration-driven
// src/lib/widget-stream-auth.ts (consumed by the agent stream route via the
// extension's cinatra.widgetStream.auth manifest entry).

const WIDGET_AUTH_CONFIG_KEY = "drupal_widget_auth";

export type DrupalWidgetAuthConfig = {
  apiKey: string;
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
    generatedAt: new Date().toISOString(),
  };
  writeConnectorConfigToDatabase(WIDGET_AUTH_CONFIG_KEY, config);
  return config;
}
