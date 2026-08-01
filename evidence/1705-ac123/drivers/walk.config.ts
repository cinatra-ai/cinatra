import { defineConfig } from "vitest/config";
import * as path from "node:path";

// Lane driver config for cinatra#1705 AC1/AC2/AC3 (the live-provider proof set).
//
// Same shape as evidence/2047-observability/walk.config.ts: the driver lives
// OUTSIDE src/ (so it is not part of any shipped tier and not scanned by the
// extension-import inventory), but runs with the repo root as its vitest root
// so `@/...` and every workspace package resolve exactly as they do in the app.
const ROOT = path.resolve(__dirname, "..", "..", "..");

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: [
      { find: "server-only", replacement: path.join(ROOT, "tests/__stubs__/server-only.ts") },
      // Same bare-barrel stub the ROOT vitest config uses: the real
      // @cinatra-ai/skills barrel is not loadable in a vitest graph (it pulls
      // @cinatra-ai/llm back in and the MCP-instructions reader runs at module
      // init). Exact-match only, so real subpaths still resolve to real code.
      // Unrelated to anything this lane asserts.
      // ...extended by ONE symbol (`readSkillFileContent`) the shared stub does
      // not carry and AC3's staged-skill walker needs. See the header of
      // skills-barrel-stub.ts: everything else is re-exported unchanged.
      {
        find: /^@cinatra-ai\/skills$/,
        replacement: path.join(ROOT, "evidence/1705-ac123/drivers/skills-barrel-stub.ts"),
      },
      // Auth is irrelevant to this lane (the actor is supplied explicitly as an
      // ActorContext). The real @/lib/auth boots better-auth, which probes its
      // own `public.user` table at init and fails the module graph. Same stub
      // the ROOT vitest config uses.
      { find: "@/lib/auth", replacement: path.join(ROOT, "tests/__stubs__/auth.ts") },
      {
        find: "@cinatra-ai/openai-connector/adapter",
        replacement: path.join(ROOT, "extensions/cinatra-ai/openai-connector/src/adapter/openai-adapter.ts"),
      },
      {
        find: "@cinatra-ai/anthropic-connector/adapter",
        replacement: path.join(ROOT, "extensions/cinatra-ai/anthropic-connector/src/adapter/anthropic-adapter.ts"),
      },
      {
        find: "@cinatra-ai/llm/execution-plane",
        replacement: path.join(ROOT, "packages/llm/src/execution-plane/index.ts"),
      },
    ],
  },
  test: {
    root: ROOT,
    include: ["evidence/1705-ac123/drivers/*.walk.test.ts"],
    // Real provider round trips over a real Docker sandbox: minutes, not seconds.
    testTimeout: 900_000,
    hookTimeout: 900_000,
    // One docker daemon, one gateway container, one L0 network - strictly serial.
    fileParallelism: false,
    sequence: { concurrent: false },
    pool: "forks",
  },
});
