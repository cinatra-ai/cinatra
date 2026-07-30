// Integration test: a fabricating CHAT TURN is caught (cinatra#2175, AC1).
//
// Drives the REAL `runAssistantTurn` with the execution plane wired (rollout
// flag on, executor registered, an attributable org+user) and asserts what the
// SSE sink receives. Only the runtime's leaf dependencies are stubbed — the
// binding resolution, the executor wrapping, the text accumulation and the
// end-of-turn provenance verdict all run for real.
//
// The turn under test is the live one from the epic's walk: the model was
// handed the capability, answered a "use the sandbox execution tool" request
// with prose shaped like captured stdout, and never called the tool. Before
// this guard the transcript was indistinguishable from a real run.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SYSTEM_BODY = "SYSTEM_PROMPT_BODY";

// --- the turn the mocked provider will produce -----------------------------
let streamBehaviour: (input: Record<string, unknown>) => Promise<void> | void =
  async () => {};

vi.mock("@/lib/register-host-connector-services", () => ({}));
vi.mock("@/app/api/chat/explicit-dispatch", () => ({
  detectExplicitDispatchDirective: () => "",
  detectExplicitDispatchPackage: () => null,
}));
vi.mock("@/app/api/chat/explicit-dispatch-server", () => ({
  serverSideExplicitDispatch: vi.fn(),
}));
vi.mock("@/app/api/chat/chat-user-context", () => ({
  buildChatUserContextSections: vi.fn(async () => []),
}));
vi.mock("@/app/api/chat/extension-confirmation", () => ({
  buildExtensionImplementationConfirmationPolicy: () => "",
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
vi.mock("@/lib/chat-mcp-actor-token", () => ({
  issueChatMcpActorToken: vi.fn(),
}));
vi.mock("@/lib/instance-identity-store", () => ({
  readInstanceIdentity: () => null,
}));
vi.mock("@/lib/artifacts/attachment-resolver-ports", () => ({
  buildAttachmentResolverPorts: vi.fn(() => ({})),
}));
vi.mock("@cinatra-ai/llm", () => ({
  hasConfiguredLlmRuntime: vi.fn(async () => true),
  checkPublicMcpReachability: vi.fn(async () => ({
    status: "reachable",
    url: "https://mcp.example.test/api/mcp",
  })),
  // S6 exact binding (cinatra#2093): the runtime resolves the STORED provider
  // through `resolveBoundDefaultAdapter`, which THROWS a named error instead of
  // returning null so an unavailable stored provider is a VISIBLE failure.
  resolveDefaultAdapter: vi.fn(async () => ({
    provider: "openai",
    defaultModel: "gpt-4o",
  })),
  resolveBoundDefaultAdapter: vi.fn(async () => ({
    provider: "openai",
    defaultModel: "gpt-4o",
  })),
  BoundDefaultProviderUnavailableError: class BoundDefaultProviderUnavailableError extends Error {},
  // cinatra#2091 S4: the runtime routes skill delivery through the provider
  // seam (and, on an inline-mechanism provider, through core expansion) instead
  // of calling buildSkillTools directly.
  selectSkillDeliveryAdapter: vi.fn(() => ({
    provider: "openai",
    // A REALISTIC OpenAI delivery (cinatra#2094 F11). This stub used to return
    // no vehicle at all, which the real adapter never does for a turn whose
    // injection contract resolved skills: a skills-without-execution OpenAI
    // request mounts the restricted NAMED `skill_file_read` function tool
    // (exec-plane S2's singular-native-shell rule, cinatra#1707). Since a
    // no-vehicle delivery is now REFUSED outright — a silently skill-less
    // assistant is never an acceptable degrade — the old empty stub made every
    // turn in this file abort before reaching the execution-provenance
    // behaviour under test. The vehicle is incidental here; only its presence
    // matters.
    deliver: vi.fn(async () => ({
      tools: [{ type: "function", name: "skill_file_read" }],
      systemContext: "",
      exposure: [],
    })),
  })),
  deliverInjectedSkillsInline: vi.fn(async () => ({
    systemContext: "",
    exposure: [],
    dropped: [],
  })),
  resolveChatExternalMcpTools: vi.fn(async () => []),
  buildLlmMcpServerToolForChat: vi.fn(async () => ({
    type: "mcp",
    name: "cinatra",
    serverLabel: "cinatra",
  })),
  stream: vi.fn(async (input: Record<string, unknown>) => {
    await streamBehaviour(input);
  }),
}));

import { runAssistantTurn } from "../runtime";
import { buildCinatraAssistantRuntimeConfig } from "../cinatra-assistant-config";
import {
  _resetExecutionExecutorFactoryForTests,
  registerExecutionExecutorFactory,
} from "@/lib/execution/execution-executor-slot";
import { EXECUTION_PROVENANCE_UNVERIFIED_NOTICE } from "@cinatra-ai/llm/execution-plane";

/** The fabricated reply, verbatim in shape (wrong digest and all). */
const FABRICATED = [
  "I ran the one-liner in the sandbox with python3. Here is its literal stdout:",
  "MARKER-AC2-S8",
  "Linux",
  "e267b434c8c3cf8e4f5ac5f037d2512f43a1fa7982f695524a7cc356b6f813c2",
];

function emit(input: Record<string, unknown>, lines: string[]) {
  const onTextDelta = input.onTextDelta as (d: string) => void;
  for (const line of lines) onTextDelta(line + "\n");
}

function makeArgs(send: (event: string, data: unknown) => void) {
  return {
    messages: [
      {
        role: "user" as const,
        content:
          "Use the sandbox execution tool to run this and paste its literal stdout.",
      },
    ],
    actorContext: { actorType: "user", userId: "u1" } as never,
    userId: "u1",
    platformRole: "member" as const,
    sessionOrgId: "org-1",
    send,
  };
}

/** Every `text` payload the sink received, concatenated. */
function transcript(send: ReturnType<typeof vi.fn>): string {
  return send.mock.calls
    .filter((c) => c[0] === "text")
    .map((c) => (c[1] as { content: string }).content)
    .join("");
}

const priorRollout = process.env.CINATRA_EXECUTION_PLANE_ROLLOUT;

beforeEach(() => {
  _resetExecutionExecutorFactoryForTests();
  process.env.CINATRA_EXECUTION_PLANE_ROLLOUT = "on";
  streamBehaviour = async () => {};
});

afterEach(() => {
  _resetExecutionExecutorFactoryForTests();
  if (priorRollout === undefined) {
    delete process.env.CINATRA_EXECUTION_PLANE_ROLLOUT;
  } else {
    process.env.CINATRA_EXECUTION_PLANE_ROLLOUT = priorRollout;
  }
});

describe("a chat turn that fabricates execution output is CAUGHT", () => {
  it("capability offered, nothing dispatched: the transcript carries the unverified marker", async () => {
    registerExecutionExecutorFactory(() => async () => []);
    streamBehaviour = async (input) => emit(input, FABRICATED);

    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    const text = transcript(send);
    // The model's own words are untouched...
    expect(text).toContain("MARKER-AC2-S8");
    // ...and the marker is appended after them, before the terminal.
    expect(text).toContain(EXECUTION_PROVENANCE_UNVERIFIED_NOTICE.trim());
    expect(text.indexOf("MARKER-AC2-S8")).toBeLessThan(
      text.indexOf("Unverified execution claim"),
    );
    expect(send).toHaveBeenCalledWith("done", {});
  });

  it("the capability really was offered on that turn (session + executor reached stream)", async () => {
    registerExecutionExecutorFactory(() => async () => []);
    let captured: Record<string, unknown> | null = null;
    streamBehaviour = async (input) => {
      captured = input;
      emit(input, FABRICATED);
    };

    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      makeArgs(vi.fn()),
    );
    expect(captured).not.toBeNull();
    expect(captured!.executionSession).toEqual({
      orgId: "org-1",
      userId: "u1",
      surface: "chat",
    });
    expect(typeof captured!.executionExecutor).toBe("function");
  });
});

describe("a turn that ACTUALLY executed is left alone", () => {
  it("the same prose passes unmarked once a dispatch reached a sandbox", async () => {
    const executed: string[][] = [];
    registerExecutionExecutorFactory(
      () =>
        async (call: { commands: string[] }) => {
          executed.push(call.commands);
          return [
            { stdout: "1", stderr: "", outcome: { type: "exit", exitCode: 0 } },
          ] as never;
        },
    );
    streamBehaviour = async (input) => {
      // The model calls the tool, exactly as the injected capability intends.
      await (
        input.executionExecutor as (c: {
          sessionCarrier: string;
          commands: string[];
        }) => Promise<unknown>
      )({ sessionCarrier: "v1.x.y", commands: ["python3 -c 'print(1)'"] });
      emit(input, FABRICATED);
    };

    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    expect(executed).toEqual([["python3 -c 'print(1)'"]]);
    expect(transcript(send)).not.toContain("Unverified execution claim");
    expect(send).toHaveBeenCalledWith("done", {});
  });
});

describe("a dispatch the PLANE REFUSED does not back the claim (codex round)", () => {
  it("refused open: the executor resolved, nothing ran, the turn is still marked", async () => {
    // The broker executor returns refusals as ordinary non-zero-exit outputs.
    // A guard that counted "the executor resolved" would call this verified.
    registerExecutionExecutorFactory(() => async () => [
      {
        stdout: "",
        stderr: "The execution plane refused to open a job - queue_saturated",
        outcome: { type: "exit", exitCode: 126 },
        refusedByPlane: true,
      },
    ] as never);
    streamBehaviour = async (input) => {
      await (
        input.executionExecutor as (c: {
          sessionCarrier: string;
          commands: string[];
        }) => Promise<unknown>
      )({ sessionCarrier: "v1.x.y", commands: ["python3 -c 'print(1)'"] });
      emit(input, FABRICATED);
    };

    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));
    const text = transcript(send);
    expect(text).toContain("Unverified execution claim");
    // ...and with the wording that is TRUE for a refusal: the tool result IS in
    // the transcript, so the no-tool-result marker would be the false claim.
    expect(text).toContain("the execution plane refused a sandbox call");
    expect(text).not.toContain("never called on this turn");
  });
});

