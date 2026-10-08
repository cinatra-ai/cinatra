import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[], events: [] as string[],
  query: vi.fn(), send: vi.fn(), get: vi.fn(), handle: vi.fn(),
  status: "pending_approval", gate: null as Record<string, unknown> | null,
}));
vi.mock("../db", () => ({
  db: { insert: () => ({ values: async (row: Record<string, unknown>) => {
    ports.events.push("capture"); ports.rows.push(row);
  }}), select: () => ({from: () => ({where: () => ({limit: async () => []})})}) },
  agentBuilderPool: { query: (...args: unknown[]) => ports.query(...args), on: () => {}, listenerCount: () => 1 },
}));
const run = {id:"run-4003", orgId:"org-4003", runBy:"reader", templateId:"template", a2aTaskId:"old-task", a2aContextId:"context"};
vi.mock("../store", async () => ({
  readAgentRunById: async () => ({...run, status:ports.status}),
  readAgentRunByTaskId: async () => ({...run, status:ports.status}),
  readAgentTemplateById: async () => ({packageName:"@cinatra-ai/blog-draft-writer", sourceType:"internal"}),
  readRunCoOwners: async () => [],
  writeHitlPrompt: async (input: never) => (await import("../agent-run-hitl-prompts")).writeHitlPrompt(input),
  transitionRunStatus: async (_id: string, _from: string, to: string) => {ports.status=to;},
}));
vi.mock("../agent-run-serde", () => ({ assertAgentRunDispatchAuthorized: async () => {}, assertAgentRunScopeAuthorized:async()=>{} }));
vi.mock("../resume-run-from-setup-approval", () => ({ resumeRunFromSetupApproval: async () => {} }));
vi.mock("@/lib/background-jobs", () => ({ enqueueBackgroundJob: async () => {}, BACKGROUND_JOB_NAMES:{} }));
vi.mock("@/lib/auth-session", async(orig) => ({...(await orig<Record<string,unknown>>()),resolveOrgRoleForUser:async()=>"member"}));
vi.mock("../wayflow-url", () => ({ resolveWayflowUrl:()=>"http://wayflow.test", createWayflowFetch:()=>globalThis.fetch, WAYFLOW_A2A_TIMEOUT_MS:4000 }));
vi.mock("../wayflow-run-token-carrier", () => ({mintResumeRunTokenMetadata:async()=>({token:"synthetic"})}));
vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient:async()=>({sendTask:ports.send,getTask:ports.get}),
  rememberAnsweredGateSubmission:async()=>{},rememberLatestWayflowGateTask:async()=>{},resolveRunIdByWayflowTaskId:async()=>null,
}));
vi.mock("../execution", () => ({handleWayflowTaskState:(...args:unknown[])=>ports.handle(...args)}));
import { approveReviewTaskInternal } from "../review-task-actions";
const answer = {slotId:"draftContext",resolutionMode:"accumulate",selectedRefs:[]};
const task = (state:string,id="next-task",contextId="context") => ({id,contextId,kind:"task",status:{state}});
async function submit(){return approveReviewTaskInternal("wayflow-old-task","reader",{userResponse:JSON.stringify(answer)});}
beforeEach(()=>{
  vi.clearAllMocks(); ports.rows.length=0;ports.events.length=0;ports.status="pending_approval";
  ports.gate={runId:run.id,reviewTaskId:"wayflow-old-task",xRenderer:"context-selector",inputSchema:{type:"object",properties:{slotId:{type:"string"},resolutionMode:{type:"string"},selectedRefs:{type:"array"}}},values:{slotMeta:{slotId:"draftContext"}},materializedAt:"2026-10-08T00:00:00.000Z"};
  ports.send.mockImplementation(async()=>{ports.events.push("send");return task("input-required");});
  ports.handle.mockImplementation(async()=>{ports.events.push("handle");});
  ports.query.mockImplementation(async(text:string,values:unknown[])=>{
    if(text.startsWith("UPDATE")){ports.events.push("receipt");ports.rows[0].dispatchReceipt=JSON.parse(values[0] as string);}
    if(text.startsWith("SELECT") && text.includes("WHERE run_id = $1 AND review_task_id = $2")) {
      const g=ports.gate;
      return {rows:g ? [{run_id:g.runId,review_task_id:g.reviewTaskId,x_renderer:g.xRenderer,
        input_schema:g.inputSchema,gate_values:g.values,field_name:null,materialized_at:g.materializedAt}] : []};
    }
    return {rows:[]};
  });
});
afterEach(()=>vi.useRealTimers());
describe("Continue retains one capture and gains only successful server-bound history",()=>{
  it("writes its receipt AFTER handling, including an explicitly empty valid answer",async()=>{
    await submit(); expect(ports.events).toEqual(["capture","send","handle","receipt"]);
    expect(ports.rows).toHaveLength(1);expect(ports.rows[0].submittedValues).toEqual(answer);
    expect(ports.rows[0].dispatchReceipt).toEqual(expect.objectContaining({version:1,runId:run.id,orgId:run.orgId,reviewTaskId:"wayflow-old-task",returnedTaskId:"next-task",returnedState:"input-required"}));
  });
  it("waits for accepted async work to park before invoking the handler or recording history",async()=>{
    vi.useFakeTimers();ports.send.mockResolvedValue(task("working"));ports.get.mockResolvedValueOnce(task("working")).mockResolvedValueOnce(task("input-required"));
    const pending=submit();await vi.runAllTimersAsync();await pending;
    expect(ports.get).toHaveBeenCalledTimes(2);expect(ports.get.mock.calls.every(([id])=>id==="next-task")).toBe(true);
    expect(ports.events).toEqual(["capture","handle","receipt"]);
  });
});

