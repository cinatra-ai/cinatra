import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  resolveRequestRunContext,
  requireRunProducerBinding,
  type DelegatedMcpActor,
  type DurableRunContextResolution,
  type McpRequestContext,
} from "../request-context";

// ---------------------------------------------------------------------------
// cinatra#3745 — the tool server's request frame carries the verified step of
// the calling run step as `verifiedStepId`.
//
// The step reaches the frame only through the channel that served the run id:
// the on-behalf-of actor's signed `stp` claim (surfaced as the actor's
// `verifiedStepId`), else the durable binding's `stepId`. A header, a tool
// argument or a body field that names a step is not an input of the frame.
//
// REAL: `resolveRequestRunContext`. STAND-IN: `index.tsx` is not importable in
// this package's sandbox (the same reason meta-claims-cannot-override-authz
// composes its frame by hand), so `composeFrame` below mirrors the transport's
// run-context and frame composition, and the source assertions bind it to the
// real boundary.
// ---------------------------------------------------------------------------

const RUN = "run-alpha-1";
const STEP = "step-node-1";

const AGENT_RUN_ACTOR = {
  delegation: "agent_run",
  userId: "usr-alpha",
  orgId: "org-alpha",
  runId: RUN,
  platformRole: "member",
  oboCeiling: [{ tier: "organization", id: "org-alpha" }],
} as DelegatedMcpActor;

type ResolveInput = Parameters<typeof resolveRequestRunContext>[0] & {
  delegatedStepId?: string;
};
const resolve = resolveRequestRunContext as unknown as (
  input: ResolveInput,
) => ReturnType<typeof resolveRequestRunContext> & { stepId?: string };

function composeFrame(input: {
  request: Request;
  actor: DelegatedMcpActor | null;
  durable?: DurableRunContextResolution;
  toolArguments?: Record<string, unknown>;
}): McpRequestContext {
  const actor = input.actor as (DelegatedMcpActor & { verifiedStepId?: string }) | null;
  const runContext = resolve({
    delegatedRunId: actor?.delegation === "agent_run" ? actor.runId : undefined,
    delegatedStepId: actor?.delegation === "agent_run" ? actor.verifiedStepId : undefined,
    durable: input.durable,
    headerRunId: input.request.headers.get("x-cinatra-run-id") ?? undefined,
    headerAgentId: input.request.headers.get("x-cinatra-agent-id") ?? undefined,
    failClosed: true,
  });
  return {
    orgId: actor?.orgId ?? null,
    userId: actor?.userId ?? null,
    runId: runContext.runId,
    agentId: runContext.agentId,
    delegatedActor: actor,
    verifiedStepId: runContext.stepId,
  } as McpRequestContext;
}

function frameStep(frame: McpRequestContext): unknown {
  return (frame as { verifiedStepId?: unknown }).verifiedStepId;
}

const source = readFileSync(new URL("../index.tsx", import.meta.url), "utf8");

function frameLiteral(): string {
  const start = source.indexOf("const requestStore: McpRequestContext = {");
  expect(start, "the request-frame literal moved or was renamed").toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("the request-frame literal is not brace-balanced");
}

function resolverCall(): string {
  const start = source.indexOf("const runContext = resolveRequestRunContext({");
  expect(start, "the run-context resolution moved or was renamed").toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("});", start) + 3);
}

describe("the frame's verified step", () => {
  // (f1)
  it("a delegated agent-run actor's verified step reaches the frame", () => {
    const actor = { ...AGENT_RUN_ACTOR, verifiedStepId: STEP } as DelegatedMcpActor;
    const resolved = resolve({ delegatedRunId: RUN, delegatedStepId: STEP });
    expect(resolved.runId).toBe(RUN);
    expect(resolved.servedBy).toBe("obo");
    expect(resolved.stepId).toBe(STEP);
    const frame = composeFrame({ request: new Request("https://example.test/api/mcp"), actor });
    expect(frameStep(frame)).toBe(STEP);
    // The real boundary hands the delegated actor's step to the resolver and
    // stamps the frame from the resolver's answer.
    expect(resolverCall()).toContain(
      'delegatedStepId: delegatedActor?.delegation === "agent_run" ? delegatedActor.verifiedStepId : undefined',
    );
    expect(frameLiteral()).toContain("verifiedStepId: runContext.stepId,");
  });

  // (f2)
  it("a durable resolution's step reaches the frame of a machine bearer", () => {
    const durable = {
      outcome: "resolved",
      ctx: { runId: RUN, agentId: "agent-1", stepId: STEP },
    } as DurableRunContextResolution;
    const resolved = resolve({ durable });
    expect(resolved.servedBy).toBe("durable");
    expect(resolved.stepId).toBe(STEP);
    const frame = composeFrame({
      request: new Request("https://example.test/api/mcp"),
      actor: null,
      durable,
    });
    expect(frameStep(frame)).toBe(STEP);
    expect(frameLiteral()).toContain("verifiedStepId: runContext.stepId,");
  });

  // (f3)
  it("a step named in headers or tool arguments without a verified channel leaves the frame without a step", () => {
    const request = new Request("https://example.test/api/mcp", {
      headers: {
        "x-cinatra-step-node": "step-from-header",
        "x-cinatra-step-id": "step-from-header",
        "x-cinatra-step-attestation": "s1:1:00",
        "x-cinatra-run-id": RUN,
      },
    });
    for (const actor of [null, { ...AGENT_RUN_ACTOR, delegation: "chat", orgId: "org-alpha" } as DelegatedMcpActor]) {
      const frame = composeFrame({
        request,
        actor,
        toolArguments: { stepId: "step-from-argument", verifiedStepId: "step-from-argument" },
      });
      expect(frameStep(frame)).toBeUndefined();
      expect(frame.runId).toBeUndefined();
    }
    // The real boundary reads no step header anywhere.
    expect(source).not.toMatch(/x-cinatra-step/i);
  });

  // (f4)
  it("the resolver never answers a step without a verified run id", () => {
    const cases: ResolveInput[] = [
      { delegatedStepId: STEP },
      { delegatedRunId: "", delegatedStepId: STEP },
      { delegatedStepId: STEP, headerRunId: RUN },
      { delegatedStepId: STEP, headerRunId: RUN, failClosed: true },
      {
        durable: { outcome: "resolved", ctx: { runId: "", stepId: STEP } } as DurableRunContextResolution,
      },
      { durable: { outcome: "invalid" }, delegatedStepId: STEP },
      { durable: { outcome: "absent" }, headerRunId: RUN },
    ];
    for (const input of cases) {
      const resolved = resolve(input);
      expect(resolved.stepId).toBeUndefined();
    }
    // A step rides with the run id of the SAME channel: an on-behalf-of run id
    // never picks up a durable binding's step.
    const mixed = resolve({
      delegatedRunId: RUN,
      durable: { outcome: "resolved", ctx: { runId: "run-other", stepId: STEP } } as DurableRunContextResolution,
    });
    expect(mixed.runId).toBe(RUN);
    expect(mixed.stepId).toBeUndefined();
  });
});

