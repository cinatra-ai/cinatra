// Builder-seam test for the per-turn no-progress guard (cinatra#2580).
//
// THREE THINGS ARE PROVEN HERE, all at the seam where the request envelope is
// built and handed to the provider — no live call, no network, no provider:
//
//   1. COST. A stalled agentic loop (the measured shape: the Cinatra MCP tools
//      are dead, so the model re-issues the same call and gets the same empty
//      result) is stopped after 4 provider steps instead of running to the
//      chat's 24-round ceiling. Every step re-ships the WHOLE envelope, so the
//      step count IS the cost.
//   2. THE ENVELOPE IS UNCHANGED. On a progressing turn the captured
//      `stream()` input — system prompt, tool array, messages, maxSteps,
//      skipMcpInjection, and the exact field set — is what it was before the
//      guard existed, and the turn still ends on `done`.
//   3. THE PRE-EXISTING FAILURE PATHS STILL BEHAVE. A caller abort and a
//      genuine provider error keep their old outcomes, and an un-aborted
//      caller signal still runs the turn — the guard composes onto the signal
//      without taking it over. (The 120s ceiling is the third source on that
//      same composition and is NOT separately covered here: driving a real
//      timer through this seam would make the suite time-dependent for no
//      added signal, since the caller-abort arms already prove the
//      composition delivers a non-guard abort.)
//
// The `stream` mock is a faithful stand-in for the shipped adapters' step
// loop: it runs up to `maxSteps` rounds, fires the same callbacks in the same
// order, and — like every shipped adapter — stops when its `signal` aborts.
// Both shipped abort behaviors are exercised: reporting through `onError` and
// then RESOLVING (what the OpenAI adapter does), and breaking the loop
// silently.

import { describe, expect, it, vi, beforeEach } from "vitest";

let capturedStreamInput: Record<string, unknown> | null = null;
/** What the mocked adapter should do on each step of the next turn. */
let stepScript: (step: number) => {
  toolCall?: { id?: string; name: string; arguments: unknown };
  toolResult?: { id?: string; name: string; result: string };
  text?: string;
  /** Report this through `onError`, then stop the loop (adapters resolve). */
  error?: unknown;
  /** THROW this out of `stream()` right after this step's `onStepEnd`. */
  throwAfterStepEnd?: unknown;
} = () => ({});
/** How the mocked adapter reacts once its signal aborts. */
let onAbort: "report-then-resolve" | "break-silently" = "report-then-resolve";
/** Provider steps the mocked adapter actually ran for the last turn. */
let stepsRun = 0;

const SYSTEM_BODY = "SYSTEM_PROMPT_BODY";
const CONFIRMATION_POLICY = "\n\nCONFIRMATION_POLICY";

