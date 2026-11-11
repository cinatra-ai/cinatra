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
 * export and calls its `webpack()` hook with a stand-in webpack config.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";

type ExternalData = { context?: string; request?: string };
type ExternalCallback = (err?: Error | null, result?: string) => void;
type ExternalFn = (data: ExternalData, callback: ExternalCallback) => void;
type WebpackHook = (
  config: { externals?: unknown },
  options: { dev: boolean; isServer: boolean; nextRuntime?: string },
) => { externals?: unknown };

const REPO_ROOT = path.resolve(__dirname, "../../..");
const AGENTS_VERDACCIO_DIR = path.join(REPO_ROOT, "packages/agents/src/verdaccio");

async function loadWebpackHook(): Promise<WebpackHook> {
  const mod = await import("../../../next.config");
  const config = mod.default as { webpack?: WebpackHook };
  expect(typeof config.webpack, "next.config.ts defines a webpack() hook").toBe("function");
  return config.webpack!;
}

function externalFns(config: { externals?: unknown }): ExternalFn[] {
  const list = Array.isArray(config.externals) ? config.externals : [];
  return list.filter((entry): entry is ExternalFn => typeof entry === "function");
}

function runExternal(fn: ExternalFn, data: ExternalData): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    fn(data, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

describe("next.config.ts webpack() dev server externals (cinatra#4546)", () => {
  it("externalizes pacote for the Node.js dev server by its resolved path", async () => {
    const hook = await loadWebpackHook();
    const out = hook({ externals: [] }, { dev: true, isServer: true, nextRuntime: "nodejs" });
    const fns = externalFns(out);
    expect(fns).toHaveLength(1);

    const result = await runExternal(fns[0], { context: AGENTS_VERDACCIO_DIR, request: "pacote" });
    expect(result).toBeDefined();
    expect(result!.startsWith("commonjs ")).toBe(true);
    const target = result!.slice("commonjs ".length);
    expect(path.isAbsolute(target)).toBe(true);
    expect(target).toMatch(/[\\/]pacote[\\/]/);
    expect(existsSync(target)).toBe(true);
  });

  it("leaves every other request to the default handling", async () => {
    const hook = await loadWebpackHook();
    const fns = externalFns(
      hook({ externals: [] }, { dev: true, isServer: true, nextRuntime: "nodejs" }),
    );
    expect(await runExternal(fns[0], { context: AGENTS_VERDACCIO_DIR, request: "react" })).toBeUndefined();
    expect(await runExternal(fns[0], { context: AGENTS_VERDACCIO_DIR, request: "./config" })).toBeUndefined();
  });

  it("keeps the production build, the edge runtime and the client compile unchanged", async () => {
    const hook = await loadWebpackHook();
    for (const options of [
      { dev: false, isServer: true, nextRuntime: "nodejs" },
      { dev: true, isServer: true, nextRuntime: "edge" },
      { dev: true, isServer: false },
    ]) {
      const out = hook({ externals: [] }, options);
      expect(externalFns(out), JSON.stringify(options)).toHaveLength(0);
    }
  });
});
