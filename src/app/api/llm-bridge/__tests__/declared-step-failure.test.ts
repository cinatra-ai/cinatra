/**
 * The bridge ends a step FAILED when the step answers a failure it did not
 * list as completed.
 *
 * A bridge step answers a failure in its declared `error` output: an object
 * whose `code` is a non-empty string. Before this change the bridge answered
 * 200 with that output and the run went on as if the step had succeeded — a
 * failed page read went on to file a page snapshot with an empty title. Now
 * the bridge answers 422 `STEP_DECLARED_FAILURE` on such an answer, unless the
 * step's data lists the code in `completed_error_codes`. A success (no error,
 * a null error, an empty code) and every non-object answer pass unchanged.
 *
 * The model is stood in for at the executor seam the scripted-provider suite
 * uses (`scripted-provider-bridge.test.ts`): a test sets the model's answer;
 * with none set, the real scripted completion answers — which is how the last
 * arm proves a scripted run of a step declaring an `error` output still ends
 * completed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const modelAnswer = vi.hoisted(() => ({
  text: null as string | null,
  // The general-path skill rank-and-truncate note the executor may return.
  skillSelection: null as { droppedSkillIds: string[]; selectionReason: string } | null,
}));

vi.mock("server-only", () => ({}));

vi.mock("@cinatra-ai/llm", async () => {
  const scripted = await import("@cinatra-ai/llm/scripted-test-provider");
  return {
    // Credential-free stack: NO provider adapter resolves, so the barrel's
    // resolver falls through to its last line — the scripted helper.
    resolveConfiguredLlmRuntime: vi.fn(async () => scripted.resolveScriptedLlmRuntime()),
    runResolvedSkillAwareDeterministicLlmTask: vi.fn(
      async (input: {
        runtime: { provider: string; model: string };
        system?: string;
        user?: string;
        outputSchema?: Record<string, unknown>;
      }) => {
        // The answer a test sets stands in for the model's own words; with
        // none set, the REAL scripted completion answers.
        if (modelAnswer.text !== null) {
          return {
            text: modelAnswer.text,
            status: "completed",
            incompleteReason: null,
            ...(modelAnswer.skillSelection ? { skillSelection: modelAnswer.skillSelection } : {}),
          };
        }
        if (scripted.isScriptedLlmRuntime(input.runtime)) {
          return scripted.runScriptedBridgeCompletion({
            system: input.system,
            user: input.user,
            outputSchema: input.outputSchema,
            model: input.runtime.model,
          });
        }
        // The real executor resolves an adapter here; on this stack there is
        // none, which is what made the scripted path necessary.
        throw new Error("no LLM provider adapter is resolvable");
      },
    ),
    resolveImplicitGlobalProviderOrder: vi.fn(() => ({
      storedProvider: "openai",
      policy: "exact" as const,
      providers: ["openai"],
    })),
    createLocalSkillShellTool: vi.fn(() => null),
    buildLlmMcpServerToolForAgentRun: vi.fn(async () => null),
    buildLlmMcpServerTool: vi.fn(async () => null),
    resolveProviderAdapter: vi.fn(async () => null),
    // No skill shell reaches these tests (createLocalSkillShellTool is null).
    openAiModelSupportsShell: () => false,
    getLlmMcpCredentials: vi.fn(() => null),
    PreferredProviderUnavailableError: class PreferredProviderUnavailableError extends Error {
      requestedProvider: string;
      reason: string;
      constructor(requestedProvider: string, reason: string) {
        super(`Preferred provider ${requestedProvider} unavailable (${reason})`);
        this.requestedProvider = requestedProvider;
        this.reason = reason;
      }
    },
  };
});

vi.mock("@/lib/a2a-auth", () => ({
  verifyLangGraphBridgeToken: vi.fn(async () => ({
    ok: false,
    response: new Response("forbidden", { status: 403 }),
  })),
}));

vi.mock("@cinatra-ai/skills", () => ({
  resolveDeclaredSkillEdgeForExtensionDir: vi.fn(async () => null),
  getCustomSkillForCurrentUserAndAgent: vi.fn(async () => null),
}));

vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: vi.fn(async () => []),
}));

vi.mock("@cinatra-ai/agents", async () => {
  const { z } = await import("zod");
  return {
    readAgentRunByContextId: vi.fn(async () => null),
    readAgentRunById: vi.fn(async () => null),
    readAgentRunByTokenHash: vi.fn(async () => null),
    readAgentRunTokenHashById: vi.fn(async () => null),
    readAgentTemplateById: vi.fn(async () => null),
    publishCallAllowed: async () => true, // cinatra#4150: no publish decision holds this run
    // No step in these tests requires a capability.
    canProviderSatisfyCapability: (): boolean => true,
    describeCapabilityRequirement: () => "capability unavailable",
    OasCinatraLlmSchema: z
      .object({
        preferredProvider: z.string().min(1).optional(),
        preferredModel: z.string().min(1).optional(),
        capabilityRequired: z
          .enum(["media_input", "function_tools", "native_mcp"])
          .optional(),
      })
      .strict()
      .optional(),
    LLM_PROVIDERS: ["openai"] as const,
    LLM_CAPABILITIES: ["media_input", "function_tools", "native_mcp"] as const,
    ALLOWED_MODEL_IDS: { openai: ["scripted-test-model"] },
  };
});

import { UAT_SENTINEL } from "@cinatra-ai/llm/scripted-test-provider";
import { runResolvedSkillAwareDeterministicLlmTask } from "@cinatra-ai/llm";

const BRIDGE_TOKEN = "declared-failure-token-32chars-AAA";

const ORIGINAL_ENV = {
  flag: process.env.CINATRA_TEST_LLM_PROVIDER,
  runtimeMode: process.env.CINATRA_RUNTIME_MODE,
  bridgeToken: process.env.CINATRA_BRIDGE_TOKEN,
};

let POST: (req: Request) => Promise<Response>;

/** One model step's call, as WayFlow performs it for a bridge ApiNode. */
function stepCall(extra: Record<string, unknown> = {}): Request {
  return new Request("http://localhost:3000/api/llm-bridge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatra-bridge-token": BRIDGE_TOKEN,
    },
    body: JSON.stringify({ user: "read the page", agent_id: "page-reader", ...extra }),
  });
}

