import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Enqueue-decision contract (cinatra#1367). The candidate selector runs
// against the EXACT payload shape the persistence chokepoint receives from
// the save route / chat actions / MCP handlers: a thread object with
// server-derived ownerUserId and a messages[] tail. The #1216 S2 cutover must
// keep these semantics at its replacement persistence path (see
// chat-capture-enqueue-hook.test.ts for the hook-presence tripwire).
// ---------------------------------------------------------------------------

const { enqueueBackgroundJobMock, readSkillAutosaveConfigMock } = vi.hoisted(() => ({
  enqueueBackgroundJobMock: vi.fn(async () => undefined),
  readSkillAutosaveConfigMock: vi.fn(() => ({
    enabled: true,
    userCanConfigure: false,
    userCanSeeIndicator: true,
  })),
}));

vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: enqueueBackgroundJobMock,
  BACKGROUND_JOB_NAMES: { CHAT_CAPTURE_DETECTION: "chat-capture-detection" },
}));
vi.mock("@/lib/skill-autosave", () => ({
  readSkillAutosaveConfig: readSkillAutosaveConfigMock,
}));

import { buildLegacyMirrorTurnId } from "@/lib/project-inheritance";
import {
  buildChatCaptureJobId,
  maybeEnqueueChatCaptureForThread,
  selectChatCaptureCandidate,
} from "../enqueue";

function userThread(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread-1",
    ownerUserId: "user-1",
    messages: [
      { id: "m1", role: "user", content: "hello" },
      { id: "m2", role: "assistant", content: "hi!" },
      { id: "m3", role: "user", content: "always answer in German" },
    ],
    ...overrides,
  };
}

describe("selectChatCaptureCandidate", () => {
  it("selects the latest user turn on a personally-owned thread, with the mirror's turn id", () => {
    const candidate = selectChatCaptureCandidate(userThread());
    expect(candidate).toEqual({
      threadId: "thread-1",
      turnId: buildLegacyMirrorTurnId("thread-1", "m3"),
      ownerUserId: "user-1",
    });
  });

  it("returns null for team-owned / unowned threads", () => {
    expect(
      selectChatCaptureCandidate(userThread({ ownerUserId: undefined, teamId: "team-9" })),
    ).toBeNull();
    expect(selectChatCaptureCandidate(userThread({ ownerUserId: undefined }))).toBeNull();
  });

  it("returns null when the latest message is an assistant turn", () => {
    const thread = userThread();
    (thread.messages as Array<Record<string, unknown>>).push({
      id: "m4",
      role: "assistant",
      content: "Verstanden!",
    });
    expect(selectChatCaptureCandidate(thread)).toBeNull();
  });

  it("returns null for user turns without a stable id or without content", () => {
    expect(
      selectChatCaptureCandidate(
        userThread({ messages: [{ role: "user", content: "always do X" }] }),
      ),
    ).toBeNull();
    expect(
      selectChatCaptureCandidate(userThread({ messages: [{ id: "m1", role: "user", content: "  " }] })),
    ).toBeNull();
  });
});

describe("buildChatCaptureJobId", () => {
  it("is deterministic and collision-safe across distinct turn ids", () => {
    const a = { threadId: "t", turnId: "legacy:1:t:a:b" };
    const b = { threadId: "t", turnId: "legacy:1:t:a_b" };
    expect(buildChatCaptureJobId(a)).toBe(buildChatCaptureJobId(a));
    expect(buildChatCaptureJobId(a)).not.toBe(buildChatCaptureJobId(b));
    expect(buildChatCaptureJobId(a)).toMatch(/^chat-capture-[0-9a-f]{32}$/);
  });
});

describe("maybeEnqueueChatCaptureForThread", () => {
  beforeEach(() => {
    enqueueBackgroundJobMock.mockClear();
    readSkillAutosaveConfigMock.mockClear();
    readSkillAutosaveConfigMock.mockImplementation(() => ({
      enabled: true,
      userCanConfigure: false,
      userCanSeeIndicator: true,
    }));
  });

  it("enqueues one detection job with the deterministic jobId + retry policy", async () => {
    await maybeEnqueueChatCaptureForThread(userThread());
    expect(enqueueBackgroundJobMock).toHaveBeenCalledTimes(1);
    const [name, payload, opts] = enqueueBackgroundJobMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(name).toBe("chat-capture-detection");
    expect(payload).toEqual({
      threadId: "thread-1",
      turnId: buildLegacyMirrorTurnId("thread-1", "m3"),
      ownerUserId: "user-1",
    });
    expect(opts.jobId).toBe(
      buildChatCaptureJobId({
        threadId: "thread-1",
        turnId: buildLegacyMirrorTurnId("thread-1", "m3"),
      }),
    );
    expect(opts.attempts).toBe(3);
  });

  it("does not enqueue while the master switch is off", async () => {
    readSkillAutosaveConfigMock.mockImplementation(() => ({
      enabled: false,
      userCanConfigure: false,
      userCanSeeIndicator: true,
    }));
    await maybeEnqueueChatCaptureForThread(userThread());
    expect(enqueueBackgroundJobMock).not.toHaveBeenCalled();
  });

  it("does not enqueue for non-candidates (team thread / assistant tail)", async () => {
    await maybeEnqueueChatCaptureForThread(userThread({ ownerUserId: undefined, teamId: "t9" }));
    const thread = userThread();
    (thread.messages as Array<Record<string, unknown>>).push({
      id: "m4",
      role: "assistant",
      content: "ok",
    });
    await maybeEnqueueChatCaptureForThread(thread);
    expect(enqueueBackgroundJobMock).not.toHaveBeenCalled();
  });

  it("degrades to a no-op when the queue is unavailable (thread persist unaffected)", async () => {
    enqueueBackgroundJobMock.mockRejectedValueOnce(new Error("redis down"));
    await expect(maybeEnqueueChatCaptureForThread(userThread())).resolves.toBeUndefined();
  });

  it("degrades to a no-op when the config read throws", async () => {
    readSkillAutosaveConfigMock.mockImplementation(() => {
      throw new Error("db down");
    });
    await maybeEnqueueChatCaptureForThread(userThread());
    expect(enqueueBackgroundJobMock).not.toHaveBeenCalled();
  });
});
