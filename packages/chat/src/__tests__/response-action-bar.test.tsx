// @vitest-environment jsdom

// cinatra#2593 — the whole-response action bar (Copy response / Try again)
// was only mounted inline in the ChatGPT-mode branch of
// chat-messages-view.tsx; the Slack-mode (multi-participant) branch never
// rendered it, so response-level actions vanished depending on which
// renderer a thread used, even though per-block actions (code/table copy)
// kept showing. Extracted into `ResponseActionBar` and mounted by BOTH
// branches. This test mounts the real, shared component and pins its
// behavior directly — the two call sites in chat-messages-view.tsx now pass
// it the identical props, so this is the single source of truth for the
// row's presence/visibility rules.
//
// Try again stays Slack-suppressed (codex round-1 convergence catch): Slack
// mode allows CONCURRENT streams (chat-page.tsx `editAndResend`), so a later
// user turn can be appended to `messages` before an earlier turn's assistant
// response finishes streaming — order no longer strictly alternates
// user/assistant. The nearest-preceding-user lookup Try again relies on is
// only safe when it does. `onEditAndResend` is DESTRUCTIVE (truncates the
// shared thread at the picked message), so guessing wrong in a
// multi-participant thread is a real data-loss hazard, not a cosmetic one.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ResponseActionBar } from "../response-action-bar";
import type { UiMessage } from "../types";

function thread(): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "Summarize the report" },
    { id: "a1", role: "assistant", content: "Here is the summary." },
  ];
}

afterEach(cleanup);

describe("ResponseActionBar (cinatra#2593) — ChatGPT mode (isSlackMode=false)", () => {
  it("renders Copy response + Try again for a completed assistant turn with a prior user turn", () => {
    const messages = thread();
    render(
      <ResponseActionBar
        message={messages[1]}
        messages={messages}
        hasActiveStream={false}
        isSlackMode={false}
        isStreaming={() => false}
        onEditAndResend={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Copy response" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  });

  it("renders nothing while the turn is still streaming", () => {
    const messages = thread();
    const { container } = render(
      <ResponseActionBar
        message={messages[1]}
        messages={messages}
        hasActiveStream={true}
        isSlackMode={false}
        isStreaming={(id) => id === "a1"}
        onEditAndResend={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("omits Try again (keeps Copy) when there is no earlier user turn to resend", () => {
    const soloAssistant: UiMessage[] = [{ id: "a1", role: "assistant", content: "Hello." }];
    render(
      <ResponseActionBar
        message={soloAssistant[0]}
        messages={soloAssistant}
        hasActiveStream={false}
        isSlackMode={false}
        isStreaming={() => false}
        onEditAndResend={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Copy response" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("Copy writes the message content to the clipboard; Try again resends the prior user turn", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const onEditAndResend = vi.fn();
    const messages = thread();

    render(
      <ResponseActionBar
        message={messages[1]}
        messages={messages}
        hasActiveStream={false}
        isSlackMode={false}
        isStreaming={() => false}
        onEditAndResend={onEditAndResend}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    expect(writeText).toHaveBeenCalledWith("Here is the summary.");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onEditAndResend).toHaveBeenCalledWith("u1", "Summarize the report");
  });

  it("disables Try again (but keeps Copy enabled) while another stream is active", () => {
    const messages = thread();
    render(
      <ResponseActionBar
        message={messages[1]}
        messages={messages}
        hasActiveStream={true}
        isSlackMode={false}
        isStreaming={() => false}
        onEditAndResend={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Copy response" })).not.toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Try again" })).toHaveProperty("disabled", true);
  });
});

describe("ResponseActionBar (cinatra#2593) — Slack / multi-participant mode (isSlackMode=true)", () => {
  it("renders Copy response — the row is no longer missing entirely, unlike before this fix", () => {
    const messages = thread();
    render(
      <ResponseActionBar
        message={messages[1]}
        messages={messages}
        hasActiveStream={false}
        isSlackMode={true}
        isStreaming={() => false}
        onEditAndResend={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Copy response" })).toBeDefined();
  });

  it("never renders Try again in Slack mode, even with a well-formed prior user turn — concurrent streams make the nearest-preceding-user guess unsafe (destructive resend)", () => {
    const messages = thread();
    render(
      <ResponseActionBar
        message={messages[1]}
        messages={messages}
        hasActiveStream={false}
        isSlackMode={true}
        isStreaming={() => false}
        onEditAndResend={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("still renders nothing while the turn is streaming", () => {
    const messages = thread();
    const { container } = render(
      <ResponseActionBar
        message={messages[1]}
        messages={messages}
        hasActiveStream={true}
        isSlackMode={true}
        isStreaming={(id) => id === "a1"}
        onEditAndResend={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("Copy still writes the message content to the clipboard in Slack mode", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const messages = thread();

    render(
      <ResponseActionBar
        message={messages[1]}
        messages={messages}
        hasActiveStream={false}
        isSlackMode={true}
        isStreaming={() => false}
        onEditAndResend={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    expect(writeText).toHaveBeenCalledWith("Here is the summary.");
  });
});