const READ_OUTPUT_SCHEMA = {
  type: "object",
  required: ["title", "error"],
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    error: {
      type: "object",
      required: ["code", "message"],
      properties: { code: { type: "string" }, message: { type: "string" } },
    },
  },
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  modelAnswer.text = null;
  modelAnswer.skillSelection = null;
  process.env.CINATRA_BRIDGE_TOKEN = BRIDGE_TOKEN;
  process.env.CINATRA_TEST_LLM_PROVIDER = "scripted";
  process.env.CINATRA_RUNTIME_MODE = "development";
  const mod = await import("../route");
  POST = mod.POST;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.CINATRA_TEST_LLM_PROVIDER = ORIGINAL_ENV.flag;
  process.env.CINATRA_RUNTIME_MODE = ORIGINAL_ENV.runtimeMode;
  process.env.CINATRA_BRIDGE_TOKEN = ORIGINAL_ENV.bridgeToken;
  if (ORIGINAL_ENV.flag === undefined) delete process.env.CINATRA_TEST_LLM_PROVIDER;
  if (ORIGINAL_ENV.runtimeMode === undefined) delete process.env.CINATRA_RUNTIME_MODE;
  if (ORIGINAL_ENV.bridgeToken === undefined) delete process.env.CINATRA_BRIDGE_TOKEN;
});

