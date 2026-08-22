// @vitest-environment jsdom
/**
 * THE WIDGET'S EDIT ASSERTS THE RUN, NOT ONLY THE BUBBLE (cinatra#2823 S9j).
 *
 * WHAT WAS WRONG. The widget host never learned its turns' run identity at all.
 * `/chat` hands the turn driver a `noteRunId` port and keeps a run ledger for
 * the page (`turn-stream-registry.ts`); the shared column's widget driver passed
 * `updateMessages`, `setTypingIndicator`, `isWidgetRefreshTool` and
 * `onWidgetRefresh` — and no `noteRunId` — while the driver reports the server's
 * name for the turn on EVERY mode. So the truncation this leg added to the
 * widget could only ever post `removedMessageIds`.
 *
 * WHY THAT IS NOT ENOUGH, in the widget's own terms. A bubble id is minted in
 * the column, and the server's link from such an id to the run-bound row that
 * survives a truncation runs THROUGH the turn's mirror row — the row a whole-
 * transcript save writes. A widget save is best-effort and SILENT, so a turn
 * whose save never landed has no mirror row: its bubble id asserts a name the
 * server has never seen, the reconcile DELETE cannot reach the run-bound row,
 * and the removed turn folds back in above the edited prompt on the next reload.
 * The server allow-list entry for `removedRunIds` already existed on this route
 * (`src/lib/assistant-thread-http.ts`) with no producer on it.
 *
 * WHAT THIS MEASURES. The column keeps the SAME registry `/chat` keeps — not a
 * second mechanism — so the ledger, the instance token, the anchor filter, the
 * cap and the two-halves release rule are one implementation on both surfaces.
 * The arms below drive the real hook, and the embed arm drives the real payload
 * builder plus the wiring in the embed host itself.
 *
 * LOCAL NOTE: this suite runs under the chat package's own vitest config.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/widget-edit-removed-run-ids.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

type DriveRequest = {
  assistantId: string;
  ui: {
    updateMessages: (updater: (prev: UiMessage[]) => UiMessage[]) => void;
    noteRunId?: (runId: string) => void;
  };
};
const driveAssistantChatTurn = vi.fn<(req?: DriveRequest) => Promise<void>>(async () => undefined);

vi.mock("../ag-ui-chat-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ag-ui-chat-client")>();
  return {
    ...actual,
    driveAssistantChatTurn: (...a: unknown[]) => driveAssistantChatTurn(...(a as [])),
  };
});

import { useConversationColumnTurns } from "../conversation-column";
import { buildThreadWrite } from "../conversation-services";
import type { UiMessage } from "../types";

const msg = (id: string, role: "user" | "assistant"): UiMessage =>
  ({ id, role, content: id }) as UiMessage;

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const EMBED_SRC = readFileSync(
  path.join(REPO_ROOT, "src", "app", "embed", "assistant", "embed-assistant-client.tsx"),
  "utf8",
);

/** A turn that reports its run the way the real driver does — on the wire, as
 *  soon as `RUN_STARTED` carries it — and then reveals its bubble. */
function turnReporting(runId: string) {
  return async (req?: DriveRequest) => {
    req?.ui.noteRunId?.(runId);
    req?.ui.updateMessages((prev) => [
      ...prev,
      msg(req.assistantId, "assistant"),
    ]);
  };
}

