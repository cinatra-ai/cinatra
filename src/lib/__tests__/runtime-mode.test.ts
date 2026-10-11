import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APP_RUNTIME_MODE_ENV_KEYS,
  getAppRuntimeMode,
  isAppDevelopmentMode,
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
