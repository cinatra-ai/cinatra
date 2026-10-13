import {beforeEach,describe,expect,it,vi} from "vitest";
// The actual policy cursor consumes stored prompt records. Only its session/run
// authorization and persistence ports are mocked; the cursor/predicate stay real.
const ports=vi.hoisted(()=>({session:vi.fn(),run:vi.fn(),prompts:vi.fn()}));
vi.mock("@/lib/auth-session",()=>({requireAuthSession:ports.session}));
vi.mock("../store",()=>({readAgentRunById:ports.run,readAllHitlPromptsForRun:ports.prompts}));
import {buildSubmissionMapByStepIndex} from "../run-actions";
const context={slotId:"draftContext",resolutionMode:"accumulate",selectedRefs:[]};
const policy=[{stepNumber:1,xRenderer:"review"},{stepNumber:2,xRenderer:"review"}];
const steps=[{index:3,stepNumber:1},{index:7,stepNumber:2}];
const row=(stepKey:string,submittedValues:Record<string,unknown>)=>({stepKey,submittedValues,schemaSnapshot:{title:stepKey}});
const reviewA=row("review-A",{decision:"approve-A"});
const reviewB=row("review-B",{decision:"approve-B"});
async function read(rows:unknown[]){ports.prompts.mockResolvedValue(rows);return buildSubmissionMapByStepIndex("run","agent",policy,steps);}
beforeEach(()=>{vi.clearAllMocks();ports.session.mockResolvedValue({user:{id:"reader"}});ports.run.mockResolvedValue({id:"run",orgId:"org"});});
describe("context answers never advance the policy prompt cursor",()=>{
  it("excludes the exact persisted plain envelope before and between policy answers",async()=>{
    const value=await read([row("context-A",context),reviewA,row("context-B",{...context,slotId:"imageContext"}),reviewB]);
    expect(value).toEqual([[3,reviewA],[7,reviewB]]);
  });
  it.each([
    {userResponse:JSON.stringify(context)},
    {slotMeta:{slotId:"draftContext"},selectedRefs:[]},
    {slotId:"draftContext",resolutionMode:"override",selectedRefs:[]},
    {...context,selectedRefs:[{artifactId:"artifact",representationRevisionId:"revision",semanticAssertionId:"assertion"}]},
  ])("retains wrapped, slot metadata and empty/plain supported context exclusion %#",async(values)=>{
    expect(await read([row("context",values),reviewA,reviewB])).toEqual([[3,reviewA],[7,reviewB]]);
  });
  it.each([
    {selectedRefs:[]},
    {slotId:"ordinary",selectedRefs:[]},
    {slotId:"ordinary",resolutionMode:"policy-specific",selectedRefs:[]},
    {slotId:"",resolutionMode:"accumulate",selectedRefs:[]},
    {slotId:"ordinary",resolutionMode:"accumulate",selectedRefs:"malformed"},
    {slotId:"ordinary",resolutionMode:"accumulate",selectedRefs:[],decision:"approve"},
    {slotId:"ordinary",resolutionMode:"accumulate",selectedRefs:[{artifactId:"only-one-field"}]},
    {userResponse:"malformed-json",decision:"approve"},
  ])("does not broadly discard legitimate or malformed non-context policy answers %#",async(values)=>{
    const ordinary=row("ordinary",values);
    expect(await read([ordinary,reviewB])).toEqual([[3,ordinary],[7,reviewB]]);
  });
  it("retains real gate-count, phantom-gate and step-index controls",async()=>{
    ports.prompts.mockResolvedValue([row("context",context),reviewA,reviewB]);
    expect(await buildSubmissionMapByStepIndex("run","agent",[{stepNumber:0,xRenderer:"review",firesRendererGate:false},{stepNumber:1,xRenderer:"review",gateCount:2}], [{index:4,stepNumber:1}])).toEqual([[4,reviewA],[4,reviewB]]);
  });
  it("does not read prompt records without a session",async()=>{
    ports.session.mockResolvedValue(null);expect(await read([reviewA])).toEqual([]);expect(ports.run).not.toHaveBeenCalled();expect(ports.prompts).not.toHaveBeenCalled();
  });
  it("keeps run-access denial fail closed before prompt reads",async()=>{
    ports.run.mockRejectedValue(new Error("access denied"));expect(await read([reviewA])).toEqual([]);expect(ports.prompts).not.toHaveBeenCalled();
    expect(ports.run).toHaveBeenCalledExactlyOnceWith("run",{actorType:"human",source:"ui",userId:"reader"});
  });
});
