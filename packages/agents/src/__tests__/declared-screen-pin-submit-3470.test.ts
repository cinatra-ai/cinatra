/**
 * cinatra#3470: an answer is sent only for the declared screen its step opened
 * under.
 *
 * Every door that answers a mid-run step (the run page's Continue, the
 * conversation card, the assistant's lent submit) reaches the one approval
 * core. The core reads the step's gate row, and its schema carries the pin the
 * park wrote (`withDeclaredScreenPin`). When the renderer installed now
 * declares another screen, the answer was made on a screen the step never
 * asked with: it is refused before the fence, the pause is given back and
 * nothing is sent. A step whose screen cannot be verified (its gate row
 * missing or unreadable, its declaration unreadable) is refused the same way;
 * a step that opened with no screen, whose renderer declares none, is sent.
 * The check reads the declaration past the bindings cache. Read through the
 * production lookup over a temporary runtime mount.
 *
 * The server, not the screen, decides whether a declared card was answered:
 * an answer to a step whose card asks for a decision or a field is sent only
 * when it is the card's whole, ready answer, marked or not. A generic approval
 * or an empty answer is refused and the pause is given back.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/declared-screen-pin-submit-3470.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RunTransitionError } from "../run-status";

// The host seals each pin it writes with a key derived from the app secret.
process.env.BETTER_AUTH_SECRET ??= "x3470-placeholder-not-a-credential";

// `beforeScan`: what happens on disk before each next scan of the installed
// agents, one step per scan (an install made between two scans).
const mount = vi.hoisted(() => ({ dir: "", beforeScan: [] as Array<(() => void) | null> }));
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => {
    if (!mount.dir) throw new Error("fixture mount unset");
    mount.beforeScan.shift()?.();
    return mount.dir;
  },
}));

const row = vi.hoisted(() => ({ status: "pending_approval" as string }));
const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentRunByTaskId: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readRunCoOwners: vi.fn(async () => []),
  writeHitlPrompt: vi.fn(async () => undefined),
  transitionRunStatus: vi.fn(),
}));
vi.mock("../run-pause-claim", async (orig) => ({
  ...(await orig<typeof import("../run-pause-claim")>()),
  ...(await import("./pause-claim-test-fake")).pauseClaimFake,
}));
vi.mock("../store", () => storeMock);
vi.mock("../publish-decision-store", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLatestDecisionForRun: async () => null,
}));
// The step's gate row, as the park wrote it.
const gateRow = vi.hoisted(() => ({
  inputSchema: {} as Record<string, unknown>,
  read: "row" as "row" | "missing" | "throws",
  xRenderer: "@acme-test/pin-submit-agent:confirm",
  values: {} as Record<string, unknown>,
}));
vi.mock("../agent-run-hitl-prompts", () => ({
  captureHitlPromptForContinue: async () => "captured-prompt",
  readDurableHitlGateForContinue: async (runId: string, reviewTaskId: string) => {
    if (gateRow.read === "throws") throw new Error("fixture gate store down");
    if (gateRow.read === "missing") return null;
    return {
      runId,
      reviewTaskId,
      xRenderer: gateRow.xRenderer,
      inputSchema: gateRow.inputSchema,
      values: gateRow.values,
      materializedAt: "2026-01-01T00:00:00.000Z",
    };
  },
  recordSuccessfulContinue: async () => {},
  continueBindingDigest: () => "",
  continueGateDigest: () => "",
}));
// The run's event log: the latest gate frame the park emitted, or none.
const eventLog = vi.hoisted(() => ({ frame: null as Record<string, unknown> | null }));
vi.mock("@cinatra-ai/agent-ui-protocol/server", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLatestAgUiInterrupt: async () => eventLog.frame,
}));
vi.mock("../db", () => {
  const query: Record<string, unknown> = {};
  query.from = () => query;
  query.where = () => query;
  query.limit = async () => [];
  return {
    db: { select: () => query },
    agentBuilderPool: { on: () => {}, listenerCount: () => 1 },
  };
});
vi.mock("../resume-run-from-setup-approval", () => ({
  resumeRunFromSetupApproval: vi.fn(async () => undefined),
}));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent-builder-execution" },
}));
vi.mock("../wayflow-url", async (orig) => ({
  ...(await orig<typeof import("../wayflow-url")>()),
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  createWayflowFetch: vi.fn(() => globalThis.fetch),
}));
vi.mock("@/lib/auth-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-session")>()),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
}));
vi.mock("../wayflow-run-token-carrier", () => ({
  mintResumeRunTokenMetadata: vi.fn(async () => ({ token: "t" })),
}));
const sendTask = vi.hoisted(() => vi.fn());
vi.mock("@cinatra-ai/a2a", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createExternalA2AClient: vi.fn(async () => ({ sendTask })),
  resolveRunIdByWayflowTaskId: vi.fn(async () => null),
  resolveLatestWayflowGateTaskId: vi.fn(async () => null),
  rememberLatestWayflowGateTask: vi.fn(async () => {}),
  rememberAnsweredGateSubmission: vi.fn(async () => {}),
}));
const handleWayflowTaskState = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../execution", () => ({ handleWayflowTaskState }));

import * as reviewTaskActions from "../review-task-actions";
import { resumeMessageFromInput } from "../mcp/resume-message";
import { approveReviewTaskInternal } from "../review-task-actions";
import * as claimModule from "../run-pause-claim";
import * as bindingsServer from "../field-renderer-bindings.server";

const ID = "@acme-test/pin-submit-agent:confirm";
const RUN = {
  id: "run-pin-submit",
  templateId: "tpl-pin-submit",
  orgId: "org-1",
  runBy: "reader-pin",
  authPolicy: null,
  a2aContextId: "ctx-pin-submit",
  a2aTaskId: "task-pin-submit",
  pauseGeneration: 1,
};
const GATE = "wayflow-gate-pin-submit";
const liveRun = () => ({ ...RUN, status: row.status });
const fenceCalls = () =>
  storeMock.transitionRunStatus.mock.calls.filter((c) => c[1] === "pending_approval" && c[2] === "running");
const pauseClaimFake = claimModule as unknown as Record<
  "releasePauseClaim" | "settlePauseSend",
  ReturnType<typeof vi.fn>
>;
const server = bindingsServer as unknown as {
  __clearInstalledFieldRendererBindingsCache: () => void;
  withDeclaredScreenPin?: (schema: Record<string, unknown>, x: string) => Record<string, unknown>;
  currentDeclaredScreenPin?: (x: string, opts?: { fresh?: boolean }) => string | null;
};

/** Write the fixture agent's manifest; the bindings cache is left as it is. */
function writeManifest(manifest: string): void {
  const dir = join(mount.dir, "acme-test", "pin-submit-agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), manifest);
}

/** The fixture manifest: a declared card titled `title`, or no screen at all. */
function manifest(title: string | null, screen?: Record<string, unknown>): string {
  return JSON.stringify({
    name: "@acme-test/pin-submit-agent",
    cinatra: {
      fieldRenderers: [
        {
          id: ID,
          kind: "linkedin-draft-review",
          priority: 90,
          midRunHitl: true,
          ...(title === null
            ? {}
            : {
                screen: screen ?? {
                  layout: "card",
                  title,
                  decisionLabel: "Fixture decision",
                  decisions: [{ label: "Fixture send", answer: { approved: true } }],
                },
              }),
        },
      ],
    },
  });
}

/** Install (or update) the fixture agent with `title` on its declared card. */
function install(title: string | null, screen?: Record<string, unknown>): void {
  writeManifest(manifest(title, screen));
  server.__clearInstalledFieldRendererBindingsCache();
}

/** What the card's Continue sends for its one decision: the whole answer, marked. */
const CARD_ANSWER = {
  approved: true,
  userResponse: JSON.stringify({ approved: true }),
  approvedAt: "2026-01-01T00:00:00.000Z",
  "x-declared-card-answer": true,
};

/** Answer the gate with `values` (a generic approval by default): "sent", or the refusal's text. */
function answer(values: unknown = { approved: true }): Promise<string> {
  return approveReviewTaskInternal(GATE, RUN.runBy, values).then(
    () => "sent",
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
}

/** Nothing was sent, and the pause was given back. */
function expectRefusedAndGivenBack(): void {
  expect(sendTask).not.toHaveBeenCalled();
  expect(fenceCalls()).toEqual([]);
  expect(pauseClaimFake.releasePauseClaim).toHaveBeenCalledTimes(1);
  expect(row.status).toBe("pending_approval");
}

/** The park: the step's gate row carries the pin of what is installed now. */
function park(): void {
  const base = { type: "object" };
  gateRow.inputSchema = server.withDeclaredScreenPin?.(base, ID) ?? base;
}

function arrange() {
  row.status = "pending_approval";
  storeMock.readAgentRunByTaskId.mockImplementation(async () => liveRun());
  storeMock.readAgentRunById.mockImplementation(async () => liveRun());
  storeMock.readAgentTemplateById.mockResolvedValue({
    id: RUN.templateId,
    packageName: "@acme-test/pin-submit-agent",
    sourceType: "internal",
    agentAuthPolicy: null,
  });
  storeMock.transitionRunStatus.mockImplementation(async (runId: string, from: string, to: string) => {
    if (row.status !== from) {
      throw new RunTransitionError({ code: "stale_from_status", runId, from: from as never, to: to as never });
    }
    row.status = to;
  });
  sendTask.mockImplementation(async () => ({
    id: "task-next",
    contextId: RUN.a2aContextId,
    status: { state: "input-required" },
  }));
}

beforeAll(async () => {
  mount.dir = mkdtempSync(join(tmpdir(), "declared-screen-pin-submit-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Continue reaches its collaborators through dynamic imports: one answer is
  // driven through the whole road first, so the module registry is warm.
  install("Fixture warm-up");
  park();
  arrange();
  await approveReviewTaskInternal(GATE, RUN.runBy, { approved: true }).catch(() => undefined);
}, 60_000);

afterAll(() => {
  rmSync(mount.dir, { recursive: true, force: true });
  mount.dir = "";
  server.__clearInstalledFieldRendererBindingsCache();
});

beforeEach(() => {
  vi.clearAllMocks();
  mount.beforeScan = [];
  gateRow.read = "row";
  gateRow.xRenderer = ID;
  gateRow.values = {};
  eventLog.frame = null;
  arrange();
});

describe("an answer is sent only under the declared screen its step opened under (cinatra#3470)", () => {
  it("a renderer updated while the step waited refuses the answer: the pause is given back and nothing is sent", async () => {
    install("Fixture earlier revision");
    park();
    install("Fixture later revision");
    const sent = approveReviewTaskInternal(GATE, RUN.runBy, { approved: true }).then(
      () => "sent",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    // red-first-expect: expected 'sent' to contain 'changed after the step opened'
    expect(await sent).toContain("changed after the step opened");
    expect(sendTask).not.toHaveBeenCalled();
    expect(fenceCalls()).toEqual([]);
    expect(pauseClaimFake.releasePauseClaim).toHaveBeenCalledTimes(1);
    expect(row.status).toBe("pending_approval");
  });

  describe("the declaration checked against the step's pin is the one its answer is read with", () => {
    const EARLIER_CARD = {
      layout: "card",
      title: "Fixture checked revision",
      decisionLabel: "Fixture decision",
      decisions: [{ label: "Fixture checked send", answer: { approved: true } }],
    };
    const LATER_CARD = {
      layout: "card",
      title: "Fixture swapped revision",
      decisionLabel: "Fixture decision",
      decisions: [{ label: "Fixture swapped send", answer: { approved: true, route: "swapped" } }],
    };
    /** The later revision is installed under the same id just before the scan `n` (from 1) after now. */
    const swapBeforeScan = (n: number) => {
      mount.beforeScan = Array.from({ length: n }, (_, i) =>
        i === n - 1 ? () => writeManifest(manifest("Fixture swapped revision", LATER_CARD)) : null,
      );
    };

    it("a card read takes the declaration whose pin it checked, never one installed before a second scan", () => {
      install("Fixture checked revision", EARLIER_CARD);
      park();
      swapBeforeScan(2);
      const card = (
        bindingsServer as unknown as { readDeclaredHitlCard?: (x: string, s: unknown, o?: unknown) => unknown }
      ).readDeclaredHitlCard?.(ID, gateRow.inputSchema, { fresh: true });
      // red-first-expect: expected undefined to match object
      expect(card).toMatchObject({ title: "Fixture checked revision" });
    });

    it("an answer made on a declaration installed between the check and the read is refused", async () => {
      install("Fixture checked revision", EARLIER_CARD);
      park();
      swapBeforeScan(3);
      const swappedAnswer = JSON.stringify({ approved: true, route: "swapped" });
      // Read through the module, so a tree without the reader answers nothing.
      const { stepScreenAnswer } = reviewTaskActions as unknown as {
        stepScreenAnswer?: (gate: unknown, answer: unknown) => Promise<Record<string, string>>;
      };
      const result = await stepScreenAnswer?.(
        { xRenderer: ID, inputSchema: gateRow.inputSchema, values: {} },
        { answersDeclaredCard: true, resumeText: swappedAnswer },
      );
      // red-first-expect: expected 'undefined' to be 'string'
      expect(typeof result?.refusal).toBe("string");
      expect(result?.send).toBeUndefined();
    });
  });

  it("an answer to a step whose declaration is unchanged is sent once", async () => {
    install("Fixture current revision");
    park();
    await approveReviewTaskInternal(GATE, RUN.runBy, CARD_ANSWER);
    expect(fenceCalls()).toHaveLength(1);
    expect(sendTask).toHaveBeenCalledTimes(1);
    expect(pauseClaimFake.releasePauseClaim).not.toHaveBeenCalled();
  });

  it("an update made while the bindings cache still holds the earlier declaration refuses the answer", async () => {
    install("Fixture cached revision");
    park();
    // The park read the declaration, so the cache holds it; the update is not
    // followed by a cache clear.
    writeManifest(manifest("Fixture uncached revision"));
    // red-first-expect: expected 'sent' to contain 'changed after the step opened'
    expect(await answer()).toContain("changed after the step opened");
    expectRefusedAndGivenBack();
  });

  it("a step that parks while the bindings cache still holds an earlier declaration is pinned to the one installed, and is answered", async () => {
    install("Fixture cached before park");
    // A read made before the park: the cache holds this declaration.
    const cachedPin = server.currentDeclaredScreenPin?.(ID);
    // The agent is updated, and the cache is not cleared before the run parks.
    writeManifest(manifest("Fixture installed at park"));
    park();
    const pinned = gateRow.inputSchema["x-declared-screen"];
    // red-first-expect: .toMatch() expects to receive a string, but got undefined
    expect(pinned).toMatch(/^sha256:/);
    expect(pinned).not.toBe(cachedPin);
    expect(pinned).toBe(server.currentDeclaredScreenPin?.(ID, { fresh: true }));
    expect(await answer(CARD_ANSWER)).toBe("sent");
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("a declaration that can no longer be read (a malformed manifest) refuses the answer", async () => {
    install("Fixture readable revision");
    park();
    writeManifest("{ not json");
    server.__clearInstalledFieldRendererBindingsCache();
    // red-first-expect: expected 'sent' to contain 'could not be loaded'
    expect(await answer()).toContain("could not be loaded");
    expectRefusedAndGivenBack();
  });

  it("a gate row that cannot be read refuses the answer", async () => {
    install("Fixture gate-read revision");
    park();
    gateRow.read = "throws";
    // red-first-expect: expected 'sent' to contain 'could not be loaded'
    expect(await answer()).toContain("could not be loaded");
    expectRefusedAndGivenBack();
  });

  it("a missing gate row refuses the answer", async () => {
    install("Fixture gate-missing revision");
    park();
    gateRow.read = "missing";
    // red-first-expect: expected 'sent' to contain 'could not be loaded'
    expect(await answer()).toContain("could not be loaded");
    expectRefusedAndGivenBack();
  });

  describe("a step whose gate row could not be written at the park is answered from its event-log frame", () => {
    /**
     * The park as the WayFlow gate runs it (human-gate-park.ts): the frame is
     * emitted and read back, the gate row's insert fails, and the run parks.
     * Returns the park's outcome.
     */
    async function parkWithRowInsertFailing(): Promise<string> {
      const { parkRunOnHumanGate } = await import("../human-gate-park");
      row.status = "running";
      gateRow.read = "missing";
      const base = { type: "object" };
      const outcome = await parkRunOnHumanGate({
        runId: RUN.id,
        gateLabel: `WayFlow gate ${GATE}`,
        alreadyParked: false,
        buildArtifact: async () => ({
          schema: server.withDeclaredScreenPin?.(base, ID) ?? base,
          xRenderer: ID,
          values: {},
          reviewTaskId: GATE,
        }),
        emitInterrupt: (artifact) => {
          eventLog.frame = {
            xRenderer: artifact.xRenderer,
            schema: artifact.schema,
            values: artifact.values,
            reviewTaskId: artifact.reviewTaskId,
          };
        },
        readBackGate: async () => eventLog.frame as { reviewTaskId: string; xRenderer: string } | null,
        persistArtifact: async () => {
          throw new Error("fixture gate row insert failed");
        },
        parkRun: async () => {
          row.status = "pending_approval";
        },
        failRun: async (error) => {
          throw new Error(error);
        },
        attempts: 1,
        delayMs: 0,
      });
      return outcome.outcome;
    }

    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
    });

    it("the step parks, and the card's answer is sent once under the screen the frame pins", async () => {
      install("Fixture frame revision");
      expect(await parkWithRowInsertFailing()).toBe("parked");
      expect(await answer(CARD_ANSWER)).toBe("sent");
      expect(sendTask).toHaveBeenCalledTimes(1);
      expect(fenceCalls()).toHaveLength(1);
      expect(pauseClaimFake.releasePauseClaim).not.toHaveBeenCalled();
    });

    it("a renderer updated after that park refuses the answer as changed", async () => {
      install("Fixture frame earlier revision");
      await parkWithRowInsertFailing();
      install("Fixture frame later revision");
      // red-first-expect: expected 'sent' to contain 'changed after the step opened'
      expect(await answer(CARD_ANSWER)).toContain("changed after the step opened");
      expectRefusedAndGivenBack();
    });

    it("a frame whose schema carries no host pin is never answered under a declared screen", async () => {
      install("Fixture frame unpinned revision");
      await parkWithRowInsertFailing();
      eventLog.frame = { ...eventLog.frame, schema: { type: "object" } };
      // red-first-expect: expected 'sent' to contain 'changed after the step opened'
      expect(await answer(CARD_ANSWER)).toContain("changed after the step opened");
      expectRefusedAndGivenBack();
    });

    it("the latest frame of another step refuses the answer", async () => {
      install("Fixture frame other-step revision");
      await parkWithRowInsertFailing();
      eventLog.frame = { ...eventLog.frame, reviewTaskId: "wayflow-another-step" };
      // red-first-expect: expected 'sent' to contain 'could not be loaded'
      expect(await answer(CARD_ANSWER)).toContain("could not be loaded");
      expectRefusedAndGivenBack();
    });

    it("the agent_run_resume road reads the same frame", async () => {
      install("Fixture frame resume revision");
      eventLog.frame = null;
      const base = { type: "object" };
      eventLog.frame = {
        xRenderer: ID,
        schema: server.withDeclaredScreenPin?.(base, ID) ?? base,
        values: {},
        reviewTaskId: `wayflow-${RUN.a2aTaskId}`,
      };
      gateRow.read = "missing";
      const { resumeStepScreenAnswer } = reviewTaskActions as unknown as {
        resumeStepScreenAnswer?: (run: unknown, template: unknown, text: string) => Promise<unknown>;
      };
      const text = JSON.stringify({ approved: true });
      const template = { approvalPolicy: { steps: [{ xRenderer: ID }] } };
      // red-first-expect: expected undefined to deeply equal
      expect(await resumeStepScreenAnswer?.(RUN, template, text)).toEqual({ send: text });
    });
  });

  describe("agent_run_resume to a step with neither a gate row nor an event-log frame", () => {
    const { resumeStepScreenAnswer } = reviewTaskActions as unknown as {
      resumeStepScreenAnswer?: (run: unknown, template: unknown, text: string) => Promise<Record<string, string>>;
    };
    /** What agent_run_resume sends with no response: the fallback of its resume message. */
    const bareResume = (template: unknown) =>
      resumeStepScreenAnswer?.(RUN, template, resumeMessageFromInput(undefined, undefined).resumeText);
    /** The agent that declared the step's screen is uninstalled. */
    function removeAgent(): void {
      rmSync(join(mount.dir, "acme-test"), { recursive: true, force: true });
      server.__clearInstalledFieldRendererBindingsCache();
    }

    it("is refused when the agent that declared the step's screen was removed after the frame expired", async () => {
      // The step parks under a declared card; its gate row is never written.
      install("Fixture removed-agent revision");
      gateRow.read = "missing";
      // The frame expires from the event log, then the agent is removed.
      eventLog.frame = null;
      removeAgent();
      try {
        for (const template of [
          { approvalPolicy: { steps: [{ stepNumber: 1, xRenderer: ID }] } },
          { approvalPolicy: { steps: [{ stepNumber: 1, schema: { type: "object", properties: { reply: { "x-renderer": ID } } } }] } },
        ]) {
          const result = await bareResume(template);
          // red-first-expect: expected 'undefined' to be 'string'
          expect(typeof result?.refusal).toBe("string");
          expect(result?.refusal).toContain("could not be loaded");
          expect(result?.send).toBeUndefined();
        }
      } finally {
        install("Fixture reinstalled revision");
      }
    });

    it("an ordinary step with no renderer, under no declared screen, still resumes on a bare approval", async () => {
      install(null);
      gateRow.read = "missing";
      eventLog.frame = null;
      expect(await bareResume({ approvalPolicy: { steps: [{ stepNumber: 1 }] } })).toEqual({
        send: "[Approved by operator]",
      });
    });
  });

  it("a step that opened with no screen, whose renderer declares none, is sent as before", async () => {
    install(null);
    gateRow.inputSchema = { type: "object" };
    expect(await answer()).toBe("sent");
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("an answer made on a declared card is refused for a step that opened with no screen, whose renderer declares none now", async () => {
    // The screen was removed before the step opened: the step declares none.
    install(null);
    park();
    // A browser still holding the removed card sends its answer, marked as one.
    const staleCardAnswer = { approved: true, route: "removed", "x-declared-card-answer": true };
    const sent = await approveReviewTaskInternal(GATE, RUN.runBy, staleCardAnswer).then(
      () => "sent",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    // red-first-expect: expected 'sent' to contain 'does not declare'
    expect(sent).toContain("does not declare");
    expectRefusedAndGivenBack();
  });

  it("an answer made on the declared card the step opened under is sent, without the mark", async () => {
    install("Fixture marked revision");
    park();
    await approveReviewTaskInternal(GATE, RUN.runBy, CARD_ANSWER);
    expect(sendTask).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sendTask.mock.calls)).not.toContain("x-declared-card-answer");
  });

  it("a generic approval of a step whose card asks for a decision is refused: the pause is given back and nothing is sent", async () => {
    install("Fixture decision revision");
    park();
    // red-first-expect: expected 'sent' to contain 'did not give'
    expect(await answer({ approved: true })).toContain("did not give");
    expectRefusedAndGivenBack();
  });

  it("an answer with no values is refused for a step whose card asks for a decision", async () => {
    install("Fixture empty revision");
    park();
    // red-first-expect: expected 'sent' to contain 'did not give'
    expect(await answer(undefined)).toContain("did not give");
    expectRefusedAndGivenBack();
  });

  it("an answer that carries only the declared-card mark is refused for a step whose card asks for a decision", async () => {
    install("Fixture mark-only revision");
    park();
    // red-first-expect: expected 'sent' to contain 'did not give'
    expect(await answer({ "x-declared-card-answer": true })).toContain("did not give");
    expectRefusedAndGivenBack();
  });

  it("an answer that names no declared decision is refused, even when marked", async () => {
    install("Fixture undeclared-decision revision");
    park();
    const other = { route: "elsewhere" };
    const values = { ...other, userResponse: JSON.stringify(other), "x-declared-card-answer": true };
    // red-first-expect: expected 'sent' to contain 'did not give'
    expect(await answer(values)).toContain("did not give");
    expectRefusedAndGivenBack();
  });

  it("a card with a field is answered only with the field filled", async () => {
    install("Fixture field revision", {
      layout: "card",
      title: "Fixture field revision",
      sections: [{ type: "field", key: "postText", label: "Post text" }],
    });
    park();
    const blank = { postText: "  ", userResponse: JSON.stringify({ postText: "  " }), approved: true };
    // red-first-expect: expected 'sent' to contain 'did not give'
    expect(await answer(blank)).toContain("did not give");
    expectRefusedAndGivenBack();
    vi.clearAllMocks();
    arrange();
    const filled = { postText: "Hello", userResponse: JSON.stringify({ postText: "Hello" }), approved: true };
    expect(await answer(filled)).toBe("sent");
    expect(sendTask).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sendTask.mock.calls)).toContain("Hello");
  });

  describe("a card that carries a run value is answered only with its canonical whole answer", () => {
    const CARRY_CARD = {
      layout: "card",
      title: "Fixture carry revision",
      decisionLabel: "Fixture decision",
      decisions: [{ label: "Fixture post", answer: { post: true } }],
      carry: ["itemId"],
    };
    const withText = (whole: Record<string, unknown>) => ({ ...whole, userResponse: JSON.stringify(whole), approved: true });
    /** The resume text the agent was sent. */
    const sentText = (): string => {
      const text = JSON.stringify(sendTask.mock.calls).match(/"text":"((?:[^"\\]|\\.)*)"/);
      return text === null ? "" : (JSON.parse(`"${text[1]}"`) as string);
    };

    beforeEach(() => {
      install("Fixture carry revision", CARRY_CARD);
      park();
      gateRow.values = { itemId: "item-A" };
    });

    it("a carried value that is not the gate's own is refused", async () => {
      // red-first-expect: expected 'sent' to contain 'did not give'
      expect(await answer(withText({ itemId: "item-B", post: true }))).toContain("did not give");
      expectRefusedAndGivenBack();
    });

    it("an answer without the carried value is refused", async () => {
      // red-first-expect: expected 'sent' to contain 'did not give'
      expect(await answer(withText({ post: true }))).toContain("did not give");
      expectRefusedAndGivenBack();
    });

    it("an answer with a key outside the card's answer is refused", async () => {
      // red-first-expect: expected 'sent' to contain 'did not give'
      expect(await answer(withText({ itemId: "item-A", post: true, extra: "x" }))).toContain("did not give");
      expectRefusedAndGivenBack();
    });

    it("the agent is sent the answer as the card's one writer builds it, never the caller's text", async () => {
      expect(await answer(withText({ post: true, itemId: "item-A" }))).toBe("sent");
      expect(sendTask).toHaveBeenCalledTimes(1);
      // red-first-expect: expected '{"post":true,"itemId":"item-A"}' to be '{"itemId":"item-A","post":true}'
      expect(sentText()).toBe(JSON.stringify({ itemId: "item-A", post: true }));
    });
  });

  describe("a step drawn by a \"kind\" screen is sent only an answer that holds what its screen requires", () => {
    /** Install the fixture agent with a "kind" screen of `kind`, and park the step with `base` as its schema. */
    function installKindScreen(kind: string, base: Record<string, unknown> = { type: "object" }): void {
      writeManifest(
        JSON.stringify({
          name: "@acme-test/pin-submit-agent",
          cinatra: {
            fieldRenderers: [{ id: ID, kind, priority: 90, midRunHitl: true, screen: { layout: "kind" } }],
          },
        }),
      );
      server.__clearInstalledFieldRendererBindingsCache();
      gateRow.inputSchema = server.withDeclaredScreenPin?.(base, ID) ?? base;
    }
    const { resumeStepScreenAnswer } = reviewTaskActions as unknown as {
      resumeStepScreenAnswer?: (run: unknown, template: unknown, text: string) => Promise<Record<string, string>>;
    };
    const template = { approvalPolicy: { steps: [{ xRenderer: ID }] } };
    /** What agent_run_resume sends with no response: the fallback of its resume message. */
    const resumedWithNoResponse = async () =>
      resumeStepScreenAnswer?.(RUN, template, resumeMessageFromInput(undefined, undefined).resumeText);
    const SETUP_SCHEMA = {
      type: "object",
      properties: { senderName: { type: "string" }, note: { type: "string" } },
      required: ["senderName"],
    };

    it("agent_run_resume with no response is refused for a list step", async () => {
      installKindScreen("list-picker");
      const result = await resumedWithNoResponse();
      // red-first-expect: expected 'undefined' to be 'string'
      expect(typeof result?.refusal).toBe("string");
      expect(result?.send).toBeUndefined();
    });

    it("agent_run_resume is refused for a list step whose snapshot names no usable pick", async () => {
      installKindScreen("list-picker");
      const empty = JSON.stringify({ type: "list", listId: "  ", listName: "", memberCount: 0 });
      // red-first-expect: expected 'undefined' to be 'string'
      expect(typeof (await resumeStepScreenAnswer?.(RUN, template, empty))?.refusal).toBe("string");
    });

    it("agent_run_resume with a usable pick is sent for a list step", async () => {
      installKindScreen("list-picker");
      const picked = JSON.stringify({ type: "list", listIds: ["list-1"], listNames: ["One"] });
      // red-first-expect: expected undefined to deeply equal
      expect(await resumeStepScreenAnswer?.(RUN, template, picked)).toEqual({ send: picked });
    });

    it("agent_run_resume with no response is refused for a grouped setup form", async () => {
      installKindScreen("wayflow-setup-form", SETUP_SCHEMA);
      // red-first-expect: expected 'undefined' to be 'string'
      expect(typeof (await resumedWithNoResponse())?.refusal).toBe("string");
    });

    it("agent_run_resume is refused for a grouped setup form whose required field is blank", async () => {
      installKindScreen("wayflow-setup-form", SETUP_SCHEMA);
      const blank = JSON.stringify({ senderName: "", note: "x" });
      // red-first-expect: expected 'undefined' to be 'string'
      expect(typeof (await resumeStepScreenAnswer?.(RUN, template, blank))?.refusal).toBe("string");
    });

    it("agent_run_resume with every required field filled is sent for a grouped setup form", async () => {
      installKindScreen("wayflow-setup-form", SETUP_SCHEMA);
      const filled = JSON.stringify({ senderName: "Ada" });
      // red-first-expect: expected undefined to deeply equal
      expect(await resumeStepScreenAnswer?.(RUN, template, filled)).toEqual({ send: filled });
    });

    describe("a grouped setup form's answer is held to every constraint its schema declares", () => {
      const CONSTRAINED_SCHEMA = {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["safe"] },
          code: { type: "string", pattern: "^[A-Z]{3}$" },
          seats: { type: "integer", minimum: 1 },
          tags: { type: "array", items: { type: "string", minLength: 2 } },
          owner: { type: "object", properties: { kind: { type: "string", const: "team" } }, required: ["kind"] },
        },
        required: ["mode"],
      };

      it("a value outside the declared enum is refused", async () => {
        installKindScreen("wayflow-setup-form", CONSTRAINED_SCHEMA);
        const unsafe = JSON.stringify({ mode: "unsafe" });
        const result = await resumeStepScreenAnswer?.(RUN, template, unsafe);
        // red-first-expect: expected 'undefined' to be 'string'
        expect(typeof result?.refusal).toBe("string");
        expect(result?.send).toBeUndefined();
      });

      it("a value inside every declared constraint is sent", async () => {
        installKindScreen("wayflow-setup-form", CONSTRAINED_SCHEMA);
        const valid = JSON.stringify({ mode: "safe", code: "ABC", seats: 2, tags: ["ab"], owner: { kind: "team" } });
        // red-first-expect: expected undefined to deeply equal
        expect(await resumeStepScreenAnswer?.(RUN, template, valid)).toEqual({ send: valid });
      });

      it.each([
        ["a pattern", { mode: "safe", code: "abc" }],
        ["a minimum", { mode: "safe", seats: 0 }],
        ["an item's minLength", { mode: "safe", tags: ["a"] }],
        ["a nested const", { mode: "safe", owner: { kind: "person" } }],
      ])("a value that breaks %s is refused", async (_name, values) => {
        installKindScreen("wayflow-setup-form", CONSTRAINED_SCHEMA);
        const result = await resumeStepScreenAnswer?.(RUN, template, JSON.stringify(values));
        // red-first-expect: expected 'undefined' to be 'string'
        expect(typeof result?.refusal).toBe("string");
      });

      it("a schema with a keyword the validator does not implement is refused, never read as no constraint", async () => {
        installKindScreen("wayflow-setup-form", {
          type: "object",
          properties: { mode: { type: "string", $dynamicRef: "#mode" } },
          required: ["mode"],
        });
        const result = await resumeStepScreenAnswer?.(RUN, template, JSON.stringify({ mode: "safe" }));
        // red-first-expect: expected 'undefined' to be 'string'
        expect(typeof result?.refusal).toBe("string");
      });
    });

    it("a bare approval through the approval core is refused for a list step: the pause is given back", async () => {
      installKindScreen("list-picker");
      // red-first-expect: expected 'sent' to contain 'did not give'
      expect(await answer({ approved: true })).toContain("did not give");
      expectRefusedAndGivenBack();
    });

    it("a grouped setup form's values that fail its schema are refused through the approval core", async () => {
      installKindScreen("wayflow-setup-form", SETUP_SCHEMA);
      // red-first-expect: expected 'sent' to contain 'did not give'
      expect(await answer({ approved: true, userResponse: JSON.stringify({ note: "x" }) })).toContain("did not give");
      expectRefusedAndGivenBack();
      vi.clearAllMocks();
      arrange();
      expect(
        await answer({ senderName: "Ada", approved: true, userResponse: JSON.stringify({ senderName: "Ada" }) }),
      ).toBe("sent");
      expect(sendTask).toHaveBeenCalledTimes(1);
    });

    /** The resume text the agent was sent. */
    const resumedWith = (): string => {
      const text = JSON.stringify(sendTask.mock.calls).match(/"text":"((?:[^"\\]|\\.)*)"/);
      return text === null ? "" : (JSON.parse(`"${text[1]}"`) as string);
    };

    it("a grouped setup form whose values sit beside an answer that is not them is refused: the step is never resumed past its values", async () => {
      installKindScreen("wayflow-setup-form", SETUP_SCHEMA);
      // red-first-expect: expected 'sent' to contain 'did not give'
      expect(await answer({ senderName: "Ada", approved: true, approvalNote: "{}" })).toContain("did not give");
      expectRefusedAndGivenBack();
      vi.clearAllMocks();
      arrange();
      expect(await answer({ senderName: "Ada", approved: true })).toContain("did not give");
      expectRefusedAndGivenBack();
    });

    it("a declared setup form's submit resumes the step with the values entered, under any field name", async () => {
      const PROJECT_SCHEMA = {
        type: "object",
        properties: { projectName: { type: "string" } },
        required: ["projectName"],
      };
      installKindScreen("wayflow-setup-form", PROJECT_SCHEMA);
      // The browser holds the installed binding, as every host registers it.
      const { registerFieldRendererBindings } = await import("../register-default-renderers");
      const { fieldRendererRegistry } = await import("../field-renderer-registry");
      registerFieldRendererBindings([
        { id: ID, kind: "wayflow-setup-form", priority: 80, midRunHitl: true, screen: { layout: "kind" } },
      ]);
      try {
        const { withSetupFormAnswer } = (await import("../hitl-gate-submit")) as unknown as {
          withSetupFormAnswer?: (
            gate: { reviewTaskId: string; xRenderer: string },
            stepSchema: Record<string, unknown>,
            formValues: Record<string, unknown>,
            payload: Record<string, unknown>,
          ) => Record<string, unknown>;
        };
        // The form is seeded with a run value that is no field of the step.
        const formValues = { projectName: "Fixture project", itemId: "item-1" };
        const submitted = { ...formValues, approved: true, approvedAt: "2026-01-01T00:00:00.000Z" };
        const payload =
          withSetupFormAnswer?.({ reviewTaskId: GATE, xRenderer: ID }, PROJECT_SCHEMA, formValues, submitted) ?? submitted;
        expect(await answer(payload)).toBe("sent");
        expect(sendTask).toHaveBeenCalledTimes(1);
        // red-first-expect: expected '[Approved by operator]' to be '{"projectName":"Fixture project"}'
        expect(resumedWith()).toBe(JSON.stringify({ projectName: "Fixture project" }));
      } finally {
        const held = fieldRendererRegistry as { unregisterEntry?: (entry: unknown) => void };
        for (const entry of fieldRendererRegistry.list().filter((e) => e.id === ID)) held.unregisterEntry?.(entry);
      }
    });

    it("a declared setup form field named __proto__ reaches the resume text, and no prototype is changed", async () => {
      const PROTO_SCHEMA = JSON.parse(
        '{"type":"object","properties":{"__proto__":{"type":"object"}},"required":["__proto__"]}',
      ) as Record<string, unknown>;
      installKindScreen("wayflow-setup-form", PROTO_SCHEMA);
      const { registerFieldRendererBindings } = await import("../register-default-renderers");
      const { fieldRendererRegistry } = await import("../field-renderer-registry");
      registerFieldRendererBindings([
        { id: ID, kind: "wayflow-setup-form", priority: 80, midRunHitl: true, screen: { layout: "kind" } },
      ]);
      const prototypeKeys = Object.getOwnPropertyNames(Object.prototype).sort();
      try {
        const { withSetupFormAnswer } = (await import("../hitl-gate-submit")) as unknown as {
          withSetupFormAnswer?: (
            gate: { reviewTaskId: string; xRenderer: string },
            stepSchema: Record<string, unknown>,
            formValues: Record<string, unknown>,
            payload: Record<string, unknown>,
          ) => Record<string, unknown>;
        };
        const formValues = JSON.parse('{"__proto__":{"polluted":"yes"}}') as Record<string, unknown>;
        const submitted = { ...formValues, approved: true, approvedAt: "2026-01-01T00:00:00.000Z" };
        const payload: Record<string, unknown> =
          withSetupFormAnswer?.({ reviewTaskId: GATE, xRenderer: ID }, PROTO_SCHEMA, formValues, submitted) ?? submitted;
        // red-first-expect: expected undefined to be '{"__proto__":{"polluted":"yes"}}'
        expect(payload.userResponse).toBe('{"__proto__":{"polluted":"yes"}}');
        expect(await answer(payload)).toBe("sent");
        expect(resumedWith()).toBe('{"__proto__":{"polluted":"yes"}}');
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(prototypeKeys);
        expect(Object.getPrototypeOf({})).toBe(Object.prototype);
      } finally {
        const held = fieldRendererRegistry as { unregisterEntry?: (entry: unknown) => void };
        for (const entry of fieldRendererRegistry.list().filter((e) => e.id === ID)) held.unregisterEntry?.(entry);
      }
    });

    it("a kind with no input of its own is sent as before", async () => {
      installKindScreen("email-drafts-review");
      // red-first-expect: expected undefined to deeply equal
      expect(await resumedWithNoResponse()).toEqual({ send: "[Approved by operator]" });
      installKindScreen("campaign-recipients-review");
      expect(await resumedWithNoResponse()).toEqual({ send: "[Approved by operator]" });
    });

    /** The selection envelope the context selector's screen emits. */
    const SELECTION = JSON.stringify({
      slotId: "brief",
      resolutionMode: "override",
      selectedRefs: [{ artifactId: "a-1", representationRevisionId: "r-1", semanticAssertionId: "s-1" }],
    });

    it("agent_run_resume with no response is refused for a context selector", async () => {
      installKindScreen("context-selector");
      const result = await resumedWithNoResponse();
      // red-first-expect: expected 'undefined' to be 'string'
      expect(typeof result?.refusal).toBe("string");
      expect(result?.send).toBeUndefined();
    });

    it("agent_run_resume is refused for a context selector whose envelope names no slot", async () => {
      installKindScreen("context-selector");
      const noSlot = JSON.stringify({ resolutionMode: "override", selectedRefs: [] });
      // red-first-expect: expected 'undefined' to be 'string'
      expect(typeof (await resumeStepScreenAnswer?.(RUN, template, noSlot))?.refusal).toBe("string");
    });

    it("agent_run_resume with a selection envelope is sent for a context selector", async () => {
      installKindScreen("context-selector");
      expect(await resumeStepScreenAnswer?.(RUN, template, SELECTION)).toEqual({ send: SELECTION });
    });

    /** The envelope a host sends when a file goes with the answer. */
    const withFile = (text: string) =>
      JSON.stringify({
        text,
        attachments: [
          {
            artifactId: "art-1",
            representationRevisionId: "rev-1",
            digest: "sha256:fixture",
            mime: "text/plain",
            originKind: "upload",
          },
        ],
      });

    it("a context selection sent with a file is accepted, and a wrapper with no slot is still refused", async () => {
      installKindScreen("context-selector");
      // red-first-expect: expected undefined to deeply equal
      expect(await resumeStepScreenAnswer?.(RUN, template, withFile(SELECTION))).toEqual({ send: withFile(SELECTION) });
      expect(await answer({ approved: true, userResponse: withFile(SELECTION) })).toBe("sent");
      expect(resumedWith()).toBe(withFile(SELECTION));
      vi.clearAllMocks();
      arrange();
      const noSlot = withFile(JSON.stringify({ resolutionMode: "override", selectedRefs: [] }));
      expect(typeof (await resumeStepScreenAnswer?.(RUN, template, noSlot))?.refusal).toBe("string");
      expect(await answer({ approved: true, userResponse: noSlot })).toContain("did not give");
      expectRefusedAndGivenBack();
    });

    it("a bare approval through the approval core is refused for a context selector: the pause is given back", async () => {
      installKindScreen("context-selector");
      // red-first-expect: expected 'sent' to contain 'did not give'
      expect(await answer({ approved: true })).toContain("did not give");
      expectRefusedAndGivenBack();
      vi.clearAllMocks();
      arrange();
      expect(await answer({ approved: true, approvalNote: SELECTION })).toBe("sent");
      expect(sendTask).toHaveBeenCalledTimes(1);
    });
  });

  it("a step parked before the upgrade whose own schema names an 'unknown' pin is never answered under a declared screen", async () => {
    install("Fixture screen installed after the park");
    // The agent's schema carried the key; the park of that time kept it, unsealed.
    gateRow.inputSchema = { type: "object", "x-declared-screen": "unknown" };
    // red-first-expect: expected 'sent' to contain 'changed after the step opened'
    expect(await answer()).toContain("changed after the step opened");
    expectRefusedAndGivenBack();
  });

  it("a step parked before the upgrade whose own schema names an 'unknown' pin is sent while its renderer declares no screen", async () => {
    install(null);
    gateRow.inputSchema = { type: "object", "x-declared-screen": "unknown" };
    expect(await answer()).toBe("sent");
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("a bundled renderer id whose owning package's manifest is torn refuses the answer as could not be loaded", async () => {
    // A bundled id with no declared screen; the step opened under it with no pin.
    gateRow.xRenderer = "@cinatra-ai/blog-wordpress-publish-agent:draft-confirm";
    gateRow.inputSchema = { type: "object" };
    const owner = join(mount.dir, "cinatra-ai", "blog-wordpress-publish-agent");
    mkdirSync(owner, { recursive: true });
    writeFileSync(join(owner, "package.json"), '{"name": "@cinatra-ai/blog-wordpress-publish-agent", "cinatra": {');
    server.__clearInstalledFieldRendererBindingsCache();
    try {
      // red-first-expect: expected 'sent' to contain 'could not be loaded'
      expect(await answer()).toContain("could not be loaded");
      expectRefusedAndGivenBack();
    } finally {
      rmSync(join(mount.dir, "cinatra-ai"), { recursive: true, force: true });
      server.__clearInstalledFieldRendererBindingsCache();
    }
    // Once the owner is read cleanly (here: not installed), the answer is sent.
    vi.clearAllMocks();
    arrange();
    expect(await answer()).toBe("sent");
  });
});
