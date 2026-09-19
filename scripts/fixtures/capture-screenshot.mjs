// Standalone development producer. Use the workspace's SSR loader for the real
// host modules (TS path aliases, top-level await and mixed package formats).
// No HTTP server is exposed, and no database/provider module is mocked.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createViteServer } from "vitest/node";

if (process.env.CINATRA_RUNTIME_MODE !== "development") {
  throw new Error("Screenshot fixtures require CINATRA_RUNTIME_MODE=development");
}
const root = fileURLToPath(new URL("../../", import.meta.url));
const server = await createViteServer({
  root, configFile: false, appType: "custom", logLevel: "error",
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true },
  plugins: [{
    name: "fixture-commonjs-path-globals",
    transform(code, id) {
      const file = id.split("?")[0];
      if (!file.startsWith(root) || file.includes("/node_modules/") || !/\.[cm]?[jt]sx?$/.test(file)) return;
      const globals = { __dirname: path.dirname(file), __filename: file };
      const prefix = Object.entries(globals)
        .filter(([name]) => code.includes(name) && !new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(code))
        .map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`);
      if (/\brequire\s*\(/.test(code) && !/\b(?:const|let|var|function)\s+require\b/.test(code)) {
        prefix.push(`import { createRequire as __fixtureCreateRequire } from "node:module";\nconst require = __fixtureCreateRequire(${JSON.stringify(file)});`);
      }
      return prefix.length ? { code: `${prefix.join("\n")}\n${code}`, map: null } : undefined;
    },
  }],
  resolve: {
    tsconfigPaths: true,
    // This marker is consumed by Next's bundler. This process is already Node;
    // consume that marker without selecting React's incompatible RSC build.
    alias: [{ find: "server-only", replacement: path.join(root, "tests/__stubs__/server-only.ts") }],
  },
});
let status = 0;
try {
  await server.ssrLoadModule("/scripts/fixtures/capture-screenshot.mts");
} catch (error) {
  console.error(error);
  status = 1;
} finally {
  await server.close();
}
// Host database pools are process-wide; this one-shot fixture serves no jobs.
process.exit(status);
