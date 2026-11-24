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

const mount = vi.hoisted(() => ({ dir: "" }));
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => {
    if (!mount.dir) throw new Error("fixture mount unset");
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
  gateRow.read = "row";
  gateRow.xRenderer = ID;
  gateRow.values = {};
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
    // red-first-expect: expected undefined to match /^sha256:/
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
