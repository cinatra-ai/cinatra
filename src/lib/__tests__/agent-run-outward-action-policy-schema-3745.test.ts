import { describe, it, expect, vi } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
vi.mock("server-only",()=>({}));
import { agentRunOutwardActionPolicies, artifactReviewActionConsumptions } from "@cinatra-ai/agents/schema";
import { outwardActionPolicySchemaQueries } from "../artifacts/artifact-review-gate-schema";
import { outwardActionPolicyDdlSql, up, down } from "../../../migrations/core/core__0115_agent-run-outward-action-policy.mjs";
const normalize=(s:string)=>s.replaceAll('"tenant".','').replaceAll('"','').replace(/\s+/g," ").trim().replace(/;$/,"");
describe("migration/bootstrap/schema immutable source and burned gate parity",()=>{
 it("uses the exact same table/column contracts on an installed and fresh bootstrap road",()=>{
  const migration=outwardActionPolicyDdlSql.trim().split(";").filter((s:string)=>s.trim()).map(normalize);
  expect(outwardActionPolicySchemaQueries("tenant").map((q: {text:string})=>normalize(q.text))).toEqual(migration);
  for(const table of [agentRunOutwardActionPolicies,artifactReviewActionConsumptions]){
   const config=getTableConfig(table);const ddl=migration.find((s:string)=>s.includes(` ${config.name} `))!;expect(ddl).toBeTruthy();
   for(const col of config.columns){expect(ddl).toContain(`${col.name} `);if(col.primary)expect(ddl).toContain(`${col.name} text PRIMARY KEY`);}
  }
 });
 it("keeps one durable gate key without deletion cascade or parallel argument approval",()=>{
  const table=getTableConfig(artifactReviewActionConsumptions);
  expect(table.columns.filter(c=>c.primary).map(c=>c.name)).toEqual(["gate_id"]);expect(table.foreignKeys).toHaveLength(0);
  expect(outwardActionPolicyDdlSql).not.toMatch(/CASCADE|expires_at|approved_args|decider_owner/i);
 });
 it("does not fabricate legacy authorization on migration and never rolls burned receipts back",()=>{
  const sql:string[]=[];up({sql:(s:string)=>sql.push(s)});expect(sql).toEqual([outwardActionPolicyDdlSql]);expect(sql.join("")).not.toMatch(/INSERT|UPDATE/);
  expect(()=>down()).toThrow("outward_action_policy_downgrade_requires_preserved_consumptions");
 });
});