vi.mock("@/lib/register-host-connector-services", () => ({}));
vi.mock("@/app/api/chat/chat-user-context", () => ({
  buildChatUserContextSections: vi.fn(async () => []),
}));
vi.mock("@/app/api/chat/extension-confirmation", () => ({
  buildExtensionImplementationConfirmationPolicy: () => CONFIRMATION_POLICY,
}));
vi.mock("@cinatra-ai/skills/mcp-client", () => ({
  createDeterministicSkillsClient: () => ({
    installed: { get: async () => ({ body: SYSTEM_BODY }) },
  }),
}));
vi.mock("@cinatra-ai/skills", () => ({
  ensureInstalledSkillsRegistered: vi.fn(async () => undefined),
  resolveInstalledSkillSourcePath: vi.fn(async () => null),
  retireSupersededChatSkillsOnce: vi.fn(async () => undefined),
}));
vi.mock("@/lib/wizard-staging-store", () => ({ getAllStagedByType: () => [] }));
vi.mock("@/lib/wizard-manifest-registry", () => ({
  getAllManifests: vi.fn(async () => []),
}));
vi.mock("@/lib/chat-mcp-actor-token", () => ({ issueChatMcpActorToken: vi.fn() }));
vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: () => null }));
vi.mock("@/lib/artifacts/attachment-resolver-ports", () => ({
  buildAttachmentResolverPorts: vi.fn(() => ({})),
}));
vi.mock("@cinatra-ai/llm", () => ({
  hasConfiguredLlmRuntime: vi.fn(async () => true),
  checkPublicMcpReachability: vi.fn(async () => ({
    status: "reachable",
    url: "https://mcp.example.test/api/mcp",
  })),
  resolveDefaultAdapter: vi.fn(async () => ({ provider: "openai", defaultModel: "gpt-4o" })),
  resolveBoundDefaultAdapter: vi.fn(async () => ({ provider: "openai", defaultModel: "gpt-4o" })),
  BoundDefaultProviderUnavailableError: class extends Error {},
  selectSkillDeliveryAdapter: vi.fn(() => ({
    provider: "openai",
    deliver: vi.fn(async () => ({
      tools: [{ type: "function", name: "shell" }],
      systemContext: "",
      exposure: [],
    })),
  })),
  resolveChatExternalMcpTools: vi.fn(async () => []),
  buildLlmMcpServerToolForChat: vi.fn(async () => ({
    type: "mcp",
    name: "cinatra",
    serverLabel: "cinatra",
  })),
  // A faithful stand-in for the shipped adapters' step loop.
  stream: vi.fn(async (input: Record<string, unknown>) => {
    capturedStreamInput = input;
    stepsRun = 0;
    const maxSteps = input.maxSteps as number;
    const signal = input.signal as AbortSignal | undefined;
    const reportAbort = () => {
      // What the shipped OpenAI adapter does: surface through `onError`, then
      // break the step loop and RESOLVE normally.
      if (onAbort === "report-then-resolve") {
        (input.onError as (e: unknown) => void)(signal?.reason ?? new Error("aborted"));
      }
    };
    for (let step = 0; step < maxSteps; step++) {
      if (signal?.aborted) {
        reportAbort();
        return;
      }
      stepsRun += 1;
      (input.onStepStart as (s: number) => void)(step + 1);
      const scripted = stepScript(step);
      if (scripted.text) (input.onTextDelta as (d: string) => void)(scripted.text);
      if (scripted.error !== undefined) {
        (input.onError as (e: unknown) => void)(scripted.error);
        return;
      }
      if (scripted.toolCall) (input.onToolCall as (c: unknown) => void)(scripted.toolCall);
      if (scripted.toolResult) (input.onToolResult as (r: unknown) => void)(scripted.toolResult);
      (input.onStepEnd as (s: number) => void)(step + 1);
      // A failure raised AFTER the step boundary — i.e. after the guard has
      // taken its verdict. Models adapter teardown blowing up in the same
      // window as the abort.
      if (scripted.throwAfterStepEnd !== undefined) throw scripted.throwAfterStepEnd;
      // No tool call this step ⇒ the turn is finished, exactly as adapters do.
      if (!scripted.toolCall) break;
    }
  }),
}));

import { runAssistantTurn } from "../runtime";
import { buildCinatraAssistantRuntimeConfig } from "../cinatra-assistant-config";
import {
  ASSISTANT_RUN_FAILED_CODE,
  DEFAULT_NO_PROGRESS_REPEAT_LIMIT,
  TURN_STOPPED_NO_PROGRESS_CODE,
} from "../ports";

function makeArgs(
  send: (event: string, data: unknown) => void,
  extra: Record<string, unknown> = {},
) {
  return {
    messages: [{ role: "user" as const, content: "hi" }],
    actorContext: { actorType: "user", userId: "u1" } as never,
    userId: "u1",
    platformRole: "member" as const,
    sessionOrgId: null,
    send,
    turnIdentity: { turnId: "turn-2580", runId: "run-2580" },
    ...extra,
  };
}

/** The stalled shape: the same dead tool round-trip, forever, no text. */
const STALLED_STEP = (step: number) => ({
  toolCall: { id: `call-${step}`, name: "agent_list", arguments: { limit: 10 } },
  toolResult: { id: `call-${step}`, name: "agent_list", result: "" },
});

function terminalFrames(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls.filter(
    ([event]) => event === "error" || event === "done",
  ) as Array<[string, { message?: string; code?: string }]>;
}

beforeEach(() => {
  capturedStreamInput = null;
  stepsRun = 0;
  stepScript = () => ({});
  onAbort = "report-then-resolve";
});

