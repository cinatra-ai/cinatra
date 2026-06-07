// @vitest-environment jsdom
/**
 * RED-then-GREEN tests for HitlConversationPanel.
 *
 * Effect-dependent assertions (data-conv-open, bubble visibility) are wrapped
 * in `waitFor(...)` per peer-review fix — `useEffect` runs AFTER React commit,
 * so a synchronous assertion immediately after `rerender()` is racy.
 *
 *   pnpm --filter @cinatra/agent-builder exec vitest run \
 *     src/__tests__/hitl-conversation-panel.test.tsx
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const onSubmitMock = vi.fn(async (_p: string, _a?: unknown) => {});

// Capture PromptField props per render so paperclip tests can drive
// `onAttachmentsSelected` AND assert its presence/absence based on
// `enableAttachments`.
type PromptFieldPropsCapture = {
  onSubmit: (s: string) => Promise<void>;
  onAttachmentsSelected?: (files: File[]) => void;
};
let lastPromptFieldProps: PromptFieldPropsCapture | null = null;

vi.mock("@cinatra-ai/sdk-ui", () => ({
  // Forward-ref shim so the component's `useRef<PromptFieldHandle>(null)` works.
  PromptField: React.forwardRef<unknown, PromptFieldPropsCapture>(
    (props, _ref) => {
      lastPromptFieldProps = props;
      return React.createElement(
        "button",
        {
          type: "button",
          onClick: () => void props.onSubmit("test prompt"),
          "data-testid": "prompt-field",
        },
        "PromptField",
      );
    },
  ),
  LoadingSpinner: () => null,
}));

import { HitlConversationPanel } from "../hitl-conversation-panel";

describe("HitlConversationPanel", () => {
  afterEach(() => {
    cleanup();
    onSubmitMock.mockClear();
  });

  it("returns null when visible=false", () => {
    const { container } = render(
      <HitlConversationPanel
        portalTarget={document.body}
        visible={false}
        conversation={[]}
        promptPending={false}
        storageKey="k"
        onSubmit={onSubmitMock}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("returns null when portalTarget is null", () => {
    const { container } = render(
      <HitlConversationPanel
        portalTarget={null}
        visible={true}
        conversation={[]}
        promptPending={false}
        storageKey="k"
        onSubmit={onSubmitMock}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders user + assistant bubbles when visible and conversation has entries", async () => {
    render(
      <HitlConversationPanel
        portalTarget={document.body}
        visible={true}
        conversation={[
          { id: 1, role: "user", content: "draft me one" },
          { id: 2, role: "assistant", content: "Subject: Hi" },
        ]}
        promptPending={false}
        storageKey="k"
        onSubmit={onSubmitMock}
      />,
    );
    // The auto-open useEffect runs after commit — wait for it.
    await waitFor(() => {
      expect(screen.queryByText("draft me one")).not.toBeNull();
      expect(screen.queryByText("Subject: Hi")).not.toBeNull();
    });
  });

  it("shows Thinking… when promptPending=true", async () => {
    render(
      <HitlConversationPanel
        portalTarget={document.body}
        visible={true}
        conversation={[{ id: 1, role: "user", content: "go" }]}
        promptPending={true}
        storageKey="k"
        onSubmit={onSubmitMock}
      />,
    );
    // Auto-open effect must fire before the Thinking dot is in the DOM tree.
    await waitFor(() => {
      expect(screen.queryByText(/Thinking/i)).not.toBeNull();
    });
  });

  it("calls onSubmit when the PromptField submits", async () => {
    render(
      <HitlConversationPanel
        portalTarget={document.body}
        visible={true}
        conversation={[]}
        promptPending={false}
        storageKey="k"
        onSubmit={onSubmitMock}
      />,
    );
    const btn = screen.getByTestId("prompt-field");
    btn.click();
    // onSubmit is awaited inside the component; flush microtasks.
    await waitFor(() => {
      expect(onSubmitMock).toHaveBeenCalledWith("test prompt");
    });
  });

  it("closes the conversation overlay when resetSignal changes (parity with agentic-run-panel.tsx:329)", async () => {
    const conversation = [{ id: 1, role: "user" as const, content: "hi" }];
    const { rerender } = render(
      <HitlConversationPanel
        portalTarget={document.body}
        visible={true}
        conversation={conversation}
        promptPending={false}
        storageKey="k"
        onSubmit={onSubmitMock}
        resetSignal="renderer-A"
      />,
    );
    // First render: wait for the auto-open effect to fire (conversation.length > 0).
    await waitFor(() => {
      expect(screen.queryByText("hi")).not.toBeNull();
    });
    // Verify the overlay is open via the data attribute (effect-driven state).
    await waitFor(() => {
      expect(
        document.querySelector("[data-conv-open]")?.getAttribute("data-conv-open"),
      ).toBe("true");
    });

    rerender(
      <HitlConversationPanel
        portalTarget={document.body}
        visible={true}
        conversation={conversation}
        promptPending={false}
        storageKey="k"
        onSubmit={onSubmitMock}
        resetSignal="renderer-B"
      />,
    );
    // The resetSignal effect fires after commit and calls setConvOpen(false).
    // Wrapped in waitFor to flush the effect microtask.
    await waitFor(() => {
      expect(
        document.querySelector("[data-conv-open]")?.getAttribute("data-conv-open"),
      ).toBe("false");
    });
  });
});

// ---------------------------------------------------------------------------
// HITL paperclip wiring. Mirrors the proven chat-page handler at
// packages/chat/src/chat-page.tsx:1762.
// ---------------------------------------------------------------------------

describe("HitlConversationPanel paperclip + attachments", () => {
  afterEach(() => {
    cleanup();
    onSubmitMock.mockReset();
    onSubmitMock.mockImplementation(async () => {});
    lastPromptFieldProps = null;
    vi.unstubAllGlobals();
  });

  it("`enableAttachments` undefined → paperclip HIDDEN (onAttachmentsSelected NOT passed to PromptField; legacy byte-identical)", () => {
    render(
      <HitlConversationPanel
        portalTarget={document.body}
        visible={true}
        conversation={[]}
        promptPending={false}
        storageKey="k"
        onSubmit={onSubmitMock}
      />,
    );
    expect(lastPromptFieldProps).not.toBeNull();
    expect(lastPromptFieldProps?.onAttachmentsSelected).toBeUndefined();
  });

  it("`enableAttachments: true` → onAttachmentsSelected IS passed", () => {
    render(
      <HitlConversationPanel
        portalTarget={document.body}
        visible={true}
        conversation={[]}
        promptPending={false}
        storageKey="k"
        onSubmit={onSubmitMock}
        enableAttachments={true}
      />,
    );
    expect(typeof lastPromptFieldProps?.onAttachmentsSelected).toBe("function");
  });

  it("file selection POSTs /api/artifacts/upload with enriched headers; on success captures the ref + enriches filename/title/size; submit flushes them as the 2nd onSubmit arg", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        ref: {
          artifactId: "art-1",
          representationRevisionId: "rep-1",
          digest: "sha256:abc",
          mime: "application/pdf",
          originKind: "upload",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <HitlConversationPanel
        portalTarget={document.body}
        visible={true}
        conversation={[]}
        promptPending={false}
        storageKey="k"
        onSubmit={onSubmitMock}
        enableAttachments={true}
      />,
    );
    const file = new File([new Uint8Array([1, 2, 3])], "deck.pdf", {
      type: "application/pdf",
    });
    // `act` flushes the React state update from `setPendingAttachments`
    // BEFORE the next click — without it the re-render is still
    // pending when the click fires and the click sees the stale
    // closure (empty pendingAttachments).
    await act(async () => {
      await lastPromptFieldProps!.onAttachmentsSelected!([file]);
    });

    // Upload call was made with the chat-page-equivalent headers.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: unknown },
    ];
    expect(url).toBe("/api/artifacts/upload");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/pdf");
    expect(init.headers["X-Artifact-Filename"]).toBe("deck.pdf");
    expect(init.headers["X-Artifact-Title"]).toBe("deck.pdf");

    // The bare ref MUST be enriched with filename/title/size; otherwise
    // providerUpload falls back to artifactId UUID and the file-extension
    // is lost.
    const promptField = screen.getByTestId("prompt-field");
    promptField.click();
    await waitFor(() => {
      expect(onSubmitMock).toHaveBeenCalledTimes(1);
    });
    const [prompt, attachments] = onSubmitMock.mock.calls[0] as [
      string,
      unknown,
    ];
    expect(prompt).toBe("test prompt");
    expect(attachments).toEqual([
      {
        artifactId: "art-1",
        representationRevisionId: "rep-1",
        digest: "sha256:abc",
        mime: "application/pdf",
        originKind: "upload",
        filename: "deck.pdf",
        title: "deck.pdf",
        size: 3,
      },
    ]);
  });

  it("submit with NO pending attachments → onSubmit called with EXACTLY ONE arg (back-compat single-arg invariant)", async () => {
    render(
      <HitlConversationPanel
        portalTarget={document.body}
        visible={true}
        conversation={[]}
        promptPending={false}
        storageKey="k"
        onSubmit={onSubmitMock}
        enableAttachments={true}
      />,
    );
    screen.getByTestId("prompt-field").click();
    await waitFor(() => {
      expect(onSubmitMock).toHaveBeenCalledTimes(1);
    });
    // True byte-identical legacy: SINGLE-arg invocation when no
    // attachments. Asserting `arguments.length === 1` (not
    // `args[1] === undefined`) — a 2-arg call with `undefined` would
    // break existing callers/tests using `toHaveBeenCalledWith(prompt)`.
    expect(onSubmitMock.mock.calls[0]).toEqual(["test prompt"]);
    expect(onSubmitMock.mock.calls[0].length).toBe(1);
  });

  it("network error during upload is SWALLOWED (no throw; submit still works)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("boom"));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <HitlConversationPanel
        portalTarget={document.body}
        visible={true}
        conversation={[]}
        promptPending={false}
        storageKey="k"
        onSubmit={onSubmitMock}
        enableAttachments={true}
      />,
    );
    const file = new File([new Uint8Array([1])], "x.pdf", {
      type: "application/pdf",
    });
    await act(async () => {
      await expect(
        lastPromptFieldProps!.onAttachmentsSelected!([file]),
      ).resolves.toBeUndefined();
    });
    screen.getByTestId("prompt-field").click();
    await waitFor(() => {
      expect(onSubmitMock).toHaveBeenCalledTimes(1);
    });
    // Failed upload ⇒ no ref captured ⇒ submit is the single-arg
    // legacy invocation, not a 2-arg with undefined.
    expect(onSubmitMock.mock.calls[0]).toEqual(["test prompt"]);
    expect(onSubmitMock.mock.calls[0].length).toBe(1);
  });
});