describe("/api/llm-bridge ends a step failed on a failure it answered", () => {
  it("answers 422 STEP_DECLARED_FAILURE on a non-empty error.code the step does not list", async () => {
    modelAnswer.text = JSON.stringify({
      title: "",
      error: { code: "read-failed", message: "The page could not be read." },
    });
    const res = await POST(stepCall());
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "The step answered a failure",
      code: "STEP_DECLARED_FAILURE",
      stepErrorCode: "read-failed",
    });
  });

  it("answers the code when the failure carries no message", async () => {
    modelAnswer.text = JSON.stringify({ error: { code: "call_failed" } });
    const res = await POST(stepCall({ completed_error_codes: ["reread_failed"] }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "The step answered a failure",
      code: "STEP_DECLARED_FAILURE",
      stepErrorCode: "call_failed",
    });
  });

  it("passes the answer on unchanged when the step lists the code as completed", async () => {
    const answer = {
      proposalId: "wp-42-k3f9qz",
      changes: [],
      error: { code: "reread_failed", message: "The update was saved but could not be re-read." },
    };
    modelAnswer.text = JSON.stringify(answer);
    const res = await POST(stepCall({ completed_error_codes: ["reread_failed"] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
  });

  it.each([
    ["no error output", { title: "Home" }],
    ["a null error", { title: "Home", error: null }],
    ["an empty code", { title: "Home", error: { code: "", message: "" } }],
    ["a blank code", { title: "Home", error: { code: "  ", message: "" } }],
    ["a code that is not a string", { title: "Home", error: { code: 404 } }],
    ["an error that is a string", { title: "Home", error: "read-failed" }],
    ["an error nested in another output", { page: { error: { code: "read-failed" } } }],
    ["an error that is a list", { title: "Home", error: [{ code: "read-failed" }] }],
    ["a code that is an object", { title: "Home", error: { code: { id: "read-failed" } } }],
    ["a code that is null", { title: "Home", error: { code: null, message: "m" } }],
  ])("passes a success on unchanged: %s", async (_label, answer) => {
    modelAnswer.text = JSON.stringify(answer);
    const res = await POST(stepCall());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
  });

  it("passes an answer that is not a JSON object on unchanged", async () => {
    modelAnswer.text = JSON.stringify([{ error: { code: "read-failed" } }]);
    const listRes = await POST(stepCall());
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual([{ error: { code: "read-failed" } }]);

    modelAnswer.text = "The page could not be read.";
    const proseRes = await POST(stepCall());
    expect(proseRes.status).toBe(200);
    expect(await proseRes.json()).toEqual({ output: "The page could not be read." });
  });

  it("refuses a completed_error_codes that is not a list of strings with 400, before any model call", async () => {
    modelAnswer.text = JSON.stringify({ title: "Home" });
    const res = await POST(stepCall({ completed_error_codes: "reread_failed" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Invalid request body");
    expect(vi.mocked(runResolvedSkillAwareDeterministicLlmTask)).not.toHaveBeenCalled();
  });

  it.each([
    ["51 codes (the list holds at most 50)", Array.from({ length: 51 }, (_, i) => `code_${i}`)],
    ["a list with a member that is not a string", ["reread_failed", 404]],
  ])("refuses a completed_error_codes with %s with 400, before any model call", async (_label, codes) => {
    modelAnswer.text = JSON.stringify({ title: "Home" });
    const res = await POST(stepCall({ completed_error_codes: codes }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Invalid request body");
    expect(vi.mocked(runResolvedSkillAwareDeterministicLlmTask)).not.toHaveBeenCalled();
  });

  it("accepts 50 completed codes and passes a listed code on", async () => {
    const answer = { title: "Home", error: { code: "code_49", message: "" } };
    modelAnswer.text = JSON.stringify(answer);
    const codes = Array.from({ length: 50 }, (_, i) => `code_${i}`);
    const res = await POST(stepCall({ completed_error_codes: codes }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
  });

  it("matches a listed code exactly: blanks around the answered code end the step failed", async () => {
    modelAnswer.text = JSON.stringify({ error: { code: " reread_failed ", message: "m" } });
    const res = await POST(stepCall({ completed_error_codes: ["reread_failed"] }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { stepErrorCode?: string };
    expect(body.stepErrorCode).toBe(" reread_failed ");
  });

  it("bounds the code it answers and answers no message", async () => {
    modelAnswer.text = JSON.stringify({
      error: { code: "c".repeat(250), message: `  ${"m".repeat(1500)}  ` },
    });
    const res = await POST(stepCall());
    expect(res.status).toBe(422);
    const body = (await res.json()) as { stepErrorCode?: string };
    expect(body.stepErrorCode).toBe("c".repeat(200));
    expect(body).not.toHaveProperty("message");
  });

  it("answers the 422 as one JSON body whose three members stand in a fixed order", async () => {
    modelAnswer.text = JSON.stringify({
      title: "",
      error: { code: "read-failed", message: "The page could not be read." },
    });
    const res = await POST(stepCall());
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe(
      '{"error":"The step answered a failure","code":"STEP_DECLARED_FAILURE",' +
        '"stepErrorCode":"read-failed"}',
    );
  });

  it("carries no model text in the 422 body: the fixed sentence, the code and the step code only", async () => {
    const said = "MODEL-TEXT-4737 The page could not be read.\nforged line";
    modelAnswer.text = JSON.stringify({ title: said, error: { code: "read-failed", message: said } });
    const res = await POST(stepCall());
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).not.toContain("MODEL-TEXT-4737");
    expect(text).not.toContain("could not be read");
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["error", "code", "stepErrorCode"]);
  });

  it("escapes the step code to one line of printable ASCII, as the runtime loader does", async () => {
    const code = "read-failed\r\n\u001b\u007f\u0085\u2028\u00e9\u{1f600}\"q\\";
    modelAnswer.text = JSON.stringify({ error: { code, message: "m" } });
    const res = await POST(stepCall());
    expect(res.status).toBe(422);
    const body = (await res.json()) as { stepErrorCode?: string };
    expect(body.stepErrorCode).toBe(
      "read-failed\\r\\n\\u001b\\u007f\\u0085\\u2028\\u00e9\\ud83d\\ude00\\\"q\\\\",
    );
    expect(body.stepErrorCode).toMatch(/^[\x20-\x7e]*$/);
  });

  it("names NextResponse only as NextResponse.json(: the failure helper hands back a plain body", () => {
    const src = readFileSync(join(__dirname, "..", "route.ts"), "utf8");
    const other = src
      .split("\n")
      .filter((line) => /\bNextResponse\b/.test(line) && !line.includes("NextResponse.json("));
    // The import is the one other line: no helper is typed as a response and
    // no response travels from a helper to a branch as a value.
    expect(other).toEqual(['import { NextResponse } from "next/server";']);
  });

  it("answers the declared failure at each of the three model branches with NextResponse.json(body, { status: 422 })", () => {
    const src = readFileSync(join(__dirname, "..", "route.ts"), "utf8");
    // The text path, the YouTube link and the fetched file each return the
    // helper's plain body as the 422 answer.
    const answers = src.match(/return NextResponse\.json\(\w+Failure, \{ status: 422 \}\);/g);
    expect(answers).toHaveLength(3);
  });

  it("logs the caller's agent id cut at 120 characters as one JSON-escaped token", async () => {
    modelAnswer.text = JSON.stringify({ error: { code: "read-failed", message: "m" } });
    const forged =
      'page-reader\n[llm-bridge] step answered the error code "ok" (agent=forged)\r\n' +
      "p".repeat(120) +
      "FLOOD".repeat(2000);
    const res = await POST(stepCall({ agent_id: forged }));
    expect(res.status).toBe(422);
    const lines = vi
      .mocked(console.warn)
      .mock.calls.map((call) => String(call[0]))
      .filter((line) => line.includes("step answered the error code"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\r\n]/);
    expect(lines[0]).toContain(`(agent=${JSON.stringify(forged.slice(0, 120))})`);
    expect(lines[0]).not.toContain("FLOOD");
  });

  it.each([
    ["a message that is not a string", 42],
    ["a blank message", "   "],
  ])("answers the code when the failure carries %s", async (_label, message) => {
    modelAnswer.text = JSON.stringify({ error: { code: "read-failed", message } });
    const res = await POST(stepCall());
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "The step answered a failure",
      code: "STEP_DECLARED_FAILURE",
      stepErrorCode: "read-failed",
    });
  });

  it("ends the step failed when the executor also returns a skill selection, without the selection", async () => {
    modelAnswer.skillSelection = { droppedSkillIds: ["skill-9"], selectionReason: "over the cap" };
    modelAnswer.text = JSON.stringify({ title: "", error: { code: "read-failed", message: "m" } });
    const res = await POST(stepCall());
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "The step answered a failure",
      code: "STEP_DECLARED_FAILURE",
      stepErrorCode: "read-failed",
    });
  });

  it("passes a success on with the skill selection the executor returned", async () => {
    const selection = { droppedSkillIds: ["skill-9"], selectionReason: "over the cap" };
    modelAnswer.skillSelection = selection;
    modelAnswer.text = JSON.stringify({ title: "Home", error: { code: "", message: "" } });
    const res = await POST(stepCall());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      title: "Home",
      error: { code: "", message: "" },
      skillSelection: selection,
    });
  });

  it("logs the caller's agent id in the skill-selection warning cut at 120 characters as one JSON-escaped token", async () => {
    const selection = { droppedSkillIds: ["skill-9"], selectionReason: "over the cap" };
    modelAnswer.skillSelection = selection;
    modelAnswer.text = JSON.stringify({ title: "Home", error: { code: "", message: "" } });
    const forged =
      "page-reader\n[llm-bridge] skill rank-and-truncate (agent=forged)\r\n" +
      "p".repeat(120) +
      "FLOOD".repeat(2000);
    const res = await POST(stepCall({ agent_id: forged }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { skillSelection?: unknown }).skillSelection).toEqual(selection);
    const lines = vi
      .mocked(console.warn)
      .mock.calls.map((call) => String(call[0]))
      .filter(
        (line) =>
          line.startsWith("[llm-bridge] general-path ") &&
          line.includes(" skill rank-and-truncate (agent="),
      );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\r\n]/);
    expect(lines[0]).toContain(`(agent=${JSON.stringify(forged.slice(0, 120))}): `);
    expect(lines[0]).not.toContain("FLOOD");
  });

  it("a SCRIPTED run of a step declaring an error output ends completed (empty scripted code)", async () => {
    // No answer set: the real scripted completion answers in the declared shape.
    const res = await POST(stepCall({ output_schema: READ_OUTPUT_SCHEMA }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title?: string; error?: { code?: string } };
    expect(String(body.title)).toContain(UAT_SENTINEL);
    expect(body.error?.code).toBe("");
  });
});