const producerInputsJson = '{"note":"draft the reviewed story","topic":"Launch"}';
const producerHash = (s: string) => createHash("sha256").update(s).digest("hex");
const productionBinding = { version: 2 as const, producerKind: "llm" as const, producerStepId: "step-node-1", noteInputPath: "note", sourceSha256: "a".repeat(64), graphSha256: "b".repeat(64), effectiveInputsJson: producerInputsJson, effectiveInputsSha256: producerHash(producerInputsJson), inputParams: JSON.parse(producerInputsJson), inputParamsSha256: producerHash(producerInputsJson) };

describe("production binding uses only the authenticated run-serving frame", () => {
  it("OBO wins with its own production claim and cannot borrow a durable claim", () => {
    const result=resolveRequestRunContext({delegatedRunId:RUN,delegatedStepId:"step-node-1",delegatedProducerBinding:productionBinding,durable:{outcome:"resolved",ctx:{runId:"other",stepId:"step-node-1",verifiedProducerBinding:{...productionBinding,graphSha256:"c".repeat(64)}}}});
    expect(result.verifiedProducerBinding).toEqual(productionBinding);
    expect(requireRunProducerBinding(result,"b".repeat(64))).toEqual({ok:true,binding:productionBinding});
    const missing=resolveRequestRunContext({delegatedRunId:RUN,delegatedStepId:"step-node-1",durable:{outcome:"resolved",ctx:{runId:"other",stepId:"step-node-1",verifiedProducerBinding:productionBinding}}});
    expect(requireRunProducerBinding(missing,"b".repeat(64))).toEqual({ok:false,reason:"missing_producer_binding"});
  });
  it("authenticated durable fallback carries claim; wrong recorded graph pin refuses replay", () => {
    const result=resolveRequestRunContext({durable:{outcome:"resolved",ctx:{runId:RUN,stepId:"step-node-1",verifiedProducerBinding:productionBinding}}});
    expect(requireRunProducerBinding(result,"b".repeat(64)).ok).toBe(true);
    expect(requireRunProducerBinding(result,"c".repeat(64))).toEqual({ok:false,reason:"wrong_graph_pin"});
  });
  it("missing, v1, tampered and orphan claims never permit replay or recover from headers", () => {
    const missing=resolveRequestRunContext({delegatedRunId:RUN,delegatedStepId:"step-node-1"});
    expect(requireRunProducerBinding(missing,"b".repeat(64)).ok).toBe(false);
    for(const delegatedProducerBinding of [{...productionBinding,version:1},{...productionBinding,inputParamsSha256:"c".repeat(64)}]) {
      const result=resolveRequestRunContext({delegatedRunId:RUN,delegatedStepId:"step-node-1",delegatedProducerBinding} as never);
      expect(requireRunProducerBinding(result,"b".repeat(64)).ok).toBe(false);
    }
    const orphan=resolveRequestRunContext({delegatedProducerBinding:productionBinding,headerRunId:RUN,failClosed:true});
    expect(requireRunProducerBinding(orphan,"b".repeat(64)).ok).toBe(false);
    expect(orphan.denied).toBe(true);
  });
  it("real transport call and frame explicitly thread only the authenticated binding", () => {
    expect(resolverCall()).toContain('delegatedProducerBinding: delegatedActor?.delegation === "agent_run" ? delegatedActor.verifiedProducerBinding : undefined');
    expect(frameLiteral()).toContain('verifiedProducerBinding: runContext.verifiedProducerBinding');
  });
});