describe("cinatra#2580 — a stalled turn stops instead of re-billing the ceiling", () => {
  it("runs 4 provider steps, not the 24-round ceiling", async () => {
    stepScript = STALLED_STEP;
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    // The ceiling the envelope still ASKS for is unchanged — the guard cuts the
    // loop from the runtime side, without touching the request.
    expect(capturedStreamInput!.maxSteps).toBe(24);
    expect(stepsRun).toBe(DEFAULT_NO_PROGRESS_REPEAT_LIMIT);
  });

  it("emits EXACTLY ONE terminal frame — the stop, never a trailing `done`", async () => {
    stepScript = STALLED_STEP;
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    const frames = terminalFrames(send);
    expect(frames).toHaveLength(1);
    expect(frames[0][0]).toBe("error");
    expect(frames[0][1].code).toBe(TURN_STOPPED_NO_PROGRESS_CODE);
    expect(frames[0][1].message).toContain("agent_list");
  });

  it("emits exactly one terminal frame when the adapter aborts SILENTLY too", async () => {
    // The other shipped abort behavior: break the step loop, resolve, report
    // nothing. Without the post-stream branch this turn would end on `done`
    // with no explanation for the truncated answer.
    onAbort = "break-silently";
    stepScript = STALLED_STEP;
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    const frames = terminalFrames(send);
    expect(frames).toHaveLength(1);
    expect(frames[0][1].code).toBe(TURN_STOPPED_NO_PROGRESS_CODE);
  });

  it("keeps the partial output the user already saw, and text restarts the count", async () => {
    // The loop stalls on one dead call, but the model narrates once on step 1.
    // That text is real progress, so the streak restarts from that step's
    // result and the stop needs a fresh full run of identical rounds after it.
    stepScript = (step) =>
      step === 1
        ? { text: "Looking that up…", ...STALLED_STEP(step) }
        : STALLED_STEP(step);
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    expect(send).toHaveBeenCalledWith("text", { content: "Looking that up…" });
    // Step 0 counts; step 1 emitted text so it is DISQUALIFIED and breaks the
    // streak; steps 2..5 are the fresh streak that reaches the limit.
    expect(stepsRun).toBe(2 + DEFAULT_NO_PROGRESS_REPEAT_LIMIT);
  });
});

describe("cinatra#2580 — a progressing turn is untouched", () => {
  it("a plain text answer still ends on `done` with no error frame", async () => {
    stepScript = () => ({ text: "Hello" });
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    expect(send).toHaveBeenCalledWith("text", { content: "Hello" });
    expect(terminalFrames(send)).toEqual([["done", {}]]);
    expect(stepsRun).toBe(1);
  });

  it("a long multi-tool turn runs to completion — the guard never fires", async () => {
    const calls = [
      "crm_account_search",
      "crm_account_get",
      "crm_contact_search",
      "crm_contact_get",
      "objects_list",
      "projects_list",
    ];
    stepScript = (step) =>
      step < calls.length
        ? {
            toolCall: { id: `c${step}`, name: calls[step], arguments: { step } },
            toolResult: { id: `c${step}`, name: calls[step], result: `[{"i":${step}}]` },
          }
        : { text: "Here is the summary." };
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    expect(stepsRun).toBe(calls.length + 1);
    expect(terminalFrames(send)).toEqual([["done", {}]]);
  });

  it("polling one tool for a BYTE-IDENTICAL payload is never a stop", async () => {
    // The false-positive case a pure identical-result predicate would hit: the
    // poll returns exactly the same payload until it flips.
    const rounds = 10;
    stepScript = (step) =>
      step < rounds
        ? {
            toolCall: { id: `c${step}`, name: "agent_run_get", arguments: { id: "r1" } },
            toolResult: {
              id: `c${step}`,
              name: "agent_run_get",
              result: '{"status":"running"}',
            },
          }
        : { text: "The run finished." };
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    expect(stepsRun).toBe(rounds + 1);
    expect(terminalFrames(send)).toEqual([["done", {}]]);
  });

  it("repeated EMPTY RESULT SETS are answers, not a stall", async () => {
    const rounds = 8;
    stepScript = (step) =>
      step < rounds
        ? {
            toolCall: { id: `c${step}`, name: "objects_list", arguments: { type: "note" } },
            toolResult: { id: `c${step}`, name: "objects_list", result: "[]" },
          }
        : { text: "Nothing found." };
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    expect(stepsRun).toBe(rounds + 1);
    expect(terminalFrames(send)).toEqual([["done", {}]]);
  });
});