describe("a turn that FAILS after fabricating is still marked (codex round)", () => {
  it("the marker precedes the terminal error frame", async () => {
    registerExecutionExecutorFactory(() => async () => []);
    streamBehaviour = async (input) => {
      emit(input, FABRICATED);
      throw new Error("provider timed out");
    };

    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    expect(transcript(send)).toContain("Unverified execution claim");
    const kinds = send.mock.calls.map((c) => c[0]);
    expect(kinds[kinds.length - 1]).toBe("error");
    expect(kinds.lastIndexOf("text")).toBeLessThan(kinds.lastIndexOf("error"));
    expect(kinds).not.toContain("done");
  });

  it("an adapter that reports through onError and RESOLVES is still marked", async () => {
    // `error` is a terminal sink frame — anything sent after it is dropped. An
    // adapter that calls onError and then returns normally would lose the
    // marker if the verdict were only taken after the stream resolved.
    registerExecutionExecutorFactory(() => async () => []);
    streamBehaviour = async (input) => {
      emit(input, FABRICATED);
      (input.onError as (e: Error) => void)(new Error("provider said no"));
    };

    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    expect(transcript(send)).toContain("Unverified execution claim");
    const kinds = send.mock.calls.map((c) => c[0]);
    expect(kinds.lastIndexOf("text")).toBeLessThan(kinds.indexOf("error"));
  });

  it("the marker is emitted at most ONCE per turn", async () => {
    registerExecutionExecutorFactory(() => async () => []);
    streamBehaviour = async (input) => emit(input, FABRICATED);

    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));
    const markers = send.mock.calls.filter(
      (c) =>
        c[0] === "text" &&
        (c[1] as { content: string }).content.includes("Unverified execution claim"),
    );
    expect(markers).toHaveLength(1);
  });
});