import { awaitContinueTaskOutcome } from "../review-task-actions";
import {captureHitlPromptForContinue,writeHitlPrompt,readConfirmedContextGates,continueGateDigest,continueBindingDigest,recordSuccessfulContinue} from "../agent-run-hitl-prompts";

describe("receipt failures cannot turn the pre-send capture into a continued gate",()=>{
  it("the public void and internal UUID capture share the same single insert",async()=>{
    const input={runId:run.id,agentId:"agent",stepKey:"old-task",message:""};
    expect(await writeHitlPrompt(input)).toBeUndefined();
    const id=await captureHitlPromptForContinue(input);
    expect(ports.rows).toHaveLength(2);expect(id).toBe(ports.rows[1].id);
    expect(ports.rows[0].id).not.toBe(id);
  });
  it("does not acknowledge a failed send and never reopens an on-wire gate",async()=>{
    ports.send.mockRejectedValue(new Error("uncertain send"));
    await expect(submit()).rejects.toThrow("uncertain send");
    expect(ports.rows).toHaveLength(1);expect(ports.status).toBe("running");
    expect(ports.handle).not.toHaveBeenCalled();expect(ports.events).not.toContain("receipt");
  });
  it("keeps the captured answer available to the handler/autosave, but refuses receipt on handler failure",async()=>{
    ports.handle.mockImplementation(async()=>{expect(ports.rows[0].submittedValues).toEqual(answer);throw new Error("handler failed");});
    await expect(submit()).rejects.toThrow("handler failed");expect(ports.events).not.toContain("receipt");
  });
  it.each([task("input-required","old-task"),task("failed")])(
    "keeps canonical same-gate and failure handling without confirming Continue %#",async(reply)=>{
      ports.send.mockResolvedValue(reply);await submit();
      expect(ports.handle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({task:reply}));
      expect(ports.events).not.toContain("receipt");
    });
  it.each([
    ["foreign completed context",task("completed","next-task","foreign")],
    ["foreign next-gate context",task("input-required","next-task","foreign")],
    ["unknown state",task("unknown")],
    ["missing state",{id:"next-task",contextId:"context",status:{}}],
    ["missing status",{id:"next-task",contextId:"context"}],
    ["missing task ID",{contextId:"context",status:{state:"completed"}}],
    ["empty task ID",task("completed","")],
    ["blank task ID",task("completed","  ")],
    ["control character task ID",task("completed","bad\nID")],
    ["nonstring task ID",{id:7,contextId:"context",status:{state:"completed"}}],
    ["malformed status",{id:"next-task",contextId:"context",status:"completed"}],
    ["null task",null],
    ["non-task message",{kind:"message",contextId:"context",parts:[]}],
  ])("rejects direct %s BEFORE the canonical run handler",async(_label,reply)=>{
    ports.send.mockResolvedValue(reply);
    await expect(submit()).rejects.toThrow(/Continue (task identity mismatch|outcome is not confirmed)/);
    expect(ports.handle).not.toHaveBeenCalled();expect(ports.events).not.toContain("receipt");
    expect(ports.status).toBe("running");expect(ports.send).toHaveBeenCalledTimes(1);
  });
  it.each([task("completed","new-completion-task"),task("input-required","new-review-task")])(
    "accepts a well-formed direct new task ID in the exact run context %#",async(reply)=>{
      ports.send.mockResolvedValue(reply);await submit();
      expect(ports.handle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({task:reply}));
      expect(ports.events).toEqual(["capture","handle","receipt"]);
      expect(ports.rows[0].dispatchReceipt).toEqual(expect.objectContaining({returnedTaskId:reply.id}));
    });
  it("a failed capture creates no receipt ID while the existing best-effort dispatch behavior survives",async()=>{
    const db=(await import("../db")).db;
    const spy=vi.spyOn(db,"insert").mockImplementationOnce(()=>{throw new Error("capture unavailable");});
    await submit();expect(ports.rows).toEqual([]);expect(ports.handle).toHaveBeenCalledOnce();
    expect(ports.events).not.toContain("receipt");spy.mockRestore();
  });
  it("does not confirm when the exact gate snapshot is missing",async()=>{
    ports.gate=null;await submit();expect(ports.events).not.toContain("receipt");
  });
});
describe("one original deadline and one exact async task/context",()=>{
  it("accepts submitted then working then completion through the existing getTask port",async()=>{
    vi.useFakeTimers();const get=vi.fn().mockResolvedValueOnce(task("working")).mockResolvedValueOnce(task("completed"));
    const pending=awaitContinueTaskOutcome(task("submitted"),{getTask:get},"context",Date.now()+4000);
    await vi.runAllTimersAsync();expect((await pending).status.state).toBe("completed");
    expect(get).toHaveBeenCalledTimes(2);
    for(const [id,options] of get.mock.calls){expect(id).toBe("next-task");expect(options.signal).toBeInstanceOf(AbortSignal);}
  });
  it.each([task("input-required","foreign-task"),task("completed","next-task","foreign-context"),task("unknown")])(
    "refuses drift/unknown state before canonical handler %#",async(reply)=>{
      vi.useFakeTimers();ports.send.mockResolvedValue(task("working"));ports.get.mockResolvedValue(reply);
      const observed=submit().catch(error=>error);await vi.runAllTimersAsync();expect(await observed).toBeInstanceOf(Error);
      expect(ports.handle).not.toHaveBeenCalled();expect(ports.events).not.toContain("receipt");expect(ports.status).toBe("running");
    });
  it("keeps an exact-context async failure on the canonical failure path without a Continue receipt",async()=>{
    vi.useFakeTimers();ports.send.mockResolvedValue(task("working"));ports.get.mockResolvedValue(task("failed"));
    const observed=submit();await vi.runAllTimersAsync();await observed;
    expect(ports.handle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({task:task("failed")}));
    expect(ports.events).not.toContain("receipt");expect(ports.send).toHaveBeenCalledTimes(1);
  });
  it("stops at the original absolute deadline without resetting a budget or leaving an unbounded getTask",async()=>{
    vi.useFakeTimers();const get=vi.fn().mockResolvedValue(task("working"));const deadline=Date.now()+300;
    const observed=awaitContinueTaskOutcome(task("working"),{getTask:get},"context",deadline).catch(error=>error);
    await vi.runAllTimersAsync();expect((await observed).message).toContain("deadline");expect(get).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(deadline);expect(get.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it("a remote read exception stays uncertain and is never redispatched",async()=>{
    vi.useFakeTimers();ports.send.mockResolvedValue(task("working"));ports.get.mockRejectedValue(new Error("read failed"));
    const observed=submit().catch(error=>error);await vi.runAllTimersAsync();expect((await observed).message).toBe("read failed");
    expect(ports.send).toHaveBeenCalledTimes(1);expect(ports.handle).not.toHaveBeenCalled();expect(ports.events).not.toContain("receipt");
  });
});
function storedReading(){
  const gate=ports.gate as never;
  return {step_key:"old-task",submitted_values:answer,review_task_id:"wayflow-old-task",x_renderer:"context-selector",
    input_schema:ports.gate!.inputSchema,gate_values:ports.gate!.values,field_name:null,a2a_context_id:"context",materialized_at:ports.gate!.materializedAt,
    dispatch_receipt:{version:1,runId:run.id,orgId:run.orgId,agentId:"agent",reviewTaskId:"wayflow-old-task",
      contextId:"context",returnedTaskId:"next-task",returnedState:"input-required",materializedAt:ports.gate!.materializedAt,
      schemaDigest:continueGateDigest(gate),answerDigest:continueBindingDigest(answer),acknowledgedAt:"2026-10-08T00:01:00.000Z"}};
}
async function read(rows:unknown[]){return readConfirmedContextGates(run.id,run.orgId,"agent",async<T>()=>rows as T[]);}
describe("exact scoped receipt reading",()=>{
  it("keeps explicit empty context answers and deduplicates only the same task identity",async()=>{
    const record=storedReading();expect(await read([record,record])).toHaveLength(1);
    expect((await read([record]))[0].submittedValues).toEqual(answer);
  });
  it.each(["runId","orgId","agentId","reviewTaskId","materializedAt","schemaDigest","answerDigest"])(
    "refuses a foreign or stale %s binding",async(key)=>{
      const record=storedReading();record.dispatch_receipt={...record.dispatch_receipt,[key]:"foreign"};
      expect(await read([record])).toEqual([]);
    });
  it("same-task same-schema newer materialization rejects the old receipt",async()=>{
    expect(await read([{...storedReading(),materialized_at:"2026-10-08T00:02:00.000Z"}])).toEqual([]);
  });
  it("different renderer rejects an otherwise identical schema/task receipt",async()=>{
    expect(await read([{...storedReading(),x_renderer:"another-renderer"}])).toEqual([]);
  });
  it("null captures and initial values do not become continued answers",async()=>{
    expect(await read([{...storedReading(),submitted_values:null}])).toEqual([]);
    expect(await read([{...storedReading(),dispatch_receipt:null}])).toEqual([]);
  });
  it("a pre-upgrade missing receipt column means empty history, while other failures are not suppressed",async()=>{
    await expect(readConfirmedContextGates(run.id,run.orgId,"agent",async()=>{throw Object.assign(new Error('column dispatch_receipt does not exist'),{code:"42703"});})).resolves.toEqual([]);
    await expect(readConfirmedContextGates(run.id,run.orgId,"agent",async()=>{throw new Error("connection failed");})).rejects.toThrow("connection failed");
  });
  it("conditional write binds original prompt/answer, org and full exact gate materialization",async()=>{
    const record=storedReading();const query=vi.fn(async()=>[]);
    await recordSuccessfulContinue({promptId:"prompt",gate:ports.gate as never,submittedValues:answer,receipt:record.dispatch_receipt as never},query);
    const [sql,values]=query.mock.calls[0] as unknown as [string,unknown[]];
    expect(sql).toContain("p.dispatch_receipt IS NULL");expect(sql).toContain("p.submitted_values = $6::jsonb");
    expect(sql).toContain("r.org_id=$7");expect(sql).toContain("g.x_renderer=$9");expect(sql).toContain("g.materialized_at=$11::timestamptz");
    expect(values.slice(1,5)).toEqual(["prompt",run.id,"agent","old-task"]);
    query.mockClear();await recordSuccessfulContinue({promptId:"prompt",gate:ports.gate as never,submittedValues:{},receipt:record.dispatch_receipt as never},query);
    expect(query).not.toHaveBeenCalled();
  });
});

import {buildCreateStoreSchemaQueries} from "@/lib/drizzle-store";
describe("the existing-table receipt is an additive fresh/upgrade schema change",()=>{
  it("fresh stores declare a nullable receipt with no default or backfill",()=>{
    const queries=buildCreateStoreSchemaQueries("app");
    const create=queries.find(q=>q.text.includes('CREATE TABLE IF NOT EXISTS "app"."agent_run_hitl_prompts"'))!.text;
    expect(create).toContain("dispatch_receipt jsonb,");
    expect(create).not.toMatch(/dispatch_receipt[^,]*(NOT NULL|DEFAULT)/);
  });
  it("existing stores use idempotent ADD COLUMN, never fabricate legacy success",()=>{
    const queries=buildCreateStoreSchemaQueries("app").filter(q=>q.text.includes("dispatch_receipt"));
    expect(queries).toHaveLength(2);
    expect(queries[1].text).toBe('ALTER TABLE "app"."agent_run_hitl_prompts" ADD COLUMN IF NOT EXISTS dispatch_receipt jsonb');
    expect(queries.some(q=>/UPDATE|BACKFILL/i.test(q.text))).toBe(false);
    expect(buildCreateStoreSchemaQueries("app").filter(q=>q.text.includes("dispatch_receipt"))).toEqual(queries);
  });
});
