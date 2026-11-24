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
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/declared-screen-pin-submit-3470.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RunTransitionError } from "../run-status";

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
}));
vi.mock("../agent-run-hitl-prompts", () => ({
  captureHitlPromptForContinue: async () => "captured-prompt",
  readDurableHitlGateForContinue: async (runId: string, reviewTaskId: string) => {
    if (gateRow.read === "throws") throw new Error("fixture gate store down");
    if (gateRow.read === "missing") return null;
    return {
      runId,
      reviewTaskId,
      xRenderer: "@acme-test/pin-submit-agent:confirm",
      inputSchema: gateRow.inputSchema,
      values: {},
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
function manifest(title: string | null): string {
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
                screen: {
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
function install(title: string | null): void {
  writeManifest(manifest(title));
  server.__clearInstalledFieldRendererBindingsCache();
}

/** Answer the gate: "sent", or the refusal's text. */
function answer(): Promise<string> {
  return approveReviewTaskInternal(GATE, RUN.runBy, { approved: true }).then(
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
    await approveReviewTaskInternal(GATE, RUN.runBy, { approved: true });
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
    expect(await answer()).toBe("sent");
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
});