function mountTurns(initialMessages: UiMessage[] = []) {
  return renderHook(() =>
    useConversationColumnTurns({ threadId: "t-widget", initialMessages }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  driveAssistantChatTurn.mockImplementation(async () => undefined);
});

describe("the widget column learns its turns' run identity", () => {
  it("hands the turn driver a noteRunId port", async () => {
    // THE ONE CALLBACK. The driver reports the server's own name for the turn on
    // every mode; a host that does not take it cannot name the turn afterwards.
    const { result } = mountTurns();
    await act(async () => {
      result.current.onSubmit("hello");
    });
    const req = driveAssistantChatTurn.mock.calls[0]?.[0];
    expect(
      typeof req?.ui.noteRunId,
      "the widget driver still passes no noteRunId — the column can never name a run",
    ).toBe("function");
  });

  it("asserts the RUN of a removed turn whose save never landed", async () => {
    // THE REGRESSION ARM, end to end through the hook. The turn ran and revealed;
    // no save has landed, so it has NO mirror row; the reader then edits the
    // prompt it answered. Its bubble id reaches nothing on the server — the run
    // is the only identity both sides hold.
    driveAssistantChatTurn.mockImplementation(turnReporting("run-widget-1"));
    const { result } = mountTurns();
    await act(async () => {
      result.current.onSubmit("what is the weather");
    });
    const [prompt, answer] = result.current.messages;
    expect(answer?.role).toBe("assistant");

    driveAssistantChatTurn.mockImplementation(async () => undefined);
    await act(async () => {
      result.current.onEditAndResend(prompt!.id, "what is the tide");
    });

    const peeked = result.current.peekRemovedMessageIds();
    expect(peeked.ids).toEqual([answer!.id]);
    expect(
      peeked.runIds,
      "the widget still posts the bubble id alone — the removed turn folds back in on reload",
    ).toEqual(["run-widget-1"]);
  });

  it("withholds the run of a turn whose prompt the edit KEPT", async () => {
    // The anchor filter, inherited rather than re-invented: a run id names the
    // run-bound row outright, so a turn the reader kept must never be offered.
    driveAssistantChatTurn.mockImplementation(turnReporting("run-kept"));
    const { result } = mountTurns();
    await act(async () => {
      result.current.onSubmit("first");
    });
    driveAssistantChatTurn.mockImplementation(turnReporting("run-removed"));
    await act(async () => {
      result.current.onSubmit("second");
    });
    const ids = result.current.messages.map((m) => m.id);
    expect(ids).toHaveLength(4);

    driveAssistantChatTurn.mockImplementation(async () => undefined);
    await act(async () => {
      result.current.onEditAndResend(ids[2]!, "second, rewritten");
    });
    expect(result.current.peekRemovedMessageIds().runIds).toEqual(["run-removed"]);
  });

  it("keeps the run assertion until a save CONFIRMS it, like the ids beside it", async () => {
    // A widget save is best-effort and silent. Draining the assertion at build
    // time loses it for good on a save that never landed.
    driveAssistantChatTurn.mockImplementation(turnReporting("run-1"));
    const { result } = mountTurns();
    await act(async () => {
      result.current.onSubmit("ask");
    });
    const promptId = result.current.messages[0]!.id;
    driveAssistantChatTurn.mockImplementation(async () => undefined);
    await act(async () => {
      result.current.onEditAndResend(promptId, "ask differently");
    });

    const save = result.current.peekRemovedMessageIds();
    expect(save.runIds).toEqual(["run-1"]);
    // Peeking does not consume it.
    expect(result.current.peekRemovedMessageIds().runIds).toEqual(["run-1"]);
    act(() => result.current.confirmRemovedMessageIds(save.saveToken));
    expect(result.current.peekRemovedMessageIds().runIds).toEqual([]);
  });

  it("survives the JSON round trip a host may put the save token through", async () => {
    driveAssistantChatTurn.mockImplementation(turnReporting("run-1"));
    const { result } = mountTurns();
    await act(async () => {
      result.current.onSubmit("ask");
    });
    const promptId = result.current.messages[0]!.id;
    driveAssistantChatTurn.mockImplementation(async () => undefined);
    await act(async () => {
      result.current.onEditAndResend(promptId, "ask differently");
    });
    const peeked = result.current.peekRemovedMessageIds();
    const wire: typeof peeked = JSON.parse(JSON.stringify(peeked));
    expect(wire.runIds).toEqual(["run-1"]);
    act(() => result.current.confirmRemovedMessageIds(wire.saveToken));
    expect(result.current.peekRemovedMessageIds().runIds).toEqual([]);
  });

  it("a landed save releases the ledger's run half — the mirror row takes over", async () => {
    // The registry's own release rule, driven from this column's save
    // confirmation. Without it the ledger would hold every run this panel ever
    // streamed until the cap evicted it.
    driveAssistantChatTurn.mockImplementation(turnReporting("run-1"));
    const { result } = mountTurns();
    await act(async () => {
      result.current.onSubmit("ask");
    });
    const saved = result.current.messages;
    const promptId = saved[0]!.id;
    // The host saves when the turn ends, and that save LANDS.
    const settleSave = result.current.peekRemovedMessageIds(saved);
    act(() => result.current.confirmRemovedMessageIds(settleSave.saveToken));

    driveAssistantChatTurn.mockImplementation(async () => undefined);
    await act(async () => {
      result.current.onEditAndResend(promptId, "ask differently");
    });
    // The turn HAS a mirror row now, so the ordinary key reaches it and the run
    // assertion is not owed.
    expect(result.current.peekRemovedMessageIds().runIds).toEqual([]);
    expect(result.current.peekRemovedMessageIds().ids).toEqual([saved[1]!.id]);
  });

  it("an edit that removes nothing asserts no run", async () => {
    driveAssistantChatTurn.mockImplementation(turnReporting("run-1"));
    const { result } = mountTurns([msg("u1", "user")]);
    await act(async () => {
      result.current.onEditAndResend("u1", "rewrite the only message");
    });
    expect(result.current.peekRemovedMessageIds().ids).toEqual([]);
  });
});

describe("the embed puts the run assertion on the wire", () => {
  const base = { threadId: "t-widget", messages: [msg("u1", "user")], createdAt: "2026-08-01T00:00:00.000Z" };

  it("buildThreadWrite carries removedRunIds when the column has some", () => {
    expect(buildThreadWrite({ ...base, removedRunIds: ["run-1"] }).removedRunIds).toEqual([
      "run-1",
    ]);
  });

  it("OMITS it when there is none — an ordinary save asserts nothing", () => {
    // The same separation the ids half rests on: every save posts the whole
    // transcript, so a save that simply never had an edit must not read as a
    // removal. Empty and absent are the same statement, and it is not made.
    expect(buildThreadWrite(base)).not.toHaveProperty("removedRunIds");
    expect(buildThreadWrite({ ...base, removedRunIds: [] })).not.toHaveProperty("removedRunIds");
  });

  it("the embed host really peeks the runs and posts them", () => {
    // The column can only assert what its host carries. This is the wiring, read
    // off the host that owns the save.
    expect(
      EMBED_SRC,
      "the embed still posts removedMessageIds alone",
    ).toMatch(/removedRunIds/);
    expect(EMBED_SRC).toMatch(/runIds:\s*removedRunIds/);
  });
});
