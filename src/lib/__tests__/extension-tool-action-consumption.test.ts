import {describe,it,expect,vi} from "vitest";
import path from "node:path";
import {mcpRequestContextStorage} from "@cinatra-ai/mcp-server/request-context";
import {dispatchExtensionTool,type ExtensionToolPorts} from "../extension-tool-dispatch";
import {loadDeclaredToolModuleWithIdentity} from "../extension-tool-module-loader";
const root=path.join(process.cwd(),"src/lib/__tests__/fixtures/extension-tool-pack");
const ports={data:{select:vi.fn(),insertIfAbsent:vi.fn(),updateWhere:vi.fn()},artifacts:{list:vi.fn(),contentRead:vi.fn()},objects:{read:vi.fn(),save:vi.fn()},clock:{now:()=>new Date(0)}} as Omit<ExtensionToolPorts,"review">;
describe("actual declared module selection without authoritative loaded identity",()=>{
 it("preserves ordinary namespace dispatch compatibility",async()=>{
  let effects=0;const namespace={extensionTool:async()=>{effects++;return {ok:true};}};
  const input={packageName:"@fixture-scope/fixture-tool-pack",packageVersion:"1.2.3",orgId:"org",cinatra:{tools:[{name:"fixture_tool",module:"./cinatra/tools/fixture-tool.mjs"}]},request:{name:"fixture_tool",input:{}},ports,deps:{resolvePackageRoot:async()=>root,importModule:async()=>namespace}};
  expect(await dispatchExtensionTool(input)).toEqual({ok:true});expect(effects).toBe(1);
 });
 it("refuses a run before effects when an injected namespace has no actual loaded owner stamp",async()=>{
  let effects=0;const namespace={extensionTool:async()=>{effects++;return {};}};
  const input={packageName:"@fixture-scope/fixture-tool-pack",packageVersion:"1.2.3",orgId:"org",cinatra:{tools:[{name:"fixture_tool",module:"./cinatra/tools/fixture-tool.mjs"}]},request:{name:"fixture_tool",input:{}},ports,deps:{resolvePackageRoot:async()=>root,importModule:async()=>namespace}};
  await expect(mcpRequestContextStorage.run({runId:"run",orgId:"org"},()=>dispatchExtensionTool(input))).rejects.toThrow("executed module identity is unavailable");expect(effects).toBe(0);
 });
 it("returns the exact imported namespace, never synthesizes identity from caller metadata",async()=>{
  const namespace=Object.freeze({extensionTool:async()=>({})});const selected=await loadDeclaredToolModuleWithIdentity({packageName:"pack",packageVersion:"1",orgId:"org",toolName:"fixture_tool",modulePath:"./cinatra/tools/fixture-tool.mjs"},{resolvePackageRoot:async()=>root,importModule:async()=>namespace});
  expect(selected.namespace).toBe(namespace);expect(selected.identity).toBeUndefined();expect(Object.isFrozen(selected)).toBe(true);
 });
});
