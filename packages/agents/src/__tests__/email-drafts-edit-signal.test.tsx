// @vitest-environment jsdom
/**
 * EmailDraftsReviewRenderer must emit `edited` boolean.
 *
 * The renderer maintains per-draft edit state and propagates an `edited` flag
 * to the WayFlow payload. The parent flow's predicate node needs that flag to
 * gate the auditor-agent branch.
 *
 * Asserts:
 *  - With no edits: most-recent onChange payload has edited:false, editedIds:[]
 *  - After typing in draft-1.subject: onChange payload has edited:true, editedIds:["draft-1"]
 *  - userResponse JSON also embeds the edited fields (predicate reads userResponse).
 *
 * The payload must include { campaignId, approvedDraftIds, userResponse, edited, editedIds }.
 *
 * Run: cd packages/agent-builder && pnpm exec vitest run src/__tests__/email-drafts-edit-signal.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// Vitest/Vite verifies named-export presence at module load time, so a bare
// Proxy (without ownKeys/getOwnPropertyDescriptor traps) fails for transitive
// `import { Circle, ... }` statements pulled in via orchestrator-sub-agent-node
// and friends. Use a Proxy with the canonical four-trap surface so analyser
// sees the named exports and runtime falls through to StubIcon for anything
// else. Mirrors the pattern in agentic-run-panel.no-audit-button.test.tsx.
vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
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
      "CheckCircle2",
      "XCircle",
      "AlertCircle",
      "Loader2",
      "Pencil",
      "Check",
      "X",
      "ExternalLink",
      "ChevronDown",
      "ChevronRight",
      "ChevronLeft",
      "ChevronUp",
      "ArrowRight",
      "Info",
      "Pause",
      "default",
    ],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Stub the campaign drafts MCP load — preloaded path is used (`value.drafts`).
// Mock surface must cover what the renderer needs (`callMcpPrimitive`) AND
// what transitive deps load at module init (objects-client builds an
// in-process transport from `createInProcessPrimitiveTransport`, and resolves
// actor context via `invokePrimitive`).
vi.mock("@cinatra-ai/mcp-client", () => ({
  callMcpPrimitive: vi.fn(async () => ({ drafts: [] })),
  createInProcessPrimitiveTransport: vi.fn(() => ({
    request: vi.fn(),
  })),
  invokePrimitive: vi.fn(async () => ({})),
  PrimitiveInvocationError: class extends Error {},
}));

import { EmailDraftsReviewRenderer } from "../email-drafts-review-renderer";

const PRELOADED_DRAFTS = [
  {
    id: "draft-1",
    subject: "Original Subject 1",
    body: "Original Body 1",
    recipientEmail: "a@example.com",
    recipientName: "A",
  },
  {
    id: "draft-2",
    subject: "Original Subject 2",
    body: "Original Body 2",
    recipientEmail: "b@example.com",
    recipientName: "B",
  },
];

function lastPayload(onChange: ReturnType<typeof vi.fn>): {
  edited?: boolean;
  editedIds?: string[];
  userResponse?: string;
} {
  const calls = onChange.mock.calls;
  if (calls.length === 0) return {};
  return calls[calls.length - 1]?.[0] as Record<string, unknown>;
}

describe("EmailDraftsReviewRenderer edit-signal", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("with no edits, payload has edited:false and editedIds:[]", async () => {
    const onChange = vi.fn();
    render(
      <EmailDraftsReviewRenderer
        fieldName="draftsApproval"
        value={{ campaignId: "c1", drafts: PRELOADED_DRAFTS }}
        onChange={onChange}
        disabled={false}
        context={{ runId: "r1", allFieldValues: {} } as never}
        schema={{}}
      />,
    );
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const p = lastPayload(onChange);
    expect(p.edited).toBe(false);
    expect(p.editedIds).toEqual([]);
    // userResponse JSON must embed the edited flag for the parent predicate.
    const ur = JSON.parse(p.userResponse ?? "{}");
    expect(ur.edited).toBe(false);
  });

  it("after typing in draft-1 subject, payload has edited:true and editedIds:['draft-1']", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <EmailDraftsReviewRenderer
        fieldName="draftsApproval"
        value={{ campaignId: "c1", drafts: PRELOADED_DRAFTS }}
        onChange={onChange}
        disabled={false}
        context={{ runId: "r1", allFieldValues: {} } as never}
        schema={{}}
      />,
    );
    await waitFor(() => expect(onChange).toHaveBeenCalled());

    // Find the first subject input and change it.
    const inputs = container.querySelectorAll("input");
    expect(inputs.length).toBeGreaterThan(0);
    fireEvent.change(inputs[0]!, { target: { value: "EDITED Subject 1" } });

    await waitFor(() => {
      const p = lastPayload(onChange);
      expect(p.edited).toBe(true);
      expect(p.editedIds).toEqual(["draft-1"]);
    });

    const p = lastPayload(onChange);
    const ur = JSON.parse(p.userResponse ?? "{}");
    expect(ur.edited).toBe(true);
    expect(ur.editedIds).toEqual(["draft-1"]);
  });
});
