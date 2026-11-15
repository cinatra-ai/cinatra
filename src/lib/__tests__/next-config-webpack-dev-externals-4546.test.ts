/**
 * cinatra#4546: `pnpm dev:webpack` must compile the server graph.
 *
 * `src/instrumentation.node.ts` reaches `packages/agents/src/verdaccio/client.ts`,
 * which imports `pacote`. pnpm installs `pacote` for `packages/agents` and
 * `packages/registries` only, so it does not resolve from the repository root.
 * Next's webpack externals handler bundles every package that does not resolve
 * from the root to the same file, even when `serverExternalPackages` names it.
 * Webpack then walks pacote -> @npmcli/run-script -> node-gyp, whose context
 * `require('./' + command)` pulls in `node-gyp/lib/Find-VisualStudio.cs`. The
 * compile fails ("You may need an appropriate loader to handle this file
 * type") and every request answers HTTP 500. Turbopack (`pnpm dev`) keeps these
 * packages external and is not affected.
 *
 * The test reads the REAL configuration: it imports next.config.ts's default
 * export (Next's config function of the phase) and calls the `webpack()` hook
 * of the development-server phase with a stand-in webpack config. Next treats
 * any `webpack` key as a custom webpack config, so every other phase must get
 * no `webpack` key at all.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from "next/constants";

type ExternalData = { context?: string; request?: string };
type ExternalCallback = (err?: Error | null, result?: string) => void;
type ExternalFn = (data: ExternalData, callback: ExternalCallback) => void;
type WebpackHook = (
  config: { externals?: unknown },
  options: { dev: boolean; isServer: boolean; nextRuntime?: string },
) => { externals?: unknown };
type ConfigForPhase = (phase: string) => Record<string, unknown> & { webpack?: WebpackHook };

const REPO_ROOT = path.resolve(__dirname, "../../..");
const AGENTS_VERDACCIO_DIR = path.join(REPO_ROOT, "packages/agents/src/verdaccio");
const SENTRY_VARS = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"];
const DEV_NODE = { dev: true, isServer: true, nextRuntime: "nodejs" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@sentry/nextjs");
  vi.resetModules();
});

async function loadConfigForPhase(): Promise<ConfigForPhase> {
  for (const name of SENTRY_VARS) vi.stubEnv(name, "");
  vi.resetModules();
  const mod = await import("../../../next.config");
  expect(typeof mod.default, "next.config.ts exports Next's config function of the phase").toBe(
    "function",
  );
  return mod.default as unknown as ConfigForPhase;
}

async function loadDevServerHook(): Promise<WebpackHook> {
  const config = (await loadConfigForPhase())(PHASE_DEVELOPMENT_SERVER);
  expect(typeof config.webpack, "the development-server phase defines a webpack() hook").toBe(
    "function",
  );
  return config.webpack!;
}

// A nonempty existing externals array: the hook must keep every entry, in order, and append its handler.
function existingExternals(): unknown[] {
  const sentinelFn: ExternalFn = (_data, callback) => callback();
  return [sentinelFn, "sentinel-external", { "sentinel-object": "commonjs sentinel-object" }];
}

function devHandler(hook: WebpackHook): ExternalFn {
  const existing = existingExternals();
  const out = hook({ externals: [...existing] }, DEV_NODE);
  expect(Array.isArray(out.externals)).toBe(true);
  const list = out.externals as unknown[];
  expect(list).toHaveLength(existing.length + 1);
  expect(list.slice(0, existing.length)).toEqual(existing);
  expect(list[0]).toBe(existing[0]);
  const handler = list[existing.length];
  expect(typeof handler).toBe("function");
  return handler as ExternalFn;
}

function runExternal(fn: ExternalFn, data: ExternalData): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    fn(data, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

describe("next.config.ts webpack() dev server externals (cinatra#4546)", () => {
  it("keeps the existing externals and appends a handler that externalizes pacote by its resolved path", async () => {
    const handler = devHandler(await loadDevServerHook());

    const result = await runExternal(handler, { context: AGENTS_VERDACCIO_DIR, request: "pacote" });
    expect(result).toBeDefined();
    expect(result!.startsWith("commonjs ")).toBe(true);
    const target = result!.slice("commonjs ".length);
    expect(path.isAbsolute(target)).toBe(true);
    expect(target).toMatch(/[\\/]pacote[\\/]/);
    expect(existsSync(target)).toBe(true);
  });

  it("leaves every other request to the default handling", async () => {
    const handler = devHandler(await loadDevServerHook());
    expect(await runExternal(handler, { context: AGENTS_VERDACCIO_DIR, request: "react" })).toBeUndefined();
    expect(await runExternal(handler, { context: AGENTS_VERDACCIO_DIR, request: "./config" })).toBeUndefined();
  });

  it("calls the callback exactly once and lets an exception it throws propagate", async () => {
    const handler = devHandler(await loadDevServerHook());
    const failure = new Error("callback failed on its first call");
    let calls = 0;
    const callback: ExternalCallback = () => {
      calls += 1;
      if (calls === 1) throw failure;
    };
    expect(() => handler({ context: AGENTS_VERDACCIO_DIR, request: "pacote" }, callback)).toThrow(failure);
    expect(calls).toBe(1);
  });

  it("the dev-server hook keeps the externals of the edge, client and non-dev compiles as they were", async () => {
    const hook = await loadDevServerHook();
    for (const options of [
      { dev: false, isServer: true, nextRuntime: "nodejs" },
      { dev: true, isServer: true, nextRuntime: "edge" },
      { dev: true, isServer: false },
    ]) {
      const existing = existingExternals();
      const out = hook({ externals: [...existing] }, options);
      expect(out.externals, JSON.stringify(options)).toEqual(existing);
      expect((out.externals as unknown[])[0], JSON.stringify(options)).toBe(existing[0]);
    }
  });

  it("gives the production build and production server phases no webpack key", async () => {
    const configForPhase = await loadConfigForPhase();
    for (const phase of [PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER]) {
      expect(Object.prototype.hasOwnProperty.call(configForPhase(phase), "webpack"), phase).toBe(false);
    }
  });

  it("with the Sentry upload set up, hands the webpack key to withSentryConfig in the dev-server phase only", async () => {
    for (const name of SENTRY_VARS) vi.stubEnv(name, `value-of-${name}`);
    vi.resetModules();
    const withSentryConfig = vi.fn((config: Record<string, unknown>) => ({ ...config, wrappedBySentry: true }));
    vi.doMock("@sentry/nextjs", () => ({ withSentryConfig }));
    const mod = await import("../../../next.config");
    const configForPhase = mod.default as unknown as ConfigForPhase;

    const build = configForPhase(PHASE_PRODUCTION_BUILD);
    expect(build.wrappedBySentry).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(withSentryConfig.mock.calls[0][0], "webpack")).toBe(false);

    const dev = configForPhase(PHASE_DEVELOPMENT_SERVER);
    expect(dev.wrappedBySentry).toBe(true);
    expect(typeof withSentryConfig.mock.calls[1][0].webpack).toBe("function");
    expect(withSentryConfig).toHaveBeenCalledTimes(2);
  });
});