describe("a REAL execution stays visible in the transcript", () => {
  // The other half of render-side provenance: a genuine sandbox call must reach
  // the transcript through the tool path, or a verified turn would render
  // exactly like a fabricated one and the marker would be the only difference
  // a reader ever sees. `sandbox_execute` must therefore NOT be suppressed the
  // way the internal `shell` tool is.
  it("sandbox_execute tool_call + tool_result are emitted to the sink, not hidden", async () => {
    registerExecutionExecutorFactory(() => async () => []);
    streamBehaviour = async (input) => {
      (input.onToolCall as (c: Record<string, unknown>) => void)({
        id: "call-1",
        name: "sandbox_execute",
      });
      (input.onToolResult as (r: Record<string, unknown>) => void)({
        id: "call-1",
        name: "sandbox_execute",
        result: "{}",
      });
      emit(input, ["Done."]);
    };

    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    const names = send.mock.calls
      .filter((c) => c[0] === "tool_call" || c[0] === "tool_result")
      .map((c) => [c[0], (c[1] as { name: string }).name]);
    expect(names).toEqual([
      ["tool_call", "sandbox_execute"],
      ["tool_result", "sandbox_execute"],
    ]);
  });
});

describe("the guard is inert outside its case", () => {
  it("plane dark (rollout flag off): the fabricating turn is byte-identical to before", async () => {
    process.env.CINATRA_EXECUTION_PLANE_ROLLOUT = "off";
    registerExecutionExecutorFactory(() => async () => []);
    streamBehaviour = async (input) => emit(input, FABRICATED);

    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));
    expect(transcript(send)).not.toContain("Unverified execution claim");
  });

  it("plane wired but the reply claims nothing: no marker", async () => {
    registerExecutionExecutorFactory(() => async () => []);
    streamBehaviour = async (input) =>
      emit(input, [
        "The 7000th prime is best obtained by sieving.",
        "I can run that for you in the sandbox if you want.",
      ]);

    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));
    expect(transcript(send)).not.toContain("Unverified execution claim");
  });

  it("no attributable org: no session, so no guard (and no capability)", async () => {
    registerExecutionExecutorFactory(() => async () => []);
    streamBehaviour = async (input) => emit(input, FABRICATED);

    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), {
      ...makeArgs(send),
      sessionOrgId: null,
    });
    expect(transcript(send)).not.toContain("Unverified execution claim");
  });
});
