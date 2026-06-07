export type AppRuntimeMode = "development" | "production";

const APP_RUNTIME_MODE_ENV_KEYS = ["CINATRA_RUNTIME_MODE", "APP_RUNTIME_MODE"] as const;

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
