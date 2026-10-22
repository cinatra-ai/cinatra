import { builtForProduction } from "./build-target";

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

/**
 * The words that name a runtime mode, compared with surrounding blanks trimmed
 * and letter case folded (cinatra#3884). Only a DEVELOPMENT word makes a named
 * mode development. A PRODUCTION word, and every word this app does not
 * recognise (`staging`, `Prod-like`, a misspelling of the development word),
 * reads production: the runtime mode is what turns the development-only paths
 * on, so a word nobody can vouch for keeps them off.
 *
 * Both lists are exported for the development-only provisioning gates
 * (`src/lib/dev-instance-provisioning/runtime-gate.ts`), which judge a
 * declaration more strictly than this reading does and have to tell a
 * production word from a word that names no runtime mode at all.
 */
export const APP_DEVELOPMENT_MODE_WORDS = ["development", "dev"] as const;
export const APP_PRODUCTION_MODE_WORDS = ["production", "prod"] as const;

function foldModeWord(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Is `value` a development word or a production word, as the lists above spell them? */
export function isRecognisedAppRuntimeModeWord(value: string | null | undefined): boolean {
  const word = foldModeWord(value);
  return (
    (APP_DEVELOPMENT_MODE_WORDS as readonly string[]).includes(word) ||
    (APP_PRODUCTION_MODE_WORDS as readonly string[]).includes(word)
  );
}

/** A development word reads development; every other value reads production. */
export function normalizeAppRuntimeMode(value: string | null | undefined): AppRuntimeMode {
  return (APP_DEVELOPMENT_MODE_WORDS as readonly string[]).includes(foldModeWord(value))
    ? "development"
    : "production";
}

/**
 * A key of APP_RUNTIME_MODE_ENV_KEYS that carries a non-blank value decides, the first in order:
 * a development word reads development, and every other word production (normalizeAppRuntimeMode).
 * When none does, the build decides: an application built for production (NODE_ENV "production")
 * runs in production mode, and every other process runs in development mode.
 */
export function getAppRuntimeMode(): AppRuntimeMode {
  for (const key of APP_RUNTIME_MODE_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return normalizeAppRuntimeMode(value);
    }
  }

  return builtForProduction() ? "production" : "development";
}

export function isAppDevelopmentMode() {
  return getAppRuntimeMode() === "development";
}
