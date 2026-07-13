import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Pipeline contract tests (cinatra#1367):
//   - ordinary turns cost ZERO classifier calls (pre-filter proof);
//   - toggle-off stops future captures (and deletes nothing);
//   - seeded secrets never reach classifier/distiller inputs;
//   - duplicate-capture race: concurrent flagged turns are per-user
//     SERIALIZED onto one deterministic skill (no interleaved read-amend-write);
//   - terminal ledger rows make re-deliveries no-ops;
//   - failures mark the row 'error' and rethrow for BullMQ retry.
// ---------------------------------------------------------------------------

const {
  claimMock,
  reserveMock,
  finalizeMock,
  readThreadMock,
  readConfigMock,
  userEnabledMock,
  classifyMock,
  captureSkillMock,
  readActiveRevisionMock,
  logAuditEventMock,
} = vi.hoisted(() => ({
  claimMock: vi.fn(() => true),
  reserveMock: vi.fn(() => true),
  finalizeMock: vi.fn(),
  readThreadMock: vi.fn(),
  readConfigMock: vi.fn(() => ({
    enabled: true,
    userCanConfigure: true,
    userCanSeeIndicator: true,
  })),
  userEnabledMock: vi.fn(() => true),
  classifyMock: vi.fn(
    async (_redacted?: string): Promise<{ durable: boolean; instruction?: string }> => ({
      durable: true,
      instruction: "Always answer in German.",
    }),
  ),
  captureSkillMock: vi.fn(async (_input?: unknown) => ({
    id: "custom:personal-skills:chat-capture-abc",
  })),
  readActiveRevisionMock: vi.fn(() => ({
    activeRevisionId: "rev-1",
    contentDigest: null,
    content: null,
  })),
  logAuditEventMock: vi.fn(async () => undefined),
}));

vi.mock("../ledger", () => ({
  claimChatCaptureTurn: claimMock,
  reserveChatCaptureClassifierQuota: reserveMock,
  finalizeChatCaptureTurn: finalizeMock,
}));
vi.mock("../classifier", () => ({
  classifyChatCaptureMessage: classifyMock,
}));
vi.mock("@/lib/chat-thread-store", () => ({
  readChatThreadPayloadById: readThreadMock,
}));
vi.mock("@/lib/skill-autosave", () => ({
  readSkillAutosaveConfig: readConfigMock,
  isChatCaptureEnabledForUser: userEnabledMock,
}));
vi.mock("@cinatra-ai/skills", () => ({
  createOrUpdateChatCaptureSkill: captureSkillMock,
}));
vi.mock("@/lib/skill-lifecycle-store", () => ({
  readSkillActiveRevisionFromDatabase: readActiveRevisionMock,
}));
vi.mock("@/lib/authz/audit", () => ({
  logAuditEvent: logAuditEventMock,
}));

import { buildLegacyMirrorTurnId } from "@/lib/project-inheritance";
import { runChatCaptureDetectionJob } from "../pipeline";

const THREAD_ID = "thread-1";
const MSG_ID = "m3";
const TURN_ID = buildLegacyMirrorTurnId(THREAD_ID, MSG_ID);
const OWNER = "user-1";

function payload(overrides: Partial<{ threadId: string; turnId: string; ownerUserId: string }> = {}) {
  return { threadId: THREAD_ID, turnId: TURN_ID, ownerUserId: OWNER, ...overrides };
}

function seedThread(content: string, overrides: Record<string, unknown> = {}) {
  readThreadMock.mockReturnValue({
    id: THREAD_ID,
    ownerUserId: OWNER,
    messages: [
      { id: "m1", role: "user", content: "hi" },
      { id: "m2", role: "assistant", content: "hello" },
      { id: MSG_ID, role: "user", content },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  claimMock.mockReturnValue(true);
  reserveMock.mockReturnValue(true);
  readConfigMock.mockReturnValue({
    enabled: true,
    userCanConfigure: true,
    userCanSeeIndicator: true,
  });
  userEnabledMock.mockReturnValue(true);
  classifyMock.mockResolvedValue({ durable: true, instruction: "Always answer in German." });
  captureSkillMock.mockResolvedValue({ id: "custom:personal-skills:chat-capture-abc" });
  readActiveRevisionMock.mockReturnValue({
    activeRevisionId: "rev-1",
    contentDigest: null,
    content: null,
  });
  logAuditEventMock.mockResolvedValue(undefined);
});

describe("runChatCaptureDetectionJob", () => {
  it("captures a flagged turn: ledger 'captured' with skill+revision, audit event emitted", async () => {
    seedThread("always answer in German please");
    await runChatCaptureDetectionJob(payload(), "job-1");
    expect(captureSkillMock).toHaveBeenCalledTimes(1);
    expect(finalizeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "captured",
        skillId: "custom:personal-skills:chat-capture-abc",
        revisionId: "rev-1",
      }),
    );
    expect(logAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "skills.chat_capture.captured",
        resourceId: "custom:personal-skills:chat-capture-abc",
      }),
    );
  });

  it("ordinary turns end at the pre-filter with ZERO classifier calls", async () => {
    seedThread("what's the weather like in Berlin?");
    await runChatCaptureDetectionJob(payload(), "job-1");
    expect(classifyMock).not.toHaveBeenCalled();
    expect(reserveMock).not.toHaveBeenCalled();
    expect(captureSkillMock).not.toHaveBeenCalled();
    expect(finalizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped_prefilter" }),
    );
  });

  it("terminal ledger row ⇒ re-delivery is a complete no-op", async () => {
    claimMock.mockReturnValue(false);
    await runChatCaptureDetectionJob(payload(), "job-1");
    expect(readThreadMock).not.toHaveBeenCalled();
    expect(classifyMock).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("per-user toggle off ⇒ skipped_disabled, nothing read, nothing deleted", async () => {
    userEnabledMock.mockReturnValue(false);
    await runChatCaptureDetectionJob(payload(), "job-1");
    expect(finalizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped_disabled" }),
    );
    expect(readThreadMock).not.toHaveBeenCalled();
    expect(captureSkillMock).not.toHaveBeenCalled();
  });

  it("quota exhausted ⇒ skipped_rate_capped before any classifier call", async () => {
    seedThread("never use emojis");
    reserveMock.mockReturnValue(false);
    await runChatCaptureDetectionJob(payload(), "job-1");
    expect(classifyMock).not.toHaveBeenCalled();
    expect(finalizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped_rate_capped" }),
    );
  });

  it("thread deleted since enqueue ⇒ skipped_missing (abandonment is harmless)", async () => {
    readThreadMock.mockReturnValue(null);
    await runChatCaptureDetectionJob(payload(), "job-1");
    expect(finalizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped_missing", detail: "thread-missing" }),
    );
  });

  it("seeded secrets never reach classifier OR distiller inputs", async () => {
    const secret = "ghp_ABCdef123456789012345678901234567890";
    seedThread(`always authenticate with ${secret} when you push`);
    // Classifier echoes its (already-redacted) input as the instruction, so
    // the distiller-arm assertion covers the classifier→distiller handoff.
    classifyMock.mockImplementation(async (redacted?: string) => ({
      durable: true,
      instruction: redacted ?? "",
    }));
    await runChatCaptureDetectionJob(payload(), "job-1");
    expect(classifyMock).toHaveBeenCalledTimes(1);
    const classifierInput = String(classifyMock.mock.calls[0]?.[0] ?? "");
    expect(classifierInput).not.toContain(secret);
    expect(classifierInput).toContain("[REDACTED]");
    const captureArgs = captureSkillMock.mock.calls[0]?.[0] as { instruction: string };
    expect(captureArgs.instruction).not.toContain(secret);
  });

  it("not-durable classification ⇒ skipped_classifier, no distillation", async () => {
    seedThread("always was a strange word, don't you think?");
    classifyMock.mockResolvedValue({ durable: false });
    await runChatCaptureDetectionJob(payload(), "job-1");
    expect(captureSkillMock).not.toHaveBeenCalled();
    expect(finalizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped_classifier" }),
    );
  });

  it("RACE: concurrent flagged turns for one user serialize the distill+upsert (no interleaving)", async () => {
    seedThread("always answer in German");
    let inFlight = 0;
    let maxInFlight = 0;
    captureSkillMock.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return { id: "custom:personal-skills:chat-capture-abc" };
    });
    const turnA = payload();
    const turnB = payload({ turnId: buildLegacyMirrorTurnId(THREAD_ID, "m1") });
    // m1 must also pass the pre-filter for this test — reseed with two
    // flagged user turns.
    readThreadMock.mockReturnValue({
      id: THREAD_ID,
      ownerUserId: OWNER,
      messages: [
        { id: "m1", role: "user", content: "never use emojis" },
        { id: MSG_ID, role: "user", content: "always answer in German" },
      ],
    });
    await Promise.all([
      runChatCaptureDetectionJob(turnA, "job-a"),
      runChatCaptureDetectionJob(turnB, "job-b"),
    ]);
    expect(captureSkillMock).toHaveBeenCalledTimes(2); // both deltas applied — no lost amend
    expect(maxInFlight).toBe(1); // …but never concurrently
    // Both captures address the same (user, target): the deterministic
    // per-user skill — asserted structurally in chat-capture-skill.test.ts.
    expect(finalizeMock).toHaveBeenCalledWith(expect.objectContaining({ status: "captured" }));
  });

  it("pipeline failure marks the row 'error' and rethrows for BullMQ retry", async () => {
    seedThread("always answer in German");
    captureSkillMock.mockRejectedValue(new Error("provider down"));
    await expect(runChatCaptureDetectionJob(payload(), "job-1")).rejects.toThrow("provider down");
    expect(finalizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", detail: expect.stringContaining("provider down") }),
    );
  });
});
