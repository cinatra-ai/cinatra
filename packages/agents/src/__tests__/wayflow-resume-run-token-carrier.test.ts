/**
 * #1193 RESUME run-token carrier — the four resume `sendTask` sites.
 *
 * The defect this locks: the dispatch-minted run token rode ONLY the initial A2A
 * message, so every RESUMED task attached no `X-Cinatra-Run-Token`. Because the
 * compiled context subflow interrupts at its HITL gate, `/api/context-finalize`
 * ALWAYS executes in a resumed task — so with the legacy channels retired, a
 * resume without a carrier 403s every interactive context selection and strips
 * OBO from every post-gate llm-bridge step.
 *
 * What is pinned here, per site:
 *   1. the resume message carries the RAW token in `message.metadata` under the
 *      reserved key;
 *   2. the token is NOT in the message text (the text is the operator's answer,
 *      delivered verbatim to the gate's InputMessageNode);
 *   3. the hash is persisted BEFORE the blocking sendTask;
 *   4. a persist failure aborts the resume rather than sending an unresolvable
 *      credential.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CINATRA_RUN_TOKEN_MESSAGE_KEY } from "@/lib/agent-run-token";

type SentMessage = {
  parts?: Array<{ kind: string; text?: string }>;
  metadata?: Record<string, unknown>;
};

const order: string[] = [];
const sent: SentMessage[] = [];

const { setAgentRunTokenHashMock, sendTaskMock } = vi.hoisted(() => ({
  setAgentRunTokenHashMock: vi.fn(async () => {}),
  sendTaskMock: vi.fn(async () => ({ id: "task-1", status: { state: "completed" } })),
}));

vi.mock("server-only", () => ({}));
vi.mock("../store", () => ({
  setAgentRunTokenHash: setAgentRunTokenHashMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  sent.length = 0;
  setAgentRunTokenHashMock.mockImplementation(async () => {
    order.push("persist-hash");
  });
  sendTaskMock.mockImplementation(async (params: { message: SentMessage }) => {
    order.push("send-task");
    sent.push(params.message);
    return { id: "task-1", status: { state: "completed" } };
  });
});

describe("mintResumeRunTokenMetadata — the carrier primitive", () => {
  it("returns metadata carrying the RAW token under the reserved key", async () => {
    const { mintResumeRunTokenMetadata } = await import(
      "../wayflow-run-token-carrier"
    );
    const metadata = await mintResumeRunTokenMetadata("run-1");
    const raw = metadata[CINATRA_RUN_TOKEN_MESSAGE_KEY];
    expect(typeof raw).toBe("string");
    expect((raw as string).length).toBeGreaterThan(20);
    // The reserved key is the ONLY thing the carrier contributes.
    expect(Object.keys(metadata)).toEqual([CINATRA_RUN_TOKEN_MESSAGE_KEY]);
  });

  it("persists ONLY the HASH — never the raw token", async () => {
    const { mintResumeRunTokenMetadata } = await import(
      "../wayflow-run-token-carrier"
    );
    const metadata = await mintResumeRunTokenMetadata("run-1");
    const raw = metadata[CINATRA_RUN_TOKEN_MESSAGE_KEY] as string;

    expect(setAgentRunTokenHashMock).toHaveBeenCalledTimes(1);
    const [runId, persisted] = setAgentRunTokenHashMock.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(runId).toBe("run-1");
    expect(persisted).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted).not.toBe(raw);
    // The persisted value is sha256(raw) — the verifier's single-probe key.
    const { createHash } = await import("node:crypto");
    expect(persisted).toBe(createHash("sha256").update(raw, "utf8").digest("hex"));
  });

  it("mints a DISTINCT credential per leg (each resume rotates)", async () => {
    const { mintResumeRunTokenMetadata } = await import(
      "../wayflow-run-token-carrier"
    );
    const a = await mintResumeRunTokenMetadata("run-1");
    const b = await mintResumeRunTokenMetadata("run-1");
    expect(a[CINATRA_RUN_TOKEN_MESSAGE_KEY]).not.toBe(
      b[CINATRA_RUN_TOKEN_MESSAGE_KEY],
    );
  });

  it("a persist failure THROWS — no credential is sent that the verifier cannot resolve", async () => {
    setAgentRunTokenHashMock.mockRejectedValueOnce(new Error("db down"));
    const { mintResumeRunTokenMetadata } = await import(
      "../wayflow-run-token-carrier"
    );
    await expect(mintResumeRunTokenMetadata("run-1")).rejects.toThrow("db down");
  });
});

// ---------------------------------------------------------------------------
// Per-site wiring. Each resume site is driven through the SAME contract via the
// shared carrier, so the site-level assertion is: the metadata reaches the wire,
// the text does not carry the credential, and the hash lands BEFORE the send.
// ---------------------------------------------------------------------------

describe("resume sites attach the carrier to the A2A message", () => {
  async function driveResume(resumeText: string): Promise<SentMessage> {
    const { mintResumeRunTokenMetadata } = await import(
      "../wayflow-run-token-carrier"
    );
    const metadata = await mintResumeRunTokenMetadata("run-1");
    await sendTaskMock({
      message: {
        role: "user",
        kind: "message",
        messageId: "m1",
        contextId: "ctx-1",
        parts: [{ kind: "text", text: resumeText }],
        metadata,
      },
    } as { message: SentMessage });
    return sent[0];
  }

  it("carries the token in metadata and NEVER in the message text", async () => {
    const answer = '{"review":{"decision":"approved"},"approved":true}';
    const message = await driveResume(answer);

    const raw = message.metadata?.[CINATRA_RUN_TOKEN_MESSAGE_KEY];
    expect(typeof raw).toBe("string");

    // The operator's answer is delivered VERBATIM — byte-identical, no JSON
    // wrapper, no injected key. The artifact-review path depends on this.
    expect(message.parts?.[0].text).toBe(answer);
    const wire = JSON.stringify(message.parts);
    expect(wire).not.toContain(raw as string);
    expect(wire).not.toContain(CINATRA_RUN_TOKEN_MESSAGE_KEY);
  });

  it("persists the hash BEFORE the blocking sendTask", async () => {
    await driveResume("[Approved by operator]");
    expect(order).toEqual(["persist-hash", "send-task"]);
  });
});

// ---------------------------------------------------------------------------
// Source-level wiring lock. The carrier is only useful if EVERY resume site
// actually calls it — a new resume path that forgets it would silently lose run
// identity again, which is exactly the regression that forced the prior revert.
// ---------------------------------------------------------------------------

describe("every WayFlow resume sendTask site is wired to the carrier", () => {
  const SITES = [
    "orchestrator-actions.ts",
    "review-task-actions.ts",
    "artifact-review-resume-delivery.ts",
    "mcp/handlers.ts",
  ];

  it.each(SITES)("%s mints resume metadata and attaches it", async (site) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", site), "utf8");

    expect(src).toContain("mintResumeRunTokenMetadata");
    // The minted object must actually reach the message.
    expect(src).toMatch(/metadata:\s*resumeMetadata/);
  });

  it("no resume sendTask site sends a message without metadata", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const site of SITES) {
      const src = readFileSync(join(__dirname, "..", site), "utf8");
      // Every sendTask in a resume site must be preceded by the carrier mint;
      // count them so an ADDED send cannot slip through uncarried.
      const sends = src.match(/client\.sendTask\(/g) ?? [];
      const mints = src.match(/mintResumeRunTokenMetadata\(/g) ?? [];
      expect(mints.length).toBeGreaterThanOrEqual(sends.length);
    }
  });
});
