export type AppRuntimeMode = "development" | "production";

/**
 * The environment keys this app reads its runtime mode from, in precedence
 * order. EXPORTED because the development-only provisioning gates read the
 * operator's declaration from exactly these, in exactly this order. Those gates
 * judge the declaration more strictly than the app does — deliberately, and
 * only in the closed direction — but they and the app have to be reading the
 * SAME declaration, and nothing pinned that while each file kept its own copy
 * of the tuple.
 */
export const APP_RUNTIME_MODE_ENV_KEYS = [
  "CINATRA_RUNTIME_MODE",
  "APP_RUNTIME_MODE",
] as const;

export function normalizeAppRuntimeMode(value: string | null | undefined): AppRuntimeMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "production" || normalized === "prod" ? "production" : "development";
}

export function getAppRuntimeMode(): AppRuntimeMode {
  for (const key of APP_RUNTIME_MODE_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return normalizeAppRuntimeMode(value);
    }
  }

  return "development";
}

export function isAppDevelopmentMode() {
  return getAppRuntimeMode() === "development";
}
