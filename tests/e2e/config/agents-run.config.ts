/**
 * Path-gated Playwright config for the `/agents` (All Agents run-agent
 * picker — cinatra#1007 moved this from `/agents/run`) end-to-end harness.
 *
 * Runs against the canonical `cinatra` schema on port 3000 by default
 * (the main worktree's dev server) — distinct from the dashboards smoke
 * which targets port 3100. This is intentional: `/agents` E2E must
 * exercise real WayFlow mounts, real OAuth tokens, and the canonical
 * BullMQ queue, none of which a scoped feature-branch schema can
 * provide. Per the live-test invariant, actual execution happens on the
 * main worktree.
 *
 * The preflight project asserts the 16-agent canonical visible set
 * BEFORE any agent test runs — if we're attached to a feature branch's
 * scoped schema by accident, this fails fast with a clear error
 * instead of pretending the harness is broken.
 */
import { defineConfig } from "@playwright/test";
import { REPO_ROOT, baseUse, desktopChrome, repoPath, suitePath } from "./base";

const PORT = Number(process.env.E2E_AGENTS_RUN_PORT ?? 3000);
const BASE_URL = process.env.E2E_AGENTS_RUN_BASE_URL ?? `http://localhost:${PORT}`;

// When E2E_REUSE_SERVER=1, Playwright attaches to an already-running server
// (or, for the static `tunnel-wiring` invariant project, needs no server at
// all) instead of booting its own `pnpm dev`. Mirrors the render-smoke config.
// The live agent-execution projects (preflight, agents-run, chat-*) still need
// the canonical long-lived schema + WayFlow + real credentials and are not run
// under this path.
const EXTERNAL_SERVER = process.env.E2E_REUSE_SERVER === "1";

export default defineConfig({
  testDir: suitePath("agents-run"),
  outputDir: repoPath("test-results"),
  // Runs are long because real WayFlow execution + LLM bridge calls happen.
  // Tighten per-test in fixtures.ts if a specific agent needs less.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  // Strictly serial — every test mutates real `agent_runs` rows and depends
  // on shared Redis/BullMQ ordering. Parallel is a regression footgun.
  fullyParallel: false,
  workers: 1,

  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: repoPath("playwright-report") }]]
    : [["list"]],

  use: {
    baseURL: BASE_URL,
    // Diagnostics on failure: these flows have many moving parts
    // (WayFlow, A2A, BullMQ); silent failures are worse than verbose
    // trace dumps.
    ...baseUse,
  },

  // Attach to a running dev server if present (the developer's canonical
  // main dev server on port 3000). On CI / clean envs we boot a fresh
  // `pnpm dev`. The agents-run config defaults to `reuseExistingServer:
  // true` because the canonical schema can never be created on demand —
  // it lives in long-lived dev infrastructure.
  webServer: EXTERNAL_SERVER
    ? undefined
    : {
        // POSTGRES_SYNC_TIMEOUT_MS=90s: `pnpm dev` (Turbopack) + sustained
        // suite load starves the synchronous Postgres worker thread; the
        // production 30s ceiling false-positives mid-test ("Timed out while
        // executing Postgres query" → 500 → no redirect → waitForURL fails).
        // 90s absorbs the dev-load pathology. Only the test webServer gets
        // this; production stays at the 30s default.
        command: `POSTGRES_SYNC_TIMEOUT_MS=90000 PORT=${PORT} pnpm dev`,
        cwd: REPO_ROOT,
        url: BASE_URL,
        timeout: 240_000,
        reuseExistingServer: !process.env.CI,
        stdout: "pipe",
        stderr: "pipe",
      },

  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "tunnel-wiring",
      // Pure code-level OAS invariant check; no auth, no dev server needed.
      // Runs alongside setup so a regression on the cinatra_llm contract
      // fails fast.
      testMatch: /tunnel-wiring\.spec\.ts/,
    },
    {
      name: "preflight",
      testMatch: /preflight\.spec\.ts/,
      use: {
        ...desktopChrome,
        storageState: suitePath("agents-run", ".auth/state.json"),
      },
      dependencies: ["setup"],
    },
    {
      name: "agents-run",
      testMatch: /agents-run\.spec\.ts/,
      use: {
        ...desktopChrome,
        storageState: suitePath("agents-run", ".auth/state.json"),
      },
      dependencies: ["setup", "preflight"],
    },
    {
      name: "chat-discovery",
      // API-level chat-discoverability probes. POST /api/assistants/chat
      // (the unified AG-UI wire) with vague prompts, assert the chat picked
      // the right cinatra_<slug>.
      testMatch: /chat-discovery\.spec\.ts/,
      use: {
        ...desktopChrome,
        storageState: suitePath("agents-run", ".auth/state.json"),
      },
      dependencies: ["setup", "preflight"],
    },
    {
      name: "chat-mcp",
      // Chat-MCP end-to-end coverage. Send a specific prompt to
      // /api/assistants/chat (the unified AG-UI wire), resolve the spawned
      // runId (wire DATA_PART or DB fallback), drive the resulting run's
      // HITL gates via the UI helpers, and assert terminal status. Costs
      // about $0.05 per fixture in chat LLM tokens plus the agent's own
      // LLM cost; gated to manual / weekly runs.
      testMatch: /chat-mcp\.spec\.ts/,
      use: {
        ...desktopChrome,
        storageState: suitePath("agents-run", ".auth/state.json"),
      },
      dependencies: ["setup", "preflight"],
    },
    {
      // Prompt-window HITL smoke. Browser-driven: load /chat, type a
      // dispatch prompt into the contenteditable prompt, wait for the
      // inline AgenticRunPanel HITL gate, then DRIVE THE GATE BY TYPING
      // the answer into the prompt window (never the embedded Continue
      // button). Proves the prompt-window path end-to-end; the chat-mcp
      // project is API-driven and cannot reach the browser DOM path.
      // Costs about $0.05 per fixture in chat LLM tokens plus the agent's
      // own run cost; manual / weekly.
      name: "chat-prompt-hitl",
      testMatch: /chat-prompt-hitl\.spec\.ts/,
      use: {
        ...desktopChrome,
        storageState: suitePath("agents-run", ".auth/state.json"),
      },
      dependencies: ["setup", "preflight"],
    },
    {
      // Live /chat render-parity conformance (cinatra#1222, epic S6 — the
      // S2-enabled live-run target). Seeds a chat thread whose sole assistant
      // message is a corpus fixture through POST /api/assistants/threads, loads
      // /chat/<id>, and DOM-normalized-compares the rendered content against the
      // committed S3 packaged-renderer goldens. DETERMINISTIC — no LLM tokens
      // (seeded content, not a live turn), so unlike chat-mcp/chat-prompt-hitl
      // it is cost-free; still gated here (not per-PR) because it needs the real
      // authenticated app + persistence. Depends on `setup` (auth) ONLY — it
      // exercises no WayFlow/agent execution, so the 16-agent preflight is not a
      // precondition.
      name: "chat-render-parity",
      testMatch: /chat-render-parity\.spec\.ts/,
      use: {
        ...desktopChrome,
        storageState: suitePath("agents-run", ".auth/state.json"),
      },
      dependencies: ["setup"],
    },
  ],
});