describe("cinatra#2580 — the pre-existing failure paths still behave", () => {
  it("a caller abort still ends the turn without a no-progress label", async () => {
    const caller = new AbortController();
    caller.abort();
    stepScript = STALLED_STEP;
    const send = vi.fn();
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      makeArgs(send, { signal: caller.signal }),
    );

    // The composed signal is already aborted, so no step ever opens.
    expect(stepsRun).toBe(0);
    const frames = terminalFrames(send);
    // UNCHANGED pre-existing shape: an adapter that reports through `onError`
    // and then resolves produces `error` followed by `done`, and the sink
    // treats the first terminal as final. This PR deliberately does not alter
    // that for any non-guard failure — only the guard's own stop suppresses
    // the trailing `done`.
    expect(frames.map(([event]) => event)).toEqual(["error", "done"]);
    expect(frames[0][1].code).not.toBe(TURN_STOPPED_NO_PROGRESS_CODE);
  });

  it("a caller signal is still composed — an un-aborted one runs the turn normally", async () => {
    const caller = new AbortController();
    stepScript = () => ({ text: "Hello" });
    const send = vi.fn();
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      makeArgs(send, { signal: caller.signal }),
    );

    expect(terminalFrames(send)).toEqual([["done", {}]]);
    expect((capturedStreamInput!.signal as AbortSignal).aborted).toBe(false);
  });

  it("a genuine provider error still classifies normally, not as a cost stop", async () => {
    stepScript = (step) => (step === 0 ? { error: new Error("provider exploded") } : {});
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    const frames = terminalFrames(send);
    expect(frames[0][0]).toBe("error");
    expect(frames[0][1].code).toBe(ASSISTANT_RUN_FAILED_CODE);
    expect(frames[0][1].message).toContain("provider exploded");
  });

  it("a NON-abort throw landing after the verdict is CARRIED, never swallowed", async () => {
    // The guard has already tripped (the verdict is taken at the step
    // boundary) and the adapter THEN blows up for an unrelated reason. The
    // stop leads — it is the runtime's own decision and the actionable fact —
    // but the adapter's error must still reach the user in the same frame.
    stepScript = (step) =>
      step === DEFAULT_NO_PROGRESS_REPEAT_LIMIT - 1
        ? { ...STALLED_STEP(step), throwAfterStepEnd: new Error("adapter teardown exploded") }
        : STALLED_STEP(step);
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    const frames = terminalFrames(send);
    expect(frames).toHaveLength(1);
    expect(frames[0][1].code).toBe(TURN_STOPPED_NO_PROGRESS_CODE);
    expect(frames[0][1].message).toContain("agent_list");
    expect(frames[0][1].message).toContain("adapter teardown exploded");
  });

  it("the stop's OWN abort adds no noise — no 'also reported' tail", async () => {
    // When the throw IS the sentinel this runtime raised, there is no second
    // fact to report, so the frame stays the plain stop message.
    stepScript = STALLED_STEP;
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    const frames = terminalFrames(send);
    expect(frames).toHaveLength(1);
    expect(frames[0][1].code).toBe(TURN_STOPPED_NO_PROGRESS_CODE);
    expect(frames[0][1].message).not.toContain("also reported");
  });
});

describe("cinatra#2580 — the request envelope is unchanged", () => {
  it("carries the same system assembly, tool array and flags as before the guard", async () => {
    stepScript = () => ({ text: "Hello" });
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    const system = capturedStreamInput!.system as string;
    expect(system.startsWith(SYSTEM_BODY)).toBe(true);
    expect(system).toContain("\n\nUser context:\n");
    // cinatra#2771 lever 2 — the confirmation policy moved from LAST into the
    // stable head, ahead of the volatile user context. Same fragments, new
    // order, so the head is reusable across turns.
    expect(system).toContain(CONFIRMATION_POLICY);
    expect(system.indexOf(CONFIRMATION_POLICY)).toBeLessThan(
      system.indexOf("\n\nUser context:\n"),
    );

    const tools = capturedStreamInput!.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(3);
    expect(tools[0]).toMatchObject({ type: "mcp", name: "cinatra" });
    expect(tools.some((t) => t.name === "shell")).toBe(true);
    expect(tools.some((t) => t.type === "web_search")).toBe(true);

    expect(capturedStreamInput!.maxSteps).toBe(24);
    expect(capturedStreamInput!.skipMcpInjection).toBe(true);
    expect(capturedStreamInput!.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("adds no new field to the `stream()` input — the guard rides the existing signal", async () => {
    stepScript = () => ({ text: "Hello" });
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    // The pre-guard field set, verbatim. A new envelope field would be a
    // request change and would fail here. `signal` is still an `AbortSignal`
    // and still composed — a third source joined the composition, so the
    // OBJECT differs from what the old code built while the field, its type
    // and its un-aborted state are unchanged (asserted in the caller-signal
    // arm above). Nothing about it reaches the provider's request body.
    expect(Object.keys(capturedStreamInput!).sort()).toEqual(
      [
        "actorContext",
        // cinatra#2776 — the ONE field added since: the native-MCP requirement
        // the self-MCP toolbox is dispatched under. It rides beside
        // `skipMcpInjection` and is absent on a conversation-only turn.
        "capabilityRequired",
        "logLabel",
        "maxSteps",
        "messages",
        "onCitations",
        "onError",
        "onStepEnd",
        "onStepStart",
        "onTextDelta",
        "onToolCall",
        "onToolResult",
        "provider",
        "signal",
        "skipMcpInjection",
        "system",
        "tools",
      ].sort(),
    );
  });
});
