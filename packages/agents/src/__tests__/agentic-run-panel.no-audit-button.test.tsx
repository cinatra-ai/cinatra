// @vitest-environment jsdom
/**
 * AgenticRunPanel must not contain the standalone Audit button.
 *
 * The panel must not mount a HitlAudit button or call
 * getAuditAvailabilityAction. Audit visibility is driven by the
 * auditor-agent flow gate, so the button and import must be physically gone
 * from the panel source.
 *
 * Two assertions:
 *  1. Source-level: grep agentic-run-panel.tsx for `getAuditAvailabilityAction`
 *     symbol - must be absent (no behind-flag holdover allowed).
 *  2. DOM-level: rendering the panel under audit-eligible approval conditions
 *     exposes no button with name /audit/i.
 *
 * Fails while agentic-run-panel.tsx still imports getAuditAvailabilityAction.
 *
 * Run: cd packages/agent-builder && pnpm exec vitest run src/__tests__/agentic-run-panel.no-audit-button.test.tsx
 */
import * as fs from "node:fs";
import * as path from "node:path";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const PANEL_PATH = path.resolve(
  __dirname,
  "../../src/agentic-run-panel.tsx",
);

vi.mock("lucide-react", () => {
  // Vitest/Vite verifies named-export presence at module load time, so a bare
  // Proxy fails for transitive `import { Circle, ... }` statements pulled in
  // via orchestrator-sub-agent-node.tsx and friends. Use a single-keyed Proxy
  // with an explicit named-export surface so analyser sees the keys and
  // runtime falls through to StubIcon for anything else.
  const StubIcon: React.FC = () => null;
  const named = new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => [
      "Circle",
      "CircleDot",
      "Loader2",
      "CheckCircle2",
      "XCircle",
      "default",
    ],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
  return named;
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Server-actions stub - keep export surface minimal; test asserts no Audit
// button rendered, not full panel behavior.
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  getSkillsForAgentAction: vi.fn(async () => []),
  // NOTE: getAuditAvailabilityAction intentionally NOT exported. If panel
  // still imports it, vitest will throw at module load - that is part of the
  // failure signal.
}));

// Mock `../a2a-actions` because polling and transitive server-action work
// is out of scope for this test (it asserts only DOM-level absence of the
// Audit button). AgenticRunPanel sets up a `window.setInterval` poll that
// calls `getAgentBuilderTask` whenever it mounts with `pending_approval`
// or a live status; the unresolved promise lets the React effect fire its
// first tick without dragging real I/O into render time. Has no timer or
// I/O handle, so it cleans up cleanly with the rest of the component.
vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(() => new Promise<never>(() => {})),
  sendAgentBuilderMessage: vi.fn(async () => ({})),
}));

describe("AgenticRunPanel - no standalone Audit button", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("agentic-run-panel.tsx source contains no `getAuditAvailabilityAction` symbol", () => {
    const src = fs.readFileSync(PANEL_PATH, "utf8");
    expect(src.includes("getAuditAvailabilityAction")).toBe(false);
  });

  it("agentic-run-panel.tsx source contains no `HitlAudit` component import or mount", () => {
    const src = fs.readFileSync(PANEL_PATH, "utf8");
    // Match either an import-from line or a JSX usage `<HitlAudit`.
    const importRe = /from\s+["']\.\/hitl-audit["']/;
    const mountRe = /<HitlAudit\b/;
    expect(importRe.test(src)).toBe(false);
    expect(mountRe.test(src)).toBe(false);
  });

  // Per-test timeout bump as defense-in-depth alongside the polling stub.
  // The default 5s is fine in isolation but tight under full-suite CPU
  // contention (dynamic import + first React render of a transitively-heavy
  // component). 30s leaves comfortable headroom without making real hangs
  // expensive to discover.
  it("rendered panel exposes no role=button matching /audit/i", { timeout: 30000 }, async () => {
    // Dynamic import after mocks are installed.
    const mod = (await import("../agentic-run-panel")) as {
      AgenticRunPanel?: React.ComponentType<Record<string, unknown>>;
    };
    if (!mod.AgenticRunPanel) {
      // Module exists but does not export AgenticRunPanel - fail loudly.
      throw new Error("AgenticRunPanel export missing");
    }
    // Minimal props bag - most fields are unused for this assertion.
    render(
      <mod.AgenticRunPanel
        runId="r1"
        taskId="t1"
        agentPackageName="@cinatra-ai/email-drafting-agent"
        // Audit-eligible approval conditions.
        initialStatus="pending_approval"
        initialError={null}
        initialMessages={[]}
        agUiEnabled={false}
        traceId={null}
        inputParams={{}}
        templateId="tpl1"
        initialStreamedText=""
      />,
    );
    expect(screen.queryByRole("button", { name: /audit/i })).toBeNull();
  });
});
