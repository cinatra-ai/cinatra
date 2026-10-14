import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APP_DEVELOPMENT_MODE_WORDS,
  APP_PRODUCTION_MODE_WORDS,
  APP_RUNTIME_MODE_ENV_KEYS,
  getAppRuntimeMode,
  isAppDevelopmentMode,
  isRecognisedAppRuntimeModeWord,
  normalizeAppRuntimeMode,
} from "@/lib/runtime-mode";

type Stub = string | undefined;

function setEnv(input: { first?: Stub; second?: Stub; nodeEnv?: Stub }) {
  vi.stubEnv("CINATRA_RUNTIME_MODE", input.first);
  vi.stubEnv("APP_RUNTIME_MODE", input.second);
  vi.stubEnv("NODE_ENV", input.nodeEnv);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getAppRuntimeMode", () => {
  it("an application built for production that names no runtime mode runs in production mode", () => {
    setEnv({ nodeEnv: "production" });
    expect(getAppRuntimeMode()).toBe("production");
    expect(isAppDevelopmentMode()).toBe(false);
  });

  it("a blank runtime mode names none: an application built for production runs in production mode", () => {
    setEnv({ first: "   ", second: "   ", nodeEnv: "production" });
    expect(getAppRuntimeMode()).toBe("production");
  });

  it("a development server that names no runtime mode runs in development mode", () => {
    setEnv({ nodeEnv: "development" });
    expect(getAppRuntimeMode()).toBe("development");
    expect(isAppDevelopmentMode()).toBe(true);
  });

  it("a test run that names no runtime mode runs in development mode", () => {
    setEnv({ nodeEnv: "test" });
    expect(getAppRuntimeMode()).toBe("development");
  });

  it("a process that names neither a runtime mode nor a build runs in development mode", () => {
    setEnv({});
    expect(getAppRuntimeMode()).toBe("development");
  });

  it("a named production mode runs in production mode under every build", () => {
    for (const key of APP_RUNTIME_MODE_ENV_KEYS) {
      for (const value of ["production", "prod", "Production ", " PROD"]) {
        for (const nodeEnv of ["development", "test", "production"]) {
          vi.unstubAllEnvs();
          setEnv({ nodeEnv });
          vi.stubEnv(key, value);
          expect(getAppRuntimeMode()).toBe("production");
        }
      }
    }
  });

  it("a named development mode runs in development mode under a production build", () => {
    for (const key of APP_RUNTIME_MODE_ENV_KEYS) {
      vi.unstubAllEnvs();
      setEnv({ nodeEnv: "production" });
      vi.stubEnv(key, "development");
      expect(getAppRuntimeMode()).toBe("development");
      expect(isAppDevelopmentMode()).toBe(true);
    }
  });

  it("the first key decides when both name a mode", () => {
    setEnv({ first: "development", second: "production", nodeEnv: "production" });
    expect(getAppRuntimeMode()).toBe("development");
    setEnv({ first: "production", second: "development", nodeEnv: "development" });
    expect(getAppRuntimeMode()).toBe("production");
    setEnv({ first: "   ", second: "production", nodeEnv: "development" });
    expect(getAppRuntimeMode()).toBe("production");
    expect([...APP_RUNTIME_MODE_ENV_KEYS]).toEqual(["CINATRA_RUNTIME_MODE", "APP_RUNTIME_MODE"]);
  });
});

describe("normalizeAppRuntimeMode", () => {
  it("a named mode reads production for production and prod and development for development", () => {
    expect(normalizeAppRuntimeMode("production")).toBe("production");
    expect(normalizeAppRuntimeMode("prod")).toBe("production");
    expect(normalizeAppRuntimeMode(" PROD ")).toBe("production");
    expect(normalizeAppRuntimeMode("development")).toBe("development");
    expect(normalizeAppRuntimeMode("Development")).toBe("development");
  });
});

// ---------------------------------------------------------------------------
// cinatra#3884 — a runtime mode named with a word this app does not recognise
// runs in production mode. Only a development word reads development; a
// production word and every other named word read production, under every
// build and from either key.
// ---------------------------------------------------------------------------

describe("cinatra#3884 — a runtime mode named with an unrecognised word", () => {
  const NODE_ENVS = ["development", "test", "production"];

  function readUnder(
    key: (typeof APP_RUNTIME_MODE_ENV_KEYS)[number],
    value: string,
    nodeEnv: string,
  ) {
    vi.unstubAllEnvs();
    setEnv({ nodeEnv });
    vi.stubEnv(key, value);
    return { mode: getAppRuntimeMode(), development: isAppDevelopmentMode() };
  }

  it("staging and Prod-like read production under every build, from either key", () => {
    for (const key of APP_RUNTIME_MODE_ENV_KEYS) {
      for (const value of ["staging", "Prod-like", " Staging ", "preview"]) {
        for (const nodeEnv of NODE_ENVS) {
          expect(readUnder(key, value, nodeEnv), `${key}=${JSON.stringify(value)} NODE_ENV=${nodeEnv}`).toEqual({
            mode: "production",
            development: false,
          });
        }
      }
    }
  });

  it("a misspelling of the development word reads production under every build, from either key", () => {
    for (const key of APP_RUNTIME_MODE_ENV_KEYS) {
      for (const value of ["developmnet", "Developement", "develop", "devel"]) {
        for (const nodeEnv of NODE_ENVS) {
          expect(readUnder(key, value, nodeEnv), `${key}=${JSON.stringify(value)} NODE_ENV=${nodeEnv}`).toEqual({
            mode: "production",
            development: false,
          });
        }
      }
    }
  });

  it("the development words read development and the production words production, under every build", () => {
    for (const key of APP_RUNTIME_MODE_ENV_KEYS) {
      for (const nodeEnv of NODE_ENVS) {
        for (const value of ["development", "Development", "dev", " DEV ", "\tdev\n"]) {
          expect(readUnder(key, value, nodeEnv), `${key}=${JSON.stringify(value)} NODE_ENV=${nodeEnv}`).toEqual({
            mode: "development",
            development: true,
          });
        }
        for (const value of ["production", "prod", " PROD "]) {
          expect(readUnder(key, value, nodeEnv), `${key}=${JSON.stringify(value)} NODE_ENV=${nodeEnv}`).toEqual({
            mode: "production",
            development: false,
          });
        }
      }
    }
  });

  it("normalizeAppRuntimeMode reads only a development word as development", () => {
    expect(normalizeAppRuntimeMode("dev")).toBe("development");
    expect(normalizeAppRuntimeMode(" Dev ")).toBe("development");
    expect(normalizeAppRuntimeMode("staging")).toBe("production");
    expect(normalizeAppRuntimeMode("Prod-like")).toBe("production");
    expect(normalizeAppRuntimeMode("developmnet")).toBe("production");
  });

  it("the recognised words are exactly the development words and the production words", () => {
    expect([...APP_DEVELOPMENT_MODE_WORDS]).toEqual(["development", "dev"]);
    expect([...APP_PRODUCTION_MODE_WORDS]).toEqual(["production", "prod"]);
    for (const word of ["development", "Dev", "production", " PROD "]) {
      expect(isRecognisedAppRuntimeModeWord(word), word).toBe(true);
    }
    for (const word of ["staging", "Prod-like", "developmnet", "demo", "test", ""]) {
      expect(isRecognisedAppRuntimeModeWord(word), word).toBe(false);
    }
  });
});
