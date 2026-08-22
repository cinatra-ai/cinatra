import { defineConfig } from "vitest/config";
import * as path from "node:path";

const root = path.resolve(__dirname, "../..");

// Minimal vitest config for @cinatra-ai/chat unit tests.
// Mirrors packages/agent-builder/vitest.config.ts — stubs server-only so
// "use server" files can be imported in tests, and pins React to the
// workspace copy shared by @testing-library/react.
const serverOnlyStub = path.join(root, "packages/agents/tests/__stubs__/server-only.ts");

export default defineConfig({
  resolve: {
    alias: {
      "server-only": serverOnlyStub,
      // Resolve the workspace subpath exports used by chat — tsconfig.json
      // maps these to package source files; vite needs the same hint because
      // the chat package's package.json does not declare `exports`.
      // Compatibility alias for @cinatra/agent-builder imports that now resolve
      // through the agents package.
      "@cinatra/agent-builder/client-entry": path.join(
        root,
        "packages/agents/src/client-entry.ts",
      ),
      "@cinatra/agent-builder": path.join(
        root,
        "packages/agents/src/index.ts",
      ),
      // Chart payload contract subpath (mirrors tsconfig.json) — imported by
      // renderer/index.ts since the S9-b chart host cutover (#1740). MUST
      // precede the /renderable-views key below: vite's string `find`
      // prefix-matches, so the registry entry would otherwise rewrite this to
      // `…/renderable-views/index.ts/chart` (unresolvable).
      "@cinatra-ai/agent-ui-protocol/renderable-views/chart": path.join(
        root,
        "packages/agent-ui-protocol/src/renderable-views/chart.ts",
      ),
      // S4 renderable-view schema registry subpath (mirrors tsconfig.json).
      // Vite matches aliases by PREFIX, so the deep lifecycle-cards specifier
      // (cinatra#2568 — imported deeply so the zod view-schema chain stays out
      // of the locked routes' graphs) must be listed BEFORE the barrel entry.
      "@cinatra-ai/agent-ui-protocol/renderable-views/lifecycle-cards": path.join(
        root,
        "packages/agent-ui-protocol/src/renderable-views/lifecycle-cards.ts",
      ),
      "@cinatra-ai/agent-ui-protocol/renderable-views": path.join(
        root,
        "packages/agent-ui-protocol/src/renderable-views/index.ts",
      ),
      // S1 contract/handshake thin entries used by the S2 headless AG-UI chat
      // client (mirrors tsconfig.json). Subpath keys MUST precede the bare
      // package key below — vite's string `find` prefix-matches, so the bare
      // entry would otherwise rewrite these to `…/index.ts/contract`.
      "@cinatra-ai/agent-ui-protocol/contract": path.join(
        root,
        "packages/agent-ui-protocol/src/contract.ts",
      ),
      "@cinatra-ai/agent-ui-protocol/handshake": path.join(
        root,
        "packages/agent-ui-protocol/src/handshake.ts",
      ),
      // The bare protocol barrel (AG_UI_EVENT_TYPES etc.) — light leaves only.
      "@cinatra-ai/agent-ui-protocol": path.join(
        root,
        "packages/agent-ui-protocol/src/index.ts",
      ),
      // cinatra#2566 — the lifecycle-card runtime and the ONE review renderer
      // live in the agents package (the run card must reach them too, and chat
      // depends on agents, never the other way round). Subpath aliases, so they
      // MUST stay above the bare-package entry below.
      "@cinatra-ai/agents/lifecycle-card-runtime": path.join(
        root,
        "packages/agents/src/lifecycle-card-runtime.tsx",
      ),
      "@cinatra-ai/agents/review-gate-card": path.join(
        root,
        "packages/agents/src/review-gate-card.tsx",
      ),
      // The §V recommendation card — the message list mounts it on the
      // `chat_thread` host, so it must resolve here exactly as tsconfig maps it.
      "@cinatra-ai/agents/run-recommendation-card": path.join(
        root,
        "packages/agents/src/run-recommendation-chip-row.tsx",
      ),
      // cinatra#2789 — §VII's ONE audit renderer, dispatched by the registry
      // under test. Subpath alias, so it stays above the bare-package entry.
      "@cinatra-ai/agents/verification-summary-card": path.join(
        root,
        "packages/agents/src/verification-summary-card.tsx",
      ),
      // cinatra#2788 — the registry now dispatches the schedule kind to its own
      // drawn card, so the column's DOM tests have to resolve it too.
      "@cinatra-ai/agents/schedule-proposal-card": path.join(
        root,
        "packages/agents/src/schedule-proposal-card.tsx",
      ),
      // cinatra#2683 — the conversation column mounts the REAL message list in
      // a DOM test, so the leaves that list reaches must resolve here as they do
      // in tsconfig.json. Subpath keys, so they stay above the bare entry.
      "@cinatra-ai/agents/client-entry": path.join(
        root,
        "packages/agents/src/client-entry.ts",
      ),
      "@cinatra-ai/agents/llm-provider-policy": path.join(
        root,
        "packages/agents/src/llm-provider-policy.ts",
      ),
      "@cinatra-ai/agents": path.join(
        root,
        "packages/agents/src/index.ts",
      ),
      // The chat tests vi.mock the app `@/lib/notifications*` specifiers; vite
      // import-analysis must resolve a bare specifier before a test's vi.mock()
      // can replace it — so map those `@/` paths to their source files.
      // (The useAgentCreationProgress hook itself now imports `@cinatra-ai/notifications/*`.)
      // notifications-flyout.tsx (imported through @cinatra-ai/notifications)
      // reads the app notification context — map it to the real source so the
      // import resolves; tests vi.mock it where behaviour matters.
      "@/context/notification-context": path.join(
        root,
        "src/context/notification-context.tsx",
      ),
      "@/lib/notifications/flyout-state": path.join(
        root,
        "packages/notifications/src/flyout-state.ts",
      ),
      "@/lib/notifications": path.join(root, "src/lib/notifications.ts"),
      // cinatra#2683 — the conversation column's NARROW sdk-ui subpaths (the
      // composer + the widget contract), mirroring tsconfig.json. They MUST
      // precede any bare `@cinatra-ai/sdk-ui` entry: vite prefix-matches a
      // string `find`. Importing the barrel instead would drag the page
      // chrome's graph — which reaches host server modules — into a DOM test.
      "@cinatra-ai/sdk-ui/prompt-field": path.join(
        root,
        "packages/sdk-ui/src/prompt-field.tsx",
      ),
      "@cinatra-ai/sdk-ui/widget": path.join(root, "packages/sdk-ui/src/widget.tsx"),
      // Pin React to the root workspace copy so react-dom and react match
      // (avoids "Invalid hook call" from two resolved copies in a pnpm workspace).
      // Resolve via the stable top-level `node_modules/react(-dom)` symlink
      // instead of a package-manager-internal `.pnpm` path, and add the
      // jsx-runtime subpaths the automatic JSX transform needs for `.test.tsx`.
      react: path.join(root, "node_modules/react"),
      "react/jsx-runtime": path.join(
        root,
        "node_modules/react/jsx-runtime.js",
      ),
      "react/jsx-dev-runtime": path.join(
        root,
        "node_modules/react/jsx-dev-runtime.js",
      ),
      "react-dom": path.join(root, "node_modules/react-dom"),
      "react-dom/client": path.join(
        root,
        "node_modules/react-dom/client.js",
      ),
      // Fallback for remaining app `@/` imports pulled in transitively (e.g.
      // notifications-flyout.tsx -> @/components/ui/badge). Listed LAST so the
      // specific stub aliases above keep winning; vite object aliases are
      // prefix-replacements evaluated in insertion order.
      "@/": path.join(root, "src") + "/",
    },
  },
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.tsx"],
    // @ts-ignore — environmentMatchGlobs is a valid vitest option but missing from InlineConfig types
    environmentMatchGlobs: [["src/**/__tests__/**/*.test.tsx", "jsdom"]],
  },
});
